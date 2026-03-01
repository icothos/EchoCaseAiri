// P4: Airi 연결 레이어 (접착제)
// Airi 실제 store를 직접 주입받아 echo-memory 컴포넌트와 연결
//
// ⚠️ 중요 타이밍:
//   - Hot Context 주입은 onBeforeMessageComposed (chat.ts L224) 에서 해야 함
//   - getContextsSnapshot()이 L263에서 호출되므로 그 전에 ingest 필요
//
// ⚠️ Bouncer 독립 리스너 주의:
//   - serverChannel.onEvent 리스너는 독립 실행
//   - Bouncer가 drop해도 context-bridge의 동일 이벤트 핸들러는 별도 실행됨

import type { EchoMemoryOptions } from '../types'

import { ContextUpdateStrategy } from '@proj-airi/server-sdk'
import { nanoid } from 'nanoid'

import { createBouncer } from '../bouncer/bouncer'
import { createHotContextPool } from '../memory/hot-pool'
import { createSummarizer } from '../memory/summarizer'

/** content-hash를 이용한 dedup (Bouncer + context-bridge 중복 ingest 방지) */
const _recentHashes = new Set<string>()
function contentHash(text: string): string {
    let h = 5381
    for (let i = 0; i < text.length; i++)
        h = ((h << 5) + h) ^ text.charCodeAt(i)
    return (h >>> 0).toString(36)
}

function isDuplicate(text: string): boolean {
    const h = contentHash(text)
    if (_recentHashes.has(h))
        return true
    _recentHashes.add(h)
    if (_recentHashes.size > 50) {
        const first = _recentHashes.values().next().value
        if (first !== undefined)
            _recentHashes.delete(first)
    }
    return false
}

/**
 * echo-memory를 Airi에 마운트.
 *
 * App.vue 또는 초기화 로직에서 한 번만 호출.
 *
 * @param serverChannelStore  useModsServerChannelStore() 반환값
 * @param chatOrchestratorStore  useChatOrchestratorStore() 반환값
 * @param chatContextStore  useChatContextStore() 반환값
 * @param options  EchoMemoryOptions
 */
export function mountEchoMemory(
    serverChannelStore: {
        onEvent: (eventType: string, handler: (event: any) => void | Promise<void>) => () => void
    },
    chatOrchestratorStore: {
        onBeforeMessageComposed: (handler: (...args: any[]) => void | Promise<void>) => () => void
        onChatTurnComplete: (handler: (chat: { output: any, outputText: string, toolCalls: any[] }, ...rest: any[]) => void | Promise<void>) => () => void
    },
    chatContextStore: {
        ingestContextMessage: (msg: any) => void
    },
    options: EchoMemoryOptions,
) {
    const pool = createHotContextPool(options.hotPool)
    const bouncer = createBouncer(options.bouncer)

    // summarizerLLM이 지정되면 별도 서버/모델 사용, 없으면 bouncer 설정 공유
    const summarizerEndpoint = options.summarizerLLM
        ? { ...options.bouncer, ...options.summarizerLLM }
        : options.bouncer

    // progressLLM: summarizerLLM → bouncer 순으로 폴백
    const progressEndpoint = options.progressLLM
        ? { ...options.bouncer, ...options.progressLLM }
        : summarizerEndpoint

    const summarizer = createSummarizer(summarizerEndpoint, options.summarizer, progressEndpoint)

    const cleanups: Array<() => void> = []

    // ① Hot Context 주입 및 Bouncer: LLM 호출 직전
    // (Bouncer가 await 되어야 메인 LLM이 기다려 줌)
    cleanups.push(chatOrchestratorStore.onBeforeMessageComposed(async (messageText) => {
        // Bouncer 처리
        const text: string = messageText ?? ''

        if (text && !isDuplicate(text)) {
            const result = await bouncer.route(text)

            if (result.action === 'ignore') {
                // eslint-disable-next-line no-console
                console.debug('[echo-memory] Bouncer: ignore', text.slice(0, 40))
                // 중요: onBeforeMessageComposed에서 에러를 던지면 ingest(메인 LLM)가 중단됨
                throw new Error('BOUNCER_IGNORE')
            }

            if (result.action === 'rag') {
                // TODO P8: Cold DB 벡터 검색
                // eslint-disable-next-line no-console
                console.debug('[echo-memory] Bouncer: rag (미구현)', text.slice(0, 40))
            }

            summarizer.addMessage('user', result.cleanText || text)
        }

        // Hot Context 주입
        const topNodes = pool.getTopK()
        for (const node of topNodes) {
            const id = nanoid()
            chatContextStore.ingestContextMessage({
                id,
                contextId: id,
                role: 'user',
                content: `[Echo 기억] ${node.content}`,
                strategy: ContextUpdateStrategy.ReplaceSelf,
                createdAt: Date.now(),
            })
        }
    }))

    // ③ AI 응답 완료 후: Progress 업데이트 + Summarizer 트리거
    cleanups.push(chatOrchestratorStore.onChatTurnComplete(async ({ outputText }) => {
        summarizer.addMessage('assistant', outputText)

        const topNode = pool.getTopK(1).find(n => n.nodeType === 'context_summary')
        const progressText = await summarizer.generateProgressSummary(
            outputText,
            topNode?.contextSummary,
        )

        if (progressText)
            pool.updateTopNode({ progressSummary: progressText }, 'context_summary')
        else
            pool.updateTopContextProgress(outputText.slice(0, 80))

        void summarizer.maybeRunSummarizer(pool)
    }))

    return {
        pool,
        bouncer,
        summarizer,
        /** 모든 훅 해제 (컴포넌트 unmount 시 호출) */
        dispose: () => cleanups.forEach(fn => fn()),
    }
}

export type EchoMemoryInstance = ReturnType<typeof mountEchoMemory>
