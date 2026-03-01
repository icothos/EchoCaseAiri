// echo-memory 패키지 외부 진입점
// Tri-Core Memory System + sLLM Bouncer for Airi

// 핵심 타입
export type * from './types'

// LLM 정밀 로거 (P0 고도화)
export {
    createLLMLogger,
    getGlobalLLMLogger,
    setGlobalLLMLogger,
} from './logger'
export type { LLMLogEntry, LLMLoggerInstance, LLMRole } from './logger'

// Hot Context Pool (P1)
export { createHotContextPool } from './memory/hot-pool'
export type { HotContextPool } from './memory/hot-pool'

// Summarizer (P5)
export { createSummarizer } from './memory/summarizer'
export type { Summarizer } from './memory/summarizer'

// Fast-path Filter (P2)
export { shouldDropFast, stripChzzkPrefix } from './bouncer/fast-path'

// sLLM Bouncer (P3)
export { createBouncer } from './bouncer/bouncer'
export type { Bouncer } from './bouncer/bouncer'

// Airi 연결 레이어 (P4)
export { mountEchoMemory } from './adapter/airi-adapter'
export type { EchoMemoryInstance } from './adapter/airi-adapter'
