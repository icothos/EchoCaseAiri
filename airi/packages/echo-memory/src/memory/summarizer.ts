// P5: Summarizer
// Python `_summarize_and_push_to_hot_pool()` → TypeScript 포팅
// 슬라이딩 윈도우 초과 시 sLLM으로 요약 → Hot Pool에 context_summary 노드 추가

import type { HotContextPool } from '../memory/hot-pool'
import type { BouncerOptions, SummarizerOptions, SummarizerResult } from '../types'
import type { LLMLoggerInstance } from '../logger'

import { callGemini, isGeminiUrl } from '@proj-airi/gemini-utils'

import { getGlobalLLMLogger } from '../logger'

const MIN_SUMMARIZE_CHARS = 30

const SUMMARIZER_SYSTEM_PROMPT = `IMPORTANT: You MUST respond only in English or Korean. Do NOT use Chinese or any other language.
You are a context-aware memory summarizer for a VTuber named Echo.
Read the following recent chat log and extract structured information.
Output ONLY a raw JSON string (no markdown, no backticks) with this structure:
{"topic": "main topic keyword", "speaker": "main viewer name or '시청자'", "context_summary": "어떤 맥락인지 1~2문장 (Korean)", "progress_summary": "어디까지 이야기했는지, 다음 예상 흐름 1문장 (Korean)", "mood": "분위기 2-4 Korean characters e.g. 유쾌함/조용함/열정적", "weight": 5.0}

Rules:
- 'topic': short keyword describing the subject (Korean ok)
- 'speaker': the dominant viewer name, or '시청자' if mixed/unknown
- 'context_summary': concise Korean summary of WHAT the conversation was about
- 'progress_summary': HOW FAR the conversation went and next expected flow
- 'mood': atmosphere in 2-4 Korean chars
- 'weight': importance 1.0~10.0 (1=trivial chatter, 10=critical lore)`

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
    const progressTimeoutMs = progressOptions?.timeoutMs ?? 8000
    const logger = summarizerOptions?.logger ?? getGlobalLLMLogger()
    const windowSize = summarizerOptions?.windowSize ?? 20
    const chunkSize = summarizerOptions?.chunkSize ?? 10
    const authHeaders: Record<string, string> = apiKey
        ? { 'Authorization': `Bearer ${apiKey}` }
        : {}
    const progressAuthHeaders: Record<string, string> = progressApiKey
        ? { 'Authorization': `Bearer ${progressApiKey}` }
        : {}

    // 슬라이딩 윈도우 메시지 버퍼
    const messageBuffer: ChatMessage[] = []
    // 요약 대기 큐 (비동기 처리)
    const pendingChunks: ChatMessage[][] = []

    async function callSummarizer(chatLog: string): Promise<SummarizerResult | null> {
        const reqId = logger.request('CONTEXT', chatLog, model, chatLog.slice(0, 60), SUMMARIZER_SYSTEM_PROMPT)

        try {
            let raw: string

            // Gemini native SDK 경로
            if (isGeminiUrl(baseUrl) && apiKey) {
                raw = await callGemini({
                    apiKey,
                    model,
                    messages: [
                        { role: 'system', content: SUMMARIZER_SYSTEM_PROMPT },
                        { role: 'user', content: `Chat Log:\n${chatLog}` },
                    ],
                    temperature: 0.3,
                    maxOutputTokens: 256,
                    timeoutMs,
                })
            }
            else {
                // OpenAI compat 경로
                const url = `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`
                const body = JSON.stringify({
                    model,
                    messages: [
                        { role: 'system', content: SUMMARIZER_SYSTEM_PROMPT },
                        { role: 'user', content: `Chat Log:\n${chatLog}` },
                    ],
                    temperature: 0.3,
                    max_tokens: 256,
                    stream: false,
                })
                const controller = new AbortController()
                const timer = setTimeout(() => controller.abort(), timeoutMs)
                try {
                    const res = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...authHeaders },
                        body,
                        signal: controller.signal,
                    })
                    raw = ((await res.json() as any)?.choices?.[0]?.message?.content ?? '').trim()
                }
                finally {
                    clearTimeout(timer)
                }
            }

            logger.response('CONTEXT', raw, reqId, model)
            if (raw.startsWith('```json'))
                raw = raw.slice(7)
            if (raw.endsWith('```'))
                raw = raw.slice(0, -3)
            raw = raw.trim()

            const parsed = JSON.parse(raw)
            return {
                topic: parsed.topic ?? '',
                speaker: parsed.speaker ?? '시청자',
                contextSummary: parsed.context_summary ?? '',
                progressSummary: parsed.progress_summary ?? '',
                mood: parsed.mood ?? '',
                weight: Number(parsed.weight ?? 5.0),
            }
        }
        catch (err) {
            console.warn('[Summarizer] call failed:', err)
            return null
        }
    }

    /** 메시지 추가. 윈도우 초과 시 오래된 청크를 pendingChunks에 쌓음 */
    function addMessage(role: 'user' | 'assistant', content: string): void {
        if (!content.trim())
            return

        messageBuffer.push({ role, content })

        if (messageBuffer.length > windowSize) {
            pendingChunks.push(messageBuffer.splice(0, chunkSize))
        }
    }

    /**
     * 대기 중인 청크를 sLLM으로 요약해 Hot Pool에 pushchin.
     * onChatTurnComplete 훅에서 호출 (비동기, 블로킹 없음).
     */
    async function maybeRunSummarizer(pool: HotContextPool): Promise<void> {
        if (pendingChunks.length === 0)
            return

        // 병렬 처리 대신 직렬 (sLLM 부하 방지)
        while (pendingChunks.length > 0) {
            const chunk = pendingChunks.shift()!
            const chatLog = chunk
                .filter(m => m.role !== 'system')
                .map(m => `${m.role}: ${m.content}`)
                .join('\n')
                .trim()

            if (chatLog.length < MIN_SUMMARIZE_CHARS)
                continue

            const result = await callSummarizer(chatLog)
            if (!result?.contextSummary)
                continue

            const header = result.topic
                ? `[${result.topic}] ${result.speaker}`
                : result.speaker
            const lines = [
                result.mood ? `${header} | 분위기: ${result.mood}` : header,
                `맥락: ${result.contextSummary}`,
            ]
            if (result.progressSummary)
                lines.push(`진행: ${result.progressSummary}`)

            pool.addNode({
                content: lines.join('\n'),
                weight: result.weight,
                ttl: 300, // 요약 노드는 5분 TTL
                nodeType: 'context_summary',
                topic: result.topic,
                speaker: result.speaker,
                contextSummary: result.contextSummary,
                progressSummary: result.progressSummary,
                mood: result.mood,
            })
        }
    }

    function getMessageCount(): number {
        return messageBuffer.length
    }

    /**
     * AI 응답 텍스트를 보고 "어디까지 진행됐고 다음 흐름이 뭔지" 1문장 생성.
     * EchoCast의 inject_live_status() 패턴 참고.
     *
     * @param aiResponse  AI가 방금 출력한 전체 텍스트
     * @param contextSummary  현재 context_summary 내용 (선택, 있으면 더 정확함)
     * @returns  progress_summary 1문장 (한국어), 실패 시 null
     */
    async function generateProgressSummary(
        aiResponse: string,
        contextSummary?: string,
    ): Promise<string | null> {
        if (!aiResponse.trim())
            return null

        const systemPrompt = `IMPORTANT: Respond ONLY in Korean. One sentence only. No explanation.
You are tracking the conversation progress of a VTuber livestream.
Read the AI streamer's latest response and summarize:
- What topic was addressed
- How far the conversation has progressed
- What is likely to come next
Output: a single Korean sentence (20-40 chars). Example output: "게임 공략 방법을 설명했으며, 다음은 보스전 전략으로 이어질 듯함."`

        const userPrompt = contextSummary
            ? `맥락: ${contextSummary}\n\nAI 응답:\n${aiResponse.slice(0, 600)}`
            : `AI 응답:\n${aiResponse.slice(0, 600)}`

        const reqId = logger.request('PROGRESS', userPrompt, progressModel, aiResponse.slice(0, 60), systemPrompt)

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
                    maxOutputTokens: 80,
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
                    max_tokens: 80,
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
            return raw || null
        }
        catch (err) {
            console.warn('[ProgressSummarizer] call failed:', err)
            return null
        }
    }

    return {
        addMessage,
        maybeRunSummarizer,
        generateProgressSummary,
        getMessageCount,
    }
}

export type Summarizer = ReturnType<typeof createSummarizer>
