import { onMounted, onUnmounted, ref } from 'vue'

export function useHotContextManager() {
  const runContextFileName = 'run_context.md'
  const hotContextFileName = 'hot_context.md'

  let pollingInterval: number | null = null

  const isEnabled = ref(true)

  function getHotPool() {
    // wait for echo memory to be mounted
    return (window as any).__echoMemory?.pool
  }

  async function loadRunContext() {
    if (typeof (window as any).fsReadFile !== 'function') {
      console.warn('[HotContextManager] fsReadFile not available in context block.')
      return
    }

    try {
      const fileData = await (window as any).fsReadFile(runContextFileName)
      const content = fileData?.content || ''
      const mtimeMs = fileData?.mtimeMs || Date.now()
      const pool = getHotPool()

      if (content.trim() !== '') {
        if (pool) {
          // Check if already exist to prevent redundant updates
          const existings = pool.allNodes?.().filter((n: any) => n.id === 'app-run-context') || []
          if (existings.length > 0 && existings[0].content === content.trim()) {
            return // Skip redundant update
          }

          if (existings.length > 0) {
            pool.updateNode('app-run-context', {
              content: content.trim(),
              createdAt: mtimeMs,
            })
            console.info('[HotContextManager] Updated Run Context in Echo Memory Pool.')
          } else {
            pool.addNode({
              id: 'app-run-context',
              content: content.trim(),
              weight: 100, // High weight so it's always included
              ttl: 999999999, // Effectively infinite TTL
              createdAt: mtimeMs,
              nodeType: 'context_summary' // 구조화된 요약 노드로 취급
            })
            console.info('[HotContextManager] Ingested Run Context into Echo Memory Pool.')
          }
        } else {
          // If pool isn't ready, try again later via our interval
          setTimeout(loadRunContext, 1000)
        }
      }
    } catch (e) {
      console.error('[HotContextManager] Error loading Run Context:', e)
    }
  }

  async function pollHotContext() {
    if (!isEnabled.value) return
    if (typeof (window as any).fsReadFile !== 'function') return

    const pool = getHotPool()
    if (!pool) {
      // If pool isn't ready on initial load, retry quickly before the 5s interval
      setTimeout(pollHotContext, 1000)
      return
    }

    try {
      const fileData = await (window as any).fsReadFile(hotContextFileName)
      const content = fileData?.content || ''
      const mtimeMs = fileData?.mtimeMs || Date.now()
      
      if (content.trim() !== '') {
        // We have a hot context and it's fresh. Add/update the node.
        const existings = pool.allNodes?.().filter((n: any) => n.id === 'app-hot-context') || []
        if (existings.length > 0) {
          const existingNode = existings[0]
          // Only update if content or creation time significantly changed
          if (existingNode.content !== content.trim() || existingNode.createdAt !== mtimeMs) {
             // Remove the older node and recreate it as explicitly requested
             pool.removeNodes(['app-hot-context'])
             pool.addNode({
                id: 'app-hot-context',
                content: content.trim(),
                weight: 90,
                ttl: 999999999, // Infinite TTL
                createdAt: mtimeMs,
                nodeType: 'context_summary'
             })
          }
        } else {
          pool.addNode({
            id: 'app-hot-context',
            content: content.trim(),
            weight: 90, // High weight to be prioritized over older chat nodes
            ttl: 999999999, // Infinite TTL
            createdAt: mtimeMs, // Tie creation to file modification
            nodeType: 'context_summary'
          })
        }
      } else {
        // file empty or doesn't exist. Delete it from pool.
        pool.removeNodes(['app-hot-context'])
      }
    } catch (e) {
      console.error('[HotContextManager] Error polling Hot Context:', e)
    }
  }

  function start() {
    loadRunContext()
    pollHotContext()
    pollingInterval = window.setInterval(pollHotContext, 5000) // Poll every 5 seconds
  }

  function stop() {
    if (pollingInterval) {
      window.clearInterval(pollingInterval)
      pollingInterval = null
    }
  }

  onMounted(() => {
    start()
  })

  onUnmounted(() => {
    stop()
  })

  return {
    start,
    stop,
    loadRunContext,
    isEnabled
  }
}

