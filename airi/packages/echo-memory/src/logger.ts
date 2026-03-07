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
    /** 시스템 프롬프트 전체 내용 (최초 로깅시에만 출력됨) */
    systemPrompt?: string
    /** 시스템 프롬프트 해시값 */
    systemHash?: string
    /** 로깅 요청/응답 페어링 ID */
    reqId?: string
}

function getShortHash(str: string): string {
    let h = 5381
    for (let i = 0; i < str.length; i++)
        h = ((h << 5) + h) ^ str.charCodeAt(i)
    return (h >>> 0).toString(16).padStart(8, '0')
}

const _seenSystemHashes = new Set<string>()

export interface LLMLogger {
    request: (role: LLMRole, content: string, model?: string, inputPreview?: string, systemPrompt?: string) => string
    response: (role: LLMRole, content: string, reqId: string, model?: string) => void
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
    let _reqCounter = 0
    const _pendingRequests = new Map<string, number>()

    function fmt(entry: LLMLogEntry, truncateContent = false): string {
        const ts = new Date(entry.timestamp).toISOString().slice(11, 23) // HH:MM:SS.mmm
        const dir = entry.direction === 'REQUEST' ? '→' : '←'
        const dur = entry.durationMs !== undefined ? ` (${entry.durationMs}ms)` : ''
        const model = entry.model ? ` [${entry.model}]` : ''
        const preview = entry.inputPreview ? ` | input: ${entry.inputPreview.slice(0, 60)}` : ''

        let systemStr = ''
        if (entry.systemPrompt && entry.systemHash) {
            if (!_seenSystemHashes.has(entry.systemHash)) {
                _seenSystemHashes.add(entry.systemHash)
                systemStr = `\n  [System Prompt Hash: ${entry.systemHash}]\n  ${entry.systemPrompt}`
            }
            else {
                systemStr = `\n  [System Prompt Hash: ${entry.systemHash}] (Omitted)`
            }
        }

        const displayContent = truncateContent
            ? (entry.content.length > 100 ? entry.content.slice(0, 100) + '...' : entry.content)
            : entry.content

        const reqTag = entry.reqId ? `[#${entry.reqId}] ` : ''

        return `${prefix} ${ts} ${reqTag}[${entry.role}]${model} ${dir}${dur}${preview}${systemStr}\n  ${displayContent}`
    }

    function emit(entry: LLMLogEntry) {
        if (!silent) {
            if (entry.direction === 'REQUEST') {
                console.debug(fmt(entry, true))
            }
            else {
                const ok = !entry.content.includes('error')
                console.debug(fmt(entry, true))
                if (!ok)
                    console.warn(`${prefix} [${entry.role}] 응답 파싱 주의:\n`, entry.content)
            }
        }
        options?.onLog?.(entry)
    }

    /**
     * 요청 로그 기록. 고유 reqId 반환 (response()에 전달).
     */
    function request(
        role: LLMRole,
        content: string,
        model?: string,
        inputPreview?: string,
        systemPrompt?: string,
    ): string {
        const timestamp = Date.now()
        _reqCounter++
        const reqId = _reqCounter.toString().padStart(4, '0')
        _pendingRequests.set(reqId, timestamp)

        const systemHash = systemPrompt ? getShortHash(systemPrompt) : undefined
        emit({ role, direction: 'REQUEST', timestamp, content, model, inputPreview, systemPrompt, systemHash, reqId })
        return reqId
    }

    /**
     * 응답 로그 기록. reqId = request()가 반환한 ID.
     */
    function response(
        role: LLMRole,
        content: string,
        reqId: string,
        model?: string,
    ): void {
        const timestamp = Date.now()
        const startedAt = _pendingRequests.get(reqId) ?? timestamp
        _pendingRequests.delete(reqId)

        emit({
            role,
            direction: 'RESPONSE',
            timestamp,
            content,
            model,
            durationMs: timestamp - startedAt,
            reqId,
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
