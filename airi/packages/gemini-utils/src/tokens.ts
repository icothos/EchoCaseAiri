/**
 * Gemini 토큰 카운팅 (REST API)
 * @google/genai SDK가 아직 countTokens를 지원하지 않는 경우 REST fallback
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta'

/**
 * Gemini native countTokens REST API 호출
 * @returns { promptTokenCount, totalTokenCount } or null
 */
export async function countGeminiTokens(
    apiKey: string,
    model: string,
    messages: Array<{ role: string, content: unknown }>,
    responseText?: string,
): Promise<{ promptTokenCount: number, totalTokenCount: number } | null> {
    const geminiModel = model.replace(/^models\//, '')
    const url = `${GEMINI_BASE}/models/${geminiModel}:countTokens?key=${apiKey}`

    const contents = [
        ...messages.map(m => ({
            role: m.role === 'assistant' ? 'model' : m.role,
            parts: [{
                text: typeof m.content === 'string'
                    ? m.content
                    : Array.isArray(m.content)
                        ? (m.content as any[]).map((c: any) => c.text ?? JSON.stringify(c)).join(' ')
                        : JSON.stringify(m.content),
            }],
        })),
        ...(responseText ? [{ role: 'model', parts: [{ text: responseText }] }] : []),
    ]

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents }),
        })
        if (!res.ok)
            return null
        return await res.json() as any
    }
    catch {
        return null
    }
}
