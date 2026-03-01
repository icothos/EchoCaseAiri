/**
 * Gemini 스트리밍 completion
 * stage-ui의 llm.ts에서 사용 (제네릭 타입, xsai 비의존)
 * 로깅(요청/응답/토큰)을 내부에서 처리
 */

import { getGenAI } from './client'

export interface GeminiStreamOptions {
    apiKey: string
    model: string
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
    const { apiKey, model, messages, tools, onEvent, onLog } = opts
    const ai = getGenAI(apiKey)
    const geminiModel = model.replace(/^models\//, '')

    const _log = (line: string) => {
        // eslint-disable-next-line no-console
        console.debug(line)
        onLog?.(line)
    }

    // ── 요청 로그 ──────────────────────────────────────────────
    const ts0 = new Date().toISOString().slice(11, 23)
    const msgLines = messages.map((m) => {
        const text = typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
                ? (m.content as any[]).map((c: any) => c.text ?? JSON.stringify(c)).join(' ')
                : JSON.stringify(m.content)
        return `  [${m.role}] ${text.slice(0, 200)}${text.length > 200 ? '...(truncated)' : ''}`
    }).join('\n')
    _log(`[GEMINI→] ${ts0} ${geminiModel} | ${messages.length} msgs\n${msgLines}`)
    const startedAt = Date.now()
    let fullText = ''
    // ──────────────────────────────────────────────────────────

    // system 메시지 분리 → systemInstruction
    const systemParts = messages
        .filter(m => m.role === 'system')
        .map(m => ({ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }))

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
