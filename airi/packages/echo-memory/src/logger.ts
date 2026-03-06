// LLM API 콜/응답 정밀 로그 모듈
// - sLLM Bouncer 콜/응답
// - sLLM Summarizer 콜/응답
// - Airi 메인 LLM은 onBeforeMessageComposed / onChatTurnComplete 훅에서 래핑
//
// 로그 포맷: [타임스탬프] [역할] [방향] 내용
// 파일 저장 없이 console 기반 (브라우저 환경) — 필요 시 파일 핸들러 교체 가능

export type LLMRole = 'MAIN' | 'BOUNCER' | 'SUMMARIZER' | 'CONTEXT' | 'PROGRESS'
export type LogDirection = 'REQUEST' | 'RESPONSE'

export interface LLMLogEntry {
    role: LLMRole
    direction: LogDirection
    timestamp: number
    /** 요청 시: messages 배열 / 응답 시: 응답 텍스트 */
    content: string
    /** 사용 모델명 */
    model?: string
    /** 요청~응답 소요 시간 ms (RESPONSE만) */
    durationMs?: number
    /** 요청 입력 텍스트 요약 (Bouncer: 원문, Summarizer: 로그 앞 50자) */
    inputPreview?: string
}

export interface LLMLogger {
    request: (role: LLMRole, content: string, model?: string, inputPreview?: string) => number
    response: (role: LLMRole, content: string, startedAt: number, model?: string) => void
    onLog?: (entry: LLMLogEntry) => void
}

/**
 * createLLMLogger: LLM API 콜/응답 정밀 로거 생성
 *
 * @param options.onLog  로그 엔트리 콜백 (파일 저장, UI 표시 등 외부 연결용)
 * @param options.prefix 콘솔 출력 프리픽스 (기본 '[echo-memory]')
 *
 * @example
 * const logger = createLLMLogger()
 * const t = logger.request('BOUNCER', 'Viewer: 안녕하세요', 'llama3')
 * // ... API 콜 ...
 * logger.response('BOUNCER', '{"action":"pass"}', t, 'llama3')
 */
export function createLLMLogger(options?: {
    onLog?: (entry: LLMLogEntry) => void
    prefix?: string
    silent?: boolean
}) {
    const prefix = options?.prefix ?? '[echo-memory]'
    const silent = options?.silent ?? false

    function fmt(entry: LLMLogEntry): string {
        const ts = new Date(entry.timestamp).toISOString().slice(11, 23) // HH:MM:SS.mmm
        const dir = entry.direction === 'REQUEST' ? '→' : '←'
        const dur = entry.durationMs !== undefined ? ` (${entry.durationMs}ms)` : ''
        const model = entry.model ? ` [${entry.model}]` : ''
        const preview = entry.inputPreview ? ` | input: ${entry.inputPreview.slice(0, 60)}` : ''
        return `${prefix} ${ts} [${entry.role}]${model} ${dir}${dur}${preview}\n  ${entry.content.slice(0, 300)}`
    }

    function emit(entry: LLMLogEntry) {
        if (!silent) {
            if (entry.direction === 'REQUEST') {
                console.debug(fmt(entry))
            }
            else {
                const ok = !entry.content.includes('error')
                console.debug(fmt(entry))
                if (!ok)
                    console.warn(`${prefix} [${entry.role}] 응답 파싱 주의:`, entry.content.slice(0, 200))
            }
        }
        options?.onLog?.(entry)
    }

    /**
     * 요청 로그 기록. 시작 타임스탬프 반환 (response()에 전달).
     */
    function request(
        role: LLMRole,
        content: string,
        model?: string,
        inputPreview?: string,
    ): number {
        const timestamp = Date.now()
        emit({ role, direction: 'REQUEST', timestamp, content, model, inputPreview })
        return timestamp
    }

    /**
     * 응답 로그 기록. startedAt = request()가 반환한 타임스탬프.
     */
    function response(
        role: LLMRole,
        content: string,
        startedAt: number,
        model?: string,
    ): void {
        const timestamp = Date.now()
        emit({
            role,
            direction: 'RESPONSE',
            timestamp,
            content,
            model,
            durationMs: timestamp - startedAt,
        })
    }

    return { request, response, onLog: options?.onLog }
}

export type LLMLoggerInstance = ReturnType<typeof createLLMLogger>

/** 기본 전역 로거 (싱글톤, 앱 초기화 시 교체 가능) */
let _globalLogger: LLMLoggerInstance = createLLMLogger()

export function setGlobalLLMLogger(logger: LLMLoggerInstance) {
    _globalLogger = logger
}

export function getGlobalLLMLogger(): LLMLoggerInstance {
    return _globalLogger
}
