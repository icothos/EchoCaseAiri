// P1: Hot Context Pool
// Python hot_memory.py → TypeScript 포팅

import type { ContextNode, HotPoolOptions, NodeType } from '../types'

import { nanoid } from 'nanoid'

export function createHotContextPool(options?: HotPoolOptions) {
    const topK = options?.topK ?? 3
    const defaultTtl = options?.defaultTtl ?? 1800 // 30분 (초)
    const onUpdate = options?.onUpdate

    const nodes: ContextNode[] = []

    // --- 헬퍼 ---
    function isExpired(node: ContextNode): boolean {
        const ageMs = Date.now() - node.createdAt
        return ageMs > node.ttl * 1000
    }

    function isActive(node: ContextNode): boolean {
        return !isExpired(node) && !node.completed
    }

    // --- 공개 API ---

    /** 새 노드 추가 */
    function addNode(
        contentOrNode: string | Partial<ContextNode>,
        weight = 50,
        ttl = defaultTtl,
        nodeType: NodeType = 'chat',
    ): ContextNode {
        const node: ContextNode
            = typeof contentOrNode === 'string'
                ? {
                    id: nanoid(),
                    content: contentOrNode,
                    weight,
                    ttl,
                    createdAt: Date.now(),
                    nodeType,
                    completed: false,
                    topic: '',
                    speaker: '시청자',
                    contextSummary: '',
                    progressSummary: '',
                    mood: '',
                }
                : {
                    id: nanoid(),
                    content: '',
                    weight: 50,
                    ttl: defaultTtl,
                    createdAt: Date.now(),
                    nodeType: 'chat',
                    completed: false,
                    topic: '',
                    speaker: '시청자',
                    contextSummary: '',
                    progressSummary: '',
                    mood: '',
                    ...contentOrNode,
                }

        nodes.push(node)
        onUpdate?.('add', node)
        return node
    }

    /** weight 내림차순으로 상위 K개 노드 반환 */
    function getTopK(k = topK): ContextNode[] {
        const active = nodes.filter(isActive)
        active.sort((a, b) => b.weight - a.weight)
        return active.slice(0, k)
    }

    /** 아카이빙 대상 노드 (만료 or 완료) */
    function getArchivableNodes(): ContextNode[] {
        return nodes.filter(n => isExpired(n) || n.completed)
    }

    /** 노드 완료 처리 */
    function markCompleted(nodeId: string): void {
        const node = nodes.find(n => n.id === nodeId)
        if (node) {
            node.completed = true
            onUpdate?.('update', node)
        }
    }

    /** 노드 영구 삭제 */
    function removeNodes(nodeIds: string[]): void {
        const idSet = new Set(nodeIds)
        let i = nodes.length
        while (i--) {
            if (idSet.has(nodes[i].id)) {
                const removed = nodes.splice(i, 1)[0]
                onUpdate?.('remove', removed)
            }
        }
    }

    /**
     * 가장 weight 높은 context_summary 노드의 progress_summary 갱신
     * (AI 응답 완료 후 onChatTurnComplete 훅에서 호출)
     */
    function updateTopContextProgress(newProgress: string): boolean {
        const active = nodes.filter(
            n => isActive(n) && n.nodeType === 'context_summary',
        )
        if (active.length === 0)
            return false

        const top = active.reduce((a, b) => (a.weight >= b.weight ? a : b))
        top.progressSummary = newProgress

        // content 문자열 재생성 (LLM 프롬프트에 주입되는 내용)
        const header = top.topic ? `[${top.topic}] ${top.speaker}` : top.speaker
        const lines = [
            top.mood ? `${header} | 분위기: ${top.mood}` : header,
            `맥락: ${top.contextSummary}`,
        ]
        if (newProgress)
            lines.push(`진행: ${newProgress}`)
        top.content = lines.join('\n')

        onUpdate?.('update', top)

        return true
    }

    /**
     * 특정 노드 ID의 임의 필드를 부분 업데이트.
     * context_summary 노드는 topic/speaker/mood/contextSummary/progressSummary 변경 시
     * content 문자열을 자동으로 재생성함.
     *
     * @param nodeId  대상 노드 ID
     * @param patch   변경할 필드 (Partial<ContextNode>)
     * @returns       업데이트 성공 여부
     */
    function updateNode(nodeId: string, patch: Partial<ContextNode>): boolean {
        const node = nodes.find(n => n.id === nodeId)
        if (!node)
            return false

        Object.assign(node, patch)

        // context_summary 노드는 구조화 필드 변경 시 content 재생성
        if (node.nodeType === 'context_summary') {
            rebuildContent(node)
        }
        
        onUpdate?.('update', node)
        return true
    }

    /**
     * 현재 활성 노드 중 weight가 가장 높은 노드의 임의 필드를 부분 업데이트.
     * nodeType 필터로 특정 타입만 대상 가능 (기본: 전체 활성 노드).
     *
     * @example pool.updateTopNode({ progressSummary: '...' }, 'context_summary')
     */
    function updateTopNode(
        patch: Partial<ContextNode>,
        filterType?: ContextNode['nodeType'],
    ): boolean {
        const active = nodes.filter(
            n => isActive(n) && (!filterType || n.nodeType === filterType),
        )
        if (active.length === 0)
            return false

        const top = active.reduce((a, b) => (a.weight >= b.weight ? a : b))
        return updateNode(top.id, patch)
    }

    /** context_summary 노드의 content 문자열 재생성 (내부 헬퍼) */
    function rebuildContent(node: ContextNode): void {
        if (node.nodeType !== 'context_summary')
            return
        const header = node.topic ? `[${node.topic}] ${node.speaker}` : node.speaker
        const lines = [
            node.mood ? `${header} | 분위기: ${node.mood}` : header,
            `맥락: ${node.contextSummary}`,
        ]
        if (node.progressSummary)
            lines.push(`진행: ${node.progressSummary}`)
        node.content = lines.join('\n')
    }

    /** 현재 살아있는 노드 수 */
    function activeCount(): number {
        return nodes.filter(isActive).length
    }

    /** 전체 노드 (디버그용) */
    function allNodes(): readonly ContextNode[] {
        return nodes
    }

    return {
        addNode,
        getTopK,
        getArchivableNodes,
        markCompleted,
        removeNodes,
        updateNode,
        updateTopNode,
        updateTopContextProgress,
        activeCount,
        allNodes,
    }
}

export type HotContextPool = ReturnType<typeof createHotContextPool>
