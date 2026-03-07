// P5: Summarizer
// Python `_summarize_and_push_to_hot_pool()` → TypeScript 포팅
// 슬라이딩 윈도우 초과 시 sLLM으로 요약 → Hot Pool에 context_summary 노드 추가

import type { BouncerOptions, SummarizerOptions, ContextUpdateDecision } from '../types'
import type { LLMLoggerInstance } from '../logger'

import { callGemini, isGeminiUrl } from '@proj-airi/gemini-utils'

import { getGlobalLLMLogger } from '../logger'

interface ChatMessage {
    role: 'user' | 'assistant' | 'system'
    content: string
}

export function createSummarizer(
    bouncerOptions: BouncerOptions,
    summarizerOptions?: SummarizerOptions & { logger?: LLMLoggerInstance },
    progressOptions?: BouncerOptions,  // Progress Summarizer 전용 LLM (생략 시 bouncerOptions 공유)
) {
    const { baseUrl, apiKey, model = 'local-model', timeoutMs = 10000 } = bouncerOptions
    // Progress Summarizer는 별도 엔드포인트 가능, 없으면 main summarizer 공유
    const progressBaseUrl = progressOptions?.baseUrl ?? baseUrl
    const progressModel = progressOptions?.model ?? model
    const progressApiKey = progressOptions?.apiKey ?? apiKey
    const progressTimeoutMs = progressOptions?.timeoutMs ?? timeoutMs
    const logger = summarizerOptions?.logger ?? getGlobalLLMLogger()
    const windowSize = summarizerOptions?.windowSize ?? 20
    const progressAuthHeaders: Record<string, string> = progressApiKey
        ? { 'Authorization': `Bearer ${progressApiKey}` }
        : {}

    // 슬라이딩 윈도우 메시지 버퍼
    const messageBuffer: ChatMessage[] = []


    /**
     * 메시지 추가. 슬라이딩 윈도우 크기 제한만 유지하고,
     * 더 이상 chunkSize 단위로 pendingChunks를 만들지 않습니다 (턴 기반 decision으로 대체).
     */
    function addMessage(role: 'user' | 'assistant', content: string): void {
        if (!content.trim())
            return

        messageBuffer.push({ role, content })

        if (messageBuffer.length > windowSize) {
            messageBuffer.shift()
        }
    }


    function getMessageCount(): number {
        return messageBuffer.length
    }

    /**
     * AI 응답 완료 또는 인터럽트 시점에 현재 Hot Context와 대화 내역을 보고
     * 업데이트/생성/무시 여부를 결정합니다.
     */
    async function decideContextUpdate(
        aiResponse: string,
        isInterrupted: boolean,
        snapshotNodes: any[],
        snapshotChatLog: string,
    ): Promise<ContextUpdateDecision | null> {
        if (!aiResponse.trim()) return null

        const nodesInfo = snapshotNodes.map((n) => `[Node ID: ${n.id}]
Topic: ${n.topic}
Speaker: ${n.speaker}
Weight: ${n.weight}
Context: ${n.contextSummary}
Progress: ${n.progressSummary.join(' -> ')}
`).join('\n')

        const systemPrompt = `IMPORTANT: Respond ONLY in raw JSON format. No markdown, no backticks, no markdown blocks. Do not use Chinese or any other language except English and Korean.
You are a context manager for a VTuber stream. Your job is to decide whether to update an existing ongoing topic context, create a new topic context, or skip (if the recent chat is just meaningless banter).
Output ONLY a JSON object exactly matching this schema:
{
  "action": "skip" | "update" | "create",
  "targetNodeId": "string (required if action=update)",
  "topic": "string (main topic keyword, Korean ok)",
  "speaker": "string (dominant viewer name or '시청자')",
  "contextSummary": "string (Korean, 1-2 lines summarizing WHAT the conversation is about)",
  "progressSummary": "string (Korean, 1 line on WHERE the conversation currently is and expected next steps)",
  "mood": "string (2-4 Korean chars)",
  "weight": 50.0 // (0-100 scale, optional. Omit to maintain previous weight)
}

Rules:
1. If the recent chat is a natural continuation of an existing Node ID, choose "update" and provide the updated context/progress.
2. If the topic has completely changed, choose "create".
3. If the chat is too short, lacks substance, or is just casual greetings/reactions, choose "skip".
4. "progressSummary" is required for "update" or "create".`

        const userPrompt = `Current Active Context Nodes:
${nodesInfo || 'None'}

Recent Chat Buffer:
${snapshotChatLog}

Latest AI Response (Did finish? ${isInterrupted ? 'No, interrupted' : 'Yes'}):
${aiResponse}`

        const reqId = logger.request('PROGRESS', userPrompt, progressModel, aiResponse, systemPrompt)

        try {
            let raw: string

            // Gemini native SDK 경로
            if (isGeminiUrl(progressBaseUrl) && progressApiKey) {
                raw = await callGemini({
                    apiKey: progressApiKey,
                    model: progressModel,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt },
                    ],
                    temperature: 0.2,
                    maxOutputTokens: 256,
                    timeoutMs: progressTimeoutMs,
                })
            }
            else {
                // OpenAI compat 경로
                const url = `${progressBaseUrl.replace(/\/$/, '')}/v1/chat/completions`
                const body = JSON.stringify({
                    model: progressModel,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt },
                    ],
                    temperature: 0.2,
                    max_tokens: 256,
                    stream: false,
                })
                const controller = new AbortController()
                const timer = setTimeout(() => controller.abort(), progressTimeoutMs)
                try {
                    const res = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...progressAuthHeaders },
                        body,
                        signal: controller.signal,
                    })
                    raw = ((await res.json() as any)?.choices?.[0]?.message?.content ?? '').trim()
                }
                finally {
                    clearTimeout(timer)
                }
            }

            logger.response('PROGRESS', raw, reqId, progressModel)
            
            if (raw.startsWith('```json'))
                raw = raw.slice(7)
            if (raw.endsWith('```'))
                raw = raw.slice(0, -3)
            raw = raw.trim()

            const parsed = JSON.parse(raw)
            return {
                action: parsed.action ?? 'skip',
                targetNodeId: parsed.targetNodeId,
                topic: parsed.topic ?? '',
                speaker: parsed.speaker ?? '시청자',
                contextSummary: parsed.contextSummary ?? '',
                progressSummary: parsed.progressSummary ?? '',
                mood: parsed.mood ?? '',
                weight: parsed.weight !== undefined ? Number(parsed.weight) : undefined,
            }
        }
        catch (err) {
            console.warn('[ProgressSummarizer] decideContextUpdate call failed:', err)
            return null
        }
    }

    return {
        addMessage,
        decideContextUpdate,
        getMessageCount,
    }
}

export type Summarizer = ReturnType<typeof createSummarizer>
