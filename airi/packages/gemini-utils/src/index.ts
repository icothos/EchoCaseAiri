/**
 * @proj-airi/gemini-utils
 * 공유 @google/genai 유틸리티
 * - GoogleGenAI 인스턴스 캐싱
 * - 단건 completion (Bouncer/Summarizer용)
 * - 스트리밍 completion (stage-ui llm.ts용)
 * - 토큰 카운팅
 */

export { callGemini } from './call'
export type { GeminiCallOptions, GeminiMessage } from './call'

export { streamGemini } from './stream'
export type { GeminiStreamChunk, GeminiStreamOptions } from './stream'

export { countGeminiTokens } from './tokens'

export { getGenAI, isGeminiUrl } from './client'
