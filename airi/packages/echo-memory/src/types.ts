// P1: Tri-Core 핵심 타입 정의
// Python hot_memory.py → TypeScript 포팅

export type NodeType =
    | 'chat'           // 일반 채팅
    | 'context_summary' // sLLM 요약본
    | 'donation'       // 후원
    | 'system'         // 시스템 이벤트
    | 'rag_result'     // Cold DB RAG 검색 결과
    | 'progress'       // Progress 업데이트

export interface ContextNode {
    id: string
    content: string
    weight: number       // 높을수록 Top-K 우선
    ttl: number          // 생존 시간 (초)
    createdAt: number    // Unix timestamp (ms)
    nodeType: NodeType
    completed: boolean

    // context_summary 노드 전용 구조화 필드
    topic: string
    speaker: string
    contextSummary: string   // 어떤 맥락이었는지 (1~2문장)
    progressSummary: string  // 어디까지 이야기했는지 / 다음 예상 흐름
    mood: string             // 분위기 (2~4 한국어 글자)
}

export interface BouncerResult {
    action: 'ignore' | 'pass' | 'rag' | 'interrupt'
    cleanText: string
}

export interface SummarizerResult {
    topic: string
    speaker: string
    contextSummary: string
    progressSummary: string
    mood: string
    weight: number
}

/**
 * mountEchoMemory() 에 전달하는 전체 설정.
 *
 * - `bouncer`: Bouncer sLLM 설정 (필수)
 * - `summarizerLLM`: Summarizer 전용 LLM 설정 (생략 시 bouncer 설정 공유)
 * - `hotPool`: Hot Context Pool 파라미터
 * - `summarizer`: 슬라이딩 윈도우 파라미터
 */
export interface EchoMemoryOptions {
    bouncer: BouncerOptions
    /** Summarizer 전용 LLM (생략 시 bouncer 설정 사용) */
    summarizerLLM?: LLMEndpointOptions
    /** Progress Summarizer 전용 LLM (생략 시 summarizerLLM → bouncer 순으로 폴백) */
    progressLLM?: LLMEndpointOptions
    hotPool?: HotPoolOptions
    summarizer?: SummarizerOptions
}

/** 공통 LLM 엔드포인트 설정 (Bouncer/Summarizer 둘 다 사용) */
export interface LLMEndpointOptions {
    /** HTTP 서버 base URL (예: http://localhost:8080, https://generativelanguage.googleapis.com/v1beta/openai) */
    baseUrl: string
    /** API 키 (로컬 llama.cpp는 불필요, Gemini 등 클라우드 LLM은 필수) */
    apiKey?: string
    /** 모델 이름 (기본: 'local-model') */
    model?: string
    /** 요청 타임아웃 ms (기본: Bouncer 5000, Summarizer 10000) */
    timeoutMs?: number
}

/** Bouncer 전용 설정 — LLMEndpointOptions 확장 */
export interface BouncerOptions extends LLMEndpointOptions { }

export interface HotPoolOptions {
    /** Top-K 개수 (기본 3) */
    topK?: number
    /** 기본 TTL (초, 기본 1800 = 30분) */
    defaultTtl?: number
}

export interface SummarizerOptions {
    /** 슬라이딩 윈도우 최대 메시지 수 (기본 20) */
    windowSize?: number
    /** 한 번에 요약할 메시지 수 (기본 10) */
    chunkSize?: number
}
