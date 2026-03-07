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
    chatOrchestratorStore: {
        onBeforeMessageComposed: (handler: any) => () => void
        onBeforeSend: (handler: any) => () => void
        onAssistantSpeechComplete: (handler: any) => () => void
    },
    chatSessionStore: {
        getSessionMessages: (sessionId: string) => any[]
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
    
    // T_1 스냅샷을 담을 공간 (Session별)
    const contextSnapshots = new Map<string, { topNodes: any[], chatLog: string }>()

    // ② Hot Context 주입 및 Bouncer: LLM 호출 직전
    // (Bouncer가 await 되어야 메인 LLM이 기다려 줌)
    cleanups.push(chatOrchestratorStore.onBeforeMessageComposed(async (messageText: string | null | undefined) => {
        // Bouncer 처리
        const text: string = messageText ?? ''

        if (text && !isDuplicate(text)) {
            const result = await bouncer.route(text)

            if (result.action === 'ignore') {
                // eslint-disable-next-line no-console
                console.debug('[echo-memory] Bouncer: ignore', text.slice(0, 40))
                // 중요: onBeforeMessageComposed에서 에러를 던지면 ingest(메인 LLM)가 중단됨
                // (이 경우 AI가 실제로 응답하지 않으므로 isSpeaking 플래그를 세우지 않음)
                throw new Error('BOUNCER_IGNORE')
            }

            if (result.action === 'rag') {
                // TODO P8: Cold DB 벡터 검색
                // eslint-disable-next-line no-console
                console.debug('[echo-memory] Bouncer: rag (미구현)', text.slice(0, 40))
            }
        }

        // Hot Context 주입: 동일 SourceKey에서 Overwrite 되지 않도록 하나로 병합하여 주입
        const topNodes = pool.getTopK()
        if (topNodes.length > 0) {
            const combinedContent = topNodes.map(node => `[Echo 기억 (Weight: ${node.weight})] ${node.content}`).join('\n\n')
            const id = nanoid()
            chatContextStore.ingestContextMessage({
                id,
                contextId: id,
                role: 'system',
                source: 'echo-memory', // 강제로 Source 명시 (Grouping 용)
                content: combinedContent,
                strategy: ContextUpdateStrategy.ReplaceSelf,
                createdAt: Date.now(),
            })
        } else {
            // 노드가 없을 경우 빈 값으로 덮어씌워 초기화
            chatContextStore.ingestContextMessage({
                id: 'empty',
                contextId: 'empty',
                role: 'system',
                source: 'echo-memory',
                content: '',
                strategy: ContextUpdateStrategy.ReplaceSelf,
                createdAt: Date.now(),
            })
        }
    }))

    // ③ 스냅샷 캡처 (T_1): LLM 스트리밍 직전
    cleanups.push(chatOrchestratorStore.onBeforeSend(async (_: any, context: any) => {
        const sessionId = context.sessionId
        if (!sessionId) {
            console.warn('[EchoMemory] onBeforeSend: no sessionId in context')
            return
        }

        const topNodes = pool.getTopK().filter((n: any) => n.nodeType === 'context_summary').map((n: any) => ({ ...n }))
        const msgs = chatSessionStore.getSessionMessages(sessionId) || []
        
        // 최근 20개의 메시지만 잘라서 ChatLog로 만듦 (과도한 토큰 소모 방지)
        const recentMsgs = msgs.slice(-20)
        const chatLog = recentMsgs.map((m: any) => `${m.role === 'user' ? 'User' : 'Airi'}: ${m.content}`).join('\n')

        console.info(`[EchoMemory] Snapshot captured for session=${sessionId}, topNodes=${topNodes.length}`)
        contextSnapshots.set(sessionId, { topNodes, chatLog })
    }))

    // ④ AI 발화 완전 종료 (또는 인터럽트) 시: Progress Bot 가동
    cleanups.push(chatOrchestratorStore.onAssistantSpeechComplete(async (payload: { sessionId: string; isInterrupted: boolean; playedText: string }) => {
        const { sessionId, isInterrupted, playedText } = payload
        console.info(`[EchoMemory] onAssistantSpeechComplete received for session=${sessionId}, isInter=${isInterrupted}, length=${playedText?.length}`)
        
        const snapshot = contextSnapshots.get(sessionId)
        
        // 스냅샷이 없으면 판단 불가로 스킵
        if (!snapshot) {
            console.warn(`[EchoMemory] No snapshot found for session=${sessionId}, skipping Progress Summarizer`)
            return
        }
        
        if (!playedText || !playedText.trim()) {
            console.warn(`[EchoMemory] Played text is empty for session=${sessionId}, skipping Progress Summarizer`)
            return
        }

        console.info(`[EchoMemory] Triggering decideContextUpdate for session=${sessionId} with text preview: ${playedText.slice(0, 40)}...`)
        const decision = await summarizer.decideContextUpdate(playedText, isInterrupted, snapshot.topNodes, snapshot.chatLog)
        console.info(`[EchoMemory] Progress Bot decision:`, decision)
        
        // 판단이 끝났으므로 맵에서 스냅샷 제거
        contextSnapshots.delete(sessionId)
        
        if (decision) {
            switch (decision.action) {
                case 'create':
                    pool.addNode({
                        content: `[${decision.topic}] ${decision.speaker} | 분위기: ${decision.mood}\n맥락: ${decision.contextSummary}\n진행: ${decision.progressSummary}`,
                        weight: decision.weight !== undefined ? decision.weight : 50.0,
                        ttl: 300,
                        nodeType: 'context_summary',
                        topic: decision.topic ?? '',
                        speaker: decision.speaker ?? '시청자',
                        contextSummary: decision.contextSummary ?? '',
                        progressSummary: decision.progressSummary ? [decision.progressSummary] : [],
                        mood: decision.mood ? [decision.mood] : [],
                    })
                    break
                case 'update':
                    if (decision.targetNodeId) {
                        const targetNode = pool.allNodes().find((n: any) => n.id === decision.targetNodeId)
                        if (targetNode) {
                           pool.updateNode(decision.targetNodeId, {
                               progressSummary: decision.progressSummary ? [decision.progressSummary] : [],
                               weight: decision.weight !== undefined ? decision.weight : targetNode.weight
                           })
                        } else {
                           pool.updateTopNode({
                               progressSummary: decision.progressSummary ? [decision.progressSummary] : [],
                               weight: decision.weight
                           }, 'context_summary')
                        }
                    } else {
                        pool.updateTopNode({
                            progressSummary: decision.progressSummary ? [decision.progressSummary] : [],
                            weight: decision.weight
                        }, 'context_summary')
                    }
                    break
                case 'skip':
                default:
                    // 아무것도 하지 않음 (의미없는 대화 지속)
                    break
            }
        }
    }))

    return {
        pool,
        bouncer,
        summarizer,
        /** 모든 훅 해제 (컴포넌트 unmount 시 호출) */
        dispose: () => {
            cleanups.forEach(fn => fn())
        },
    }
}

export type EchoMemoryInstance = ReturnType<typeof mountEchoMemory>
