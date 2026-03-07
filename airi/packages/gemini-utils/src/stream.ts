/**
 * Gemini 스트리밍 completion
 * stage-ui의 llm.ts에서 사용 (제네릭 타입, xsai 비의존)
 * 로깅(요청/응답/토큰)을 내부에서 처리
 */

import { getGenAI } from './client'

// Simple fast string hashing for prompt deduplication & cache keys
function cyrb53(str: string, seed = 0) {
    let h1 = 0xDEADBEEF ^ seed
    let h2 = 0x41C6CE57 ^ seed
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i)
        h1 = Math.imul(h1 ^ ch, 2654435761)
        h2 = Math.imul(h2 ^ ch, 1597334677)
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

// Global cache map to store Google GenAI Cache entities by our computed prompt hash
export interface PromptCacheEntry {
    status: 'active' | 'failed' | 'too_short'
    name?: string
    expireTimeMs?: number
}
const _promptCacheMap = new Map<string, PromptCacheEntry>()

// Set of seen hashes just for logging deduplication, even if API cache fails
const _seenPromptHashes = new Set<string>()

let _reqCounter = 0

export interface GeminiStreamOptions {
    apiKey: string
    model: string
    promptNode?: { role?: string, content: unknown }
    /** 로깅 및 캐시용으로 해시할 원본 시스템 프롬프트 (동적 컨텍스트가 섞이기 전의 순수 페르소나 설정) */
    rawSystemPrompt?: string
    messages: Array<{ role: string, content: unknown }>
    tools?: Array<{
        name: string
        description?: string
        parameters?: unknown
    }>
    onEvent: (event: GeminiStreamChunk) => Promise<void>
    /** 로그 라인 콜백 — console.debug는 항상 출력, 이 콜백으로 추가 처리 가능 */
    onLog?: (line: string) => void
}

export type GeminiStreamChunk
    = | { type: 'text-delta', text: string }
    | { type: 'tool-call', toolCallId: string, toolName: string, args: Record<string, unknown> }
    | { type: 'finish', finishReason: string, usage: any | null }
    | { type: 'error', error: unknown }

/**
 * @google/genai SDK 스트리밍 호출
 * - 요청/응답/토큰 로깅을 내부에서 처리
 * - GeminiStreamChunk 이벤트를 onEvent 콜백으로 전달
 */
export async function streamGemini(opts: GeminiStreamOptions): Promise<void> {
    const { apiKey, model, promptNode, rawSystemPrompt, messages, tools, onEvent, onLog } = opts
    const ai = getGenAI(apiKey)
    const geminiModel = model.replace(/^models\//, '')

    const _log = (line: string) => {
        // eslint-disable-next-line no-console
        console.debug(line)
        onLog?.(line)
    }

    // --- PromptNode Text Formatting & Hashing ---
    let promptNodeText = ''
    let promptHashStr = ''
    let isPromptCachedInLogs = false

    if (promptNode) {
        promptNodeText = typeof promptNode.content === 'string'
            ? promptNode.content
            : Array.isArray(promptNode.content)
                ? (promptNode.content as any[]).map((c: any) => c.text ?? JSON.stringify(c)).join('')
                : JSON.stringify(promptNode.content)
    }

    // 동적 텍스트(HotContext)가 섞이면 해시가 매번 바뀌어 로깅 도배됨. 따라서 원본 시스템 프롬프트를 해시 키로 씀
    const textToHash = rawSystemPrompt || promptNodeText

    if (textToHash.trim()) {
        promptHashStr = cyrb53(textToHash).toString(16)

        if (_seenPromptHashes.has(promptHashStr)) {
            isPromptCachedInLogs = true
        } else {
            _seenPromptHashes.add(promptHashStr)
        }
    }

    // ── 요청 로그 ──────────────────────────────────────────────
    const ts0 = new Date().toISOString().slice(11, 23)
    _reqCounter++
    const reqId = _reqCounter.toString().padStart(4, '0')
    const reqTag = `[#${reqId}] `

    let promptLog = ''
    if (promptNodeText) {
        if (isPromptCachedInLogs) {
            promptLog = `  [system (PromptNode)] [PROMPT_HASH: ${promptHashStr}] (Original content omitted)\n`
        } else {
            promptLog = `  [system (PromptNode)] [NEW_PROMPT_HASH: ${promptHashStr}]\n${promptNodeText}\n`
        }
    }

    const extractText = (content: unknown): string => {
        if (typeof content === 'string') {
            return content
        }
        if (Array.isArray(content)) {
            return (content as any[]).map((c: any) => c.text ?? JSON.stringify(c)).join(' ')
        }
        return JSON.stringify(content)
    }

    const messagesLog = messages.map(m => {
        const text = extractText(m.content)
        return `  [${m.role}] ${text}`
    }).join('\n')

    _log(`${reqTag}[GEMINI→] ${ts0} ${geminiModel} | ${messages.length} msgs\n${promptLog}${messagesLog}`)
    const startedAt = Date.now()
    let fullText = ''
    // ──────────────────────────────────────────────────────────

    // system 메시지 
    const systemParts: Array<{ text: string }> = []

    // 만약 rawSystemPrompt가 따로 넘어왔다면, 그것만을 캐싱 대상(순수 페르소나)으로 삼는다.
    // 기존의 promptNodeText(Context가 결합된 텍스트)에서 rawSystemPrompt를 뺀 나머지(순수 Context)는 분리한다.
    const pureSystemPrompt = rawSystemPrompt || promptNodeText
    let extractedDynamicContext = ''

    if (rawSystemPrompt && promptNodeText !== rawSystemPrompt) {
        extractedDynamicContext = promptNodeText.replace(rawSystemPrompt, '').trim()
    }

    let cacheEntry = promptHashStr ? _promptCacheMap.get(promptHashStr) : undefined
    let cachedContentName = cacheEntry?.status === 'active' ? cacheEntry.name : undefined

    if (pureSystemPrompt) {
        // 모델 종류에 따라 캐싱 최소 토큰 조건이 다름: Flash 계열은 1024 토큰 (약 ~3000자), Pro 계열은 4096 토큰 (약 ~12000자) 이상
        let minCacheLength = 30000
        if (geminiModel.includes('flash') || geminiModel.includes('flash-lite')) {
            minCacheLength = 2000
        } else if (geminiModel.includes('pro')) {
            minCacheLength = 8000
        }

        if (!cacheEntry) {
            if (pureSystemPrompt.length >= minCacheLength) {
                _log(`  [CACHE] Attempting to create Native API Content Cache... (Length: ${pureSystemPrompt.length} chars, requires >= ${minCacheLength})`)
                try {
                    const ttlSeconds = 600
                    const cacheResult = await ai.caches.create({
                        model: geminiModel,
                        contents: [
                            { role: 'user', parts: [{ text: "Initializing context cache" }] } // Minimal user fallback if needed
                        ],
                        systemInstruction: { parts: [{ text: pureSystemPrompt }] },
                        ttl: { seconds: ttlSeconds }, // 10 minutes TTL
                    } as any)

                    if (cacheResult && cacheResult.name) {
                        cachedContentName = cacheResult.name
                        _promptCacheMap.set(promptHashStr!, {
                            status: 'active',
                            name: cachedContentName,
                            expireTimeMs: Date.now() + (ttlSeconds * 1000)
                        })
                        _log(`  [CACHE] Automatically created API CachedContent: ${cachedContentName} (Expires in ${ttlSeconds}s)`)
                    }
                } catch (err: any) {
                    _promptCacheMap.set(promptHashStr!, { status: 'failed' })
                    _log(`  [CACHE] Native API caching failed. Marked as failed. Falling back to inline systemInstruction. Reason: ${err?.message}`)
                }
            } else {
                _promptCacheMap.set(promptHashStr!, { status: 'too_short' })
                _log(`  [CACHE] Skipped Native API Caching: System prompt length (${pureSystemPrompt.length} chars) is too short. (Model '${geminiModel}' requires ~${minCacheLength}+ chars)`)
            }
        } 
        else if (cacheEntry.status === 'active' && cacheEntry.name) {
            // TTL 1분 미만 남았을 시 갱신 처리
            const timeRemainingMs = (cacheEntry.expireTimeMs ?? 0) - Date.now()
            if (timeRemainingMs < 60000) {
                _log(`  [CACHE] Reusing existing API CachedContent: ${cacheEntry.name} (TTL remaining: ${Math.round(timeRemainingMs/1000)}s - Updating TTL...)`)
                try {
                    const ttlSeconds = 600
                    await ai.caches.update({
                        name: cacheEntry.name,
                        ttl: { seconds: ttlSeconds }
                    } as any)
                    cacheEntry.expireTimeMs = Date.now() + (ttlSeconds * 1000)
                    _log(`  [CACHE] Successfully extended TTL for ${cacheEntry.name} by ${ttlSeconds}s`)
                } catch (err: any) {
                    _log(`  [CACHE] Failed to extend TTL for ${cacheEntry.name}, it may expire soon. Reason: ${err?.message}`)
                }
            } else {
                _log(`  [CACHE] Reusing existing API CachedContent: ${cacheEntry.name} (TTL remaining: ${Math.round(timeRemainingMs/1000)}s)`)
            }
        }
        else if (cacheEntry.status === 'failed') {
            _log(`  [CACHE] Native caching previously failed for this prompt. Skipping re-attempt.`)
        }
        else if (cacheEntry.status === 'too_short') {
            _log(`  [CACHE] System prompt previously marked too short (${pureSystemPrompt.length} chars). Skipping re-attempt.`)
        }
    }

    if (pureSystemPrompt && !cachedContentName) {
        systemParts.push({ text: pureSystemPrompt })
    }

    const contents = messages
        .filter(m => m.role !== 'system')
        .map((m, idx) => {
            let textValue = typeof m.content === 'string'
                ? m.content
                : Array.isArray(m.content)
                    ? (m.content as any[]).map((c: any) => c.text ?? JSON.stringify(c)).join('')
                    : JSON.stringify(m.content)

            // 만약 분리해 낸 동적 컨텍스트가 존재한다면, 가장 첫 번째 유저 메시지 텍스트 맨 앞에 삽입하여 시스템 페르소나 캐싱과 역할을 우회 분리
            if (idx === 0 && extractedDynamicContext) {
                textValue = extractedDynamicContext + '\n\n' + textValue
            }

            return {
                role: (m.role === 'assistant' ? 'model' : 'user') as 'user' | 'model',
                parts: [{
                    text: textValue,
                }],
            }
        })

    const functionDeclarations = tools && tools.length > 0
        ? tools.map(t => ({
            name: t.name,
            description: t.description ?? '',
            parameters: t.parameters,
        }))
        : undefined

    const response = await ai.models.generateContentStream({
        model: geminiModel,
        contents: contents as any,
        config: {
            ...(systemParts.length > 0 ? { systemInstruction: { parts: systemParts } } : {}),
            ...(functionDeclarations ? { tools: [{ functionDeclarations }] } : {}),
        },
        ...(cachedContentName ? { cachedContent: cachedContentName } : {}),
    } as any)

    let usageMetadata: any = null

    for await (const chunk of response) {
        // 텍스트 델타
        if (chunk.text) {
            fullText += chunk.text
            await onEvent({ type: 'text-delta', text: chunk.text })
        }

        // 함수 호출 (tool-call)
        const funcCalls = typeof (chunk as any).functionCalls === 'function'
            ? (chunk as any).functionCalls() as Array<{ id?: string, name?: string, args?: Record<string, unknown> }>
            : null
        if (funcCalls && funcCalls.length > 0) {
            for (const call of funcCalls) {
                await onEvent({
                    type: 'tool-call',
                    toolCallId: call.id ?? `call-${call.name}-${Date.now()}`,
                    toolName: call.name ?? '',
                    args: call.args ?? {},
                })
            }
        }

        // usageMetadata 누적 (보통 마지막 청크에 포함)
        if ((chunk as any).usageMetadata) {
            usageMetadata = (chunk as any).usageMetadata
        }
    }

    // ── 응답 로그 ──────────────────────────────────────────────
    const ms = Date.now() - startedAt
    const ts1 = new Date().toISOString().slice(11, 23)
    const tokenInfo = usageMetadata
        ? `tokens:${JSON.stringify(usageMetadata)}`
        : `~${Math.round(fullText.length / 2)}tok est.`
    _log(`${reqTag}[GEMINI←] ${ts1} ${ms}ms | ${tokenInfo}\n  [assistant] ${fullText}`)
    // ──────────────────────────────────────────────────────────

    await onEvent({ type: 'finish', finishReason: 'stop', usage: usageMetadata })
}
