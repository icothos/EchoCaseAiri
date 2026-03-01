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

// Global cache map to store Google GenAI Cache names by our computed prompt hash
const _promptCacheMap = new Map<string, string>()

// Set of seen hashes just for logging deduplication, even if API cache fails
const _seenPromptHashes = new Set<string>()

export interface GeminiStreamOptions {
    apiKey: string
    model: string
    promptNode?: { role?: string, content: unknown }
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
    const { apiKey, model, promptNode, messages, tools, onEvent, onLog } = opts
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

        if (promptNodeText.trim()) {
            promptHashStr = cyrb53(promptNodeText).toString(16)

            if (_seenPromptHashes.has(promptHashStr)) {
                isPromptCachedInLogs = true
            } else {
                _seenPromptHashes.add(promptHashStr)
            }
        }
    }

    // ── 요청 로그 ──────────────────────────────────────────────
    const ts0 = new Date().toISOString().slice(11, 23)
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

    _log(`[GEMINI→] ${ts0} ${geminiModel} | ${messages.length} msgs\n${promptLog}${messagesLog}`)
    const startedAt = Date.now()
    let fullText = ''
    // ──────────────────────────────────────────────────────────

    // system 메시지 
    const systemParts: Array<{ text: string }> = []

    // -- API Prompt Caching (gemini models natively support this for system contents >= 32768 tokens, but we use length as rough proxy or try/catch) --
    let cachedContentName = promptHashStr ? _promptCacheMap.get(promptHashStr) : undefined

    if (promptNodeText && !cachedContentName) {
        // Only attempt to cache if the text seems large enough (Google requires >= 32,768 tokens usually, roughly ~100k chars for Korean/English mix)
        // If it's too small, the API returns an error, so we fallback.
        if (promptNodeText.length >= 30000) {
            try {
                const cacheResult = await ai.caches.create({
                    model: geminiModel,
                    contents: [
                        { role: 'user', parts: [{ text: "Initializing context cache" }] } // Minimal user fallback if needed
                    ],
                    systemInstruction: { parts: [{ text: promptNodeText }] },
                    ttl: { seconds: 600 }, // 10 minutes TTL
                } as any)

                if (cacheResult && cacheResult.name) {
                    cachedContentName = cacheResult.name
                    _promptCacheMap.set(promptHashStr, cachedContentName)
                    _log(`  [CACHE] Automatically created API CachedContent: ${cachedContentName}`)
                }
            } catch (err: any) {
                // Ignore API cache creation errors (e.g. content too short, quota exceeded) and fallback
                _log(`  [CACHE] Native API caching failed/skipped. Falling back to inline systemInstruction. Reason: ${err?.message}`)
            }
        }
    }

    if (promptNodeText && !cachedContentName) {
        systemParts.push({ text: promptNodeText })
    }

    const contents = messages
        .filter(m => m.role !== 'system')
        .map(m => ({
            role: (m.role === 'assistant' ? 'model' : 'user') as 'user' | 'model',
            parts: [{
                text: typeof m.content === 'string'
                    ? m.content
                    : Array.isArray(m.content)
                        ? (m.content as any[]).map((c: any) => c.text ?? JSON.stringify(c)).join('')
                        : JSON.stringify(m.content),
            }],
        }))

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
    _log(`[GEMINI←] ${ts1} ${ms}ms | ${tokenInfo}\n  [assistant] ${fullText.slice(0, 800)}${fullText.length > 800 ? '...' : ''}`)
    // ──────────────────────────────────────────────────────────

    await onEvent({ type: 'finish', finishReason: 'stop', usage: usageMetadata })
}
