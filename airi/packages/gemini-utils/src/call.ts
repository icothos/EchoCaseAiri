/**
 * 단건 Gemini completion (스트리밍 없음)
 * Bouncer / Summarizer 등 짧은 응답이 필요한 경우 사용
 */

import { getGenAI } from './client'

export interface GeminiMessage {
    role: 'user' | 'model' | 'system'
    content: string
}

export interface GeminiCallOptions {
    apiKey: string
    model: string
    messages: GeminiMessage[]
    temperature?: number
    maxOutputTokens?: number
    /** 응답 대기 타임아웃 ms. AbortSignal로 구현 (기본: 무제한) */
    timeoutMs?: number
}

/**
 * Gemini generateContent 단건 호출 → 응답 텍스트 반환
 */
export async function callGemini(opts: GeminiCallOptions): Promise<string> {
    const { apiKey, model, messages, temperature = 0, maxOutputTokens, timeoutMs } = opts
    const ai = getGenAI(apiKey)
    const geminiModel = model.replace(/^models\//, '')

    // system 메시지 분리
    const systemParts = messages
        .filter(m => m.role === 'system')
        .map(m => ({ text: m.content }))

    const contents = messages
        .filter(m => m.role !== 'system')
        .map(m => ({
            role: m.role === 'model' ? 'model' : 'user',
            parts: [{ text: m.content }],
        }))

    const abortController = timeoutMs ? new AbortController() : null
    const timer = timeoutMs
        ? setTimeout(() => abortController!.abort(), timeoutMs)
        : null

    try {
        const response = await ai.models.generateContent({
            model: geminiModel,
            contents,
            config: {
                temperature,
                ...(maxOutputTokens != null ? { maxOutputTokens } : {}),
                ...(systemParts.length > 0 ? { systemInstruction: { parts: systemParts } } : {}),
            },
        })

        return response.text ?? ''
    }
    finally {
        if (timer != null)
            clearTimeout(timer)
    }
}
