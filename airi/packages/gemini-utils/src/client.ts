/**
 * GoogleGenAI 인스턴스 캐시 + 공통 유틸
 */

import { GoogleGenAI } from '@google/genai'

/** apiKey별 GoogleGenAI 인스턴스 캐시 — 재사용으로 오버헤드 최소화 */
const _genAICache = new Map<string, GoogleGenAI>()

export function getGenAI(apiKey: string): GoogleGenAI {
    if (!_genAICache.has(apiKey))
        _genAICache.set(apiKey, new GoogleGenAI({ apiKey }))
    return _genAICache.get(apiKey)!
}

/** URL이 Gemini API 엔드포인트인지 판별 */
export function isGeminiUrl(url: string): boolean {
    return url.includes('generativelanguage.googleapis.com')
}
