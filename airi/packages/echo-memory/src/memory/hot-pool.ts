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
                    rawContent: contentOrNode,
                    weight,
                    ttl,
                    createdAt: Date.now(),
                    nodeType,
                    completed: false,
                    topic: '',
                    speaker: '시청자',
                    contextSummary: '',
                    progressSummary: [],
                    mood: [],
                    isContentFrozen: false,
                }
                : {
                    id: nanoid(),
                    content: contentOrNode.content ?? '',
                    rawContent: contentOrNode.rawContent ?? contentOrNode.content ?? '',
                    weight: 50,
                    ttl: defaultTtl,
                    createdAt: Date.now(),
                    nodeType: 'chat',
                    completed: false,
                    topic: '',
                    speaker: '시청자',
                    contextSummary: '',
                    progressSummary: [],
                    mood: [],
                    isContentFrozen: false,
                    ...contentOrNode,
                }
                
        // context_summary 에 대한 기본값 주입
        if (node.nodeType === 'context_summary') {
            if (!node.contextSummary && node.rawContent) {
                 node.contextSummary = node.rawContent;
            }
            if (node.progressSummary.length === 0) {
                 node.progressSummary = ['방금 대화가 시작되었거나 진행 전 상태입니다.'];
            }
        }

        rebuildContent(node)
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

    function updateTopContextProgress(newProgress: string): boolean {
        const active = nodes.filter(
            n => isActive(n) && n.nodeType === 'context_summary',
        )
        if (active.length === 0)
            return false

        const top = active.reduce((a, b) => (a.weight >= b.weight ? a : b))
        if (newProgress) {
            top.progressSummary.push(newProgress)
        }

        // content 문자열 재생성 (LLM 프롬프트에 주입되는 내용)
        rebuildContent(top)

        onUpdate?.('update', top)

        return true
    }

    /**
     * 특정 노드 ID의 임의 필드를 부분 업데이트.
     * update 시 mood나 progressSummary 가 주어지면 덮어쓰지 않고 배열에 최신 값으로 push함.
     * 단, 명시적으로 content를 변경하는 경우, isContentFrozen을 true로 만들며 이전 히스토리를 초기화할 수 있음.
     */
    function updateNode(nodeId: string, patch: Partial<ContextNode>): boolean {
        const node = nodes.find(n => n.id === nodeId)
        if (!node)
            return false

        // 명시적으로 content를 요약하는 등의 용도로 업데이트할 때
        if ('content' in patch && !('rawContent' in patch)) {
            patch.rawContent = patch.content;
            
            // 만약 content를 의도적으로 길어서 자르거나 요약 본 형태로 덮어쓰는거라면, 
            // 이전 이력들을 리셋/동결 처리.
            if (patch.isContentFrozen === true) {
                node.mood = [];
                node.progressSummary = [];
                node.isContentFrozen = true;
            }
        }
        
        // mood, progressSummary는 배열에 데이터 push
        if (patch.mood !== undefined) {
             const m = Array.isArray(patch.mood) ? patch.mood : [patch.mood];
             node.mood.push(...m);
             delete patch.mood;
        }

        if (patch.progressSummary !== undefined) {
             const p = Array.isArray(patch.progressSummary) ? patch.progressSummary : [patch.progressSummary];
             node.progressSummary.push(...p);
             delete patch.progressSummary;
        }

        // 나머지 객체는 단순 덮어쓰기 (ttl, weight 등)
        Object.assign(node, patch)

        // 구조화 필드 변경 시 content 재생성 (모든 노드 타입 적용)
        rebuildContent(node)
        
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

    /** 구조화 데이터 변경 시 content 문자열 재생성 (내부 헬퍼) */
    function rebuildContent(node: ContextNode): void {
        const hasStructuredData = node.topic || node.mood.length > 0 || node.contextSummary || node.progressSummary.length > 0;
        
        if (node.nodeType === 'context_summary') {
            const header = node.topic ? `[${node.topic}] ${node.speaker}` : node.speaker
            const lines: string[] = [
                header,
                ...(node.contextSummary ? [`맥락: ${node.contextSummary}`] : []),
            ]
            
            if (node.mood.length > 0)
                lines.push(`분위기 변화: ${node.mood.join(' -> ')}`)
            if (node.progressSummary.length > 0) {
                lines.push(`진행 변화:`)
                node.progressSummary.forEach((p, idx) => lines.push(`  ${idx + 1}. ${p}`))
            }
            node.content = lines.join('\n')
        } else {
            // context_summary가 아닌 일반 노드 (chat 등)
            if (hasStructuredData || node.isContentFrozen) {
                const header = node.topic ? `[${node.topic}] ${node.speaker}` : node.speaker;
                const lines: string[] = [];
                
                if (node.topic || (node.speaker !== '시청자')) {
                    lines.push(header);
                }
                
                if (node.contextSummary) lines.push(`맥락: ${node.contextSummary}`);
                
                if (node.mood.length > 0)
                    lines.push(`분위기 변화: ${node.mood.join(' -> ')}`)
                if (node.progressSummary.length > 0) {
                    lines.push(`진행 변화:`)
                    node.progressSummary.forEach((p, idx) => lines.push(`  ${idx + 1}. ${p}`))
                }
                
                const baseText = node.rawContent ?? node.content;
                if (baseText) lines.push(`내용:\n${baseText}`);
                
                node.content = lines.join('\n')
            } else {
                if (node.rawContent !== undefined) {
                    node.content = node.rawContent;
                }
            }
        }
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
