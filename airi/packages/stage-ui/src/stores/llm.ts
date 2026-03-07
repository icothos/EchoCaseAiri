import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { CommonContentPart, CompletionToolCall, Message, Tool } from '@xsai/shared-chat'

import { listModels } from '@xsai/model'
import { XSAIError } from '@xsai/shared'
import { streamText } from '@xsai/stream-text'
import { defineStore } from 'pinia'
import { ref } from 'vue'

import { debug, mcp } from '../tools'
import { isGeminiProvider, streamGeminiNative } from './gemini-utils'

export type StreamEvent
  = | { type: 'text-delta', text: string }
  | ({ type: 'finish' } & any)
  | ({ type: 'tool-call' } & CompletionToolCall)
  | { type: 'tool-result', toolCallId: string, result?: string | CommonContentPart[] }
  | { type: 'error', error: any }

export interface StreamOptions {
  headers?: Record<string, string>
  onStreamEvent?: (event: StreamEvent) => void | Promise<void>
  toolsCompatibility?: Map<string, boolean>
  supportsTools?: boolean
  waitForTools?: boolean // when true, won't resolve on finishReason=='tool_calls'
  tools?: Tool[] | (() => Promise<Tool[] | undefined>)
  /** 로깅 밎 해싱용 순수 원본 시스템 프롬프트 (동적 컨텍스트 제외) */
  rawSystemPrompt?: string
}

// TODO: proper format for other error messages.
function sanitizeMessages(messages: unknown[]): Message[] {
  return messages.map((m: any) => {
    if (m && m.role === 'error') {
      return {
        role: 'user',
        content: `User encountered error: ${String(m.content ?? '')}`,
      } as Message
    }
    return m as Message
  })
}

function streamOptionsToolsCompatibilityOk(model: string, chatProvider: ChatProvider, _: Message[], options?: StreamOptions): boolean {
  return !!(options?.supportsTools || options?.toolsCompatibility?.get(`${chatProvider.chat(model).baseURL}-${model}`))
}

async function streamFrom(model: string, chatProvider: ChatProvider, promptNode: Message, messages: Message[], options?: StreamOptions) {
  const headers = options?.headers
  const rawSystemPrompt = options?.rawSystemPrompt

  const sanitized = sanitizeMessages(messages as unknown[])
  const resolveTools = async () => {
    const tools = typeof options?.tools === 'function'
      ? await options.tools()
      : options?.tools
    return tools ?? []
  }

  const supportedTools = streamOptionsToolsCompatibilityOk(model, chatProvider, messages, options)
  const tools = supportedTools
    ? [
      ...await mcp(),
      ...await debug(),
      ...await resolveTools(),
    ]
    : undefined

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const resolveOnce = () => {
      if (settled)
        return
      settled = true
      resolve()
    }
    const rejectOnce = (err: unknown) => {
      if (settled)
        return
      settled = true
      reject(err)
    }

    const onEvent = async (event: unknown) => {
      try {
        await options?.onStreamEvent?.(event as StreamEvent)
        if (event && (event as StreamEvent).type === 'finish') {
          const finishReason = (event as any).finishReason
          if (finishReason !== 'tool_calls' || !options?.waitForTools)
            resolveOnce()
        }
        else if (event && (event as StreamEvent).type === 'error') {
          const error = (event as any).error ?? new Error('Stream error')
          rejectOnce(error)
        }
      }
      catch (err) {
        rejectOnce(err)
      }
    }

    try {
      // ── Gemini native SDK 경로 ────────────────────────────────
      if (isGeminiProvider(chatProvider, model)) {
        const apiKey = (import.meta.env as any).VITE_GEMINI_API_KEY as string | undefined
        if (!apiKey) {
          rejectOnce(new Error('VITE_GEMINI_API_KEY is not set'))
          return
        }
        streamGeminiNative(
          model,
          apiKey,
          promptNode,
          sanitized,
          tools,
          event => onEvent(event as any),
          line => { (window as any).logLLM?.(line) },
          rawSystemPrompt
        ).catch(rejectOnce)
        return
      }
      // ─────────────────────────────────────────────────────────

      streamText({
        ...chatProvider.chat(model),
        maxSteps: 10,
        messages: [promptNode, ...sanitized],
        headers,
        // TODO: we need Automatic tools discovery
        tools,
        onEvent,
      })
    }
    catch (err) {
      rejectOnce(err)
    }
  })
}

export async function attemptForToolsCompatibilityDiscovery(model: string, chatProvider: ChatProvider, _: Message[], options?: Omit<StreamOptions, 'supportsTools'>): Promise<boolean> {
  async function attempt(enable: boolean) {
    try {
      const mockPromptNode = { role: 'system', content: 'You are a test bot.', id: 'test-node' } as Message
      const mockUserMessage = { role: 'user', content: 'Hello, world!', id: 'test-msg' } as Message
      await streamFrom(model, chatProvider, mockPromptNode, [mockUserMessage], { ...options, supportsTools: enable })
      return true
    }
    catch (err) {
      if (err instanceof Error && err.name === new XSAIError('').name) {
        // TODO: if you encountered many more errors like these, please, add them here.

        // Ollama
        /**
         * {"error":{"message":"registry.ollama.ai/<scope>/<model> does not support tools","type":"api_error","param":null,"code":null}}
         */
        if (String(err).includes('does not support tools')) {
          return false
        }
        // OpenRouter
        /**
         * {"error":{"message":"No endpoints found that support tool use. To learn more about provider routing, visit: https://openrouter.ai/docs/provider-routing","code":404}}
         */
        if (String(err).includes('No endpoints found that support tool use.')) {
          return false
        }
      }

      throw err
    }
  }

  function promiseAllWithInterval<T>(promises: (() => Promise<T>)[], interval: number): Promise<{ result?: T, error?: any }[]> {
    return new Promise((resolve) => {
      const results: { result?: T, error?: any }[] = []
      let completed = 0

      promises.forEach((promiseFn, index) => {
        setTimeout(() => {
          promiseFn()
            .then((result) => {
              results[index] = { result }
            })
            .catch((err) => {
              results[index] = { error: err }
            })
            .finally(() => {
              completed++
              if (completed === promises.length) {
                resolve(results)
              }
            })
        }, index * interval)
      })
    })
  }

  const attempts = [
    () => attempt(true),
    () => attempt(false),
  ]

  const attemptsResults = await promiseAllWithInterval<boolean | undefined>(attempts, 1000)
  if (attemptsResults.some(res => res.error)) {
    const err = new Error(`Error during tools compatibility discovery for model: ${model}. Errors: ${attemptsResults.map(res => res.error).filter(Boolean).join(', ')}`)
    err.cause = attemptsResults.map(res => res.error).filter(Boolean)
    throw err
  }

  return attemptsResults[0].result === true && attemptsResults[1].result === true
}

export const useLLM = defineStore('llm', () => {
  const toolsCompatibility = ref<Map<string, boolean>>(new Map())

  /**
   * sessionId → TTS 변환 완료됐지만 아직 발화되지 않은 LLM 원본 텍스트 세그먼트 큐.
   * Stage.vue onTtsResult 시점에 enqueueLlmSegment로 적재되고,
   * TTS 발화 완료(sessionTtsSegmentPlayedEvent) 시 dequeueLlmSegment로 순서대로 꺼낸다.
   */
  const pendingLlmSegments = new Map<string, string[]>()

  /** TTS 요청 시점(문장 확정 후, TTS 생성 전)에 세그먼트를 큐에 적재 (Stage.vue onTtsRequest에서 호출) */
  function enqueueLlmSegment(sessionId: string, text: string) {
    const trimmed = text.trim()
    if (!trimmed)
      return
    const q = pendingLlmSegments.get(sessionId) ?? []
    q.push(trimmed)
    pendingLlmSegments.set(sessionId, q)
  }

  /** TTS 발화 완료 시점에 순서대로 세그먼트 꺼내기 (session-store bindSessionBus에서 호출) */
  function dequeueLlmSegment(sessionId: string): string | undefined {
    const text = pendingLlmSegments.get(sessionId)?.shift()
    return text
  }

  /** 인터럽트 등으로 해당 세션 큐 전체 초기화 */
  function clearLlmSegments(sessionId: string) {
    pendingLlmSegments.delete(sessionId)
  }

  async function discoverToolsCompatibility(model: string, chatProvider: ChatProvider, _: Message[], options?: Omit<StreamOptions, 'supportsTools'> & { force?: boolean }) {
    // Cached, no need to discover again
    if (toolsCompatibility.value.has(`${chatProvider.chat(model).baseURL}-${model}`)) {
      return
    }

    // Skip discovery if no tools are functionally required and we aren't forcing an upfront check
    if (!options?.force && (!options?.tools || (Array.isArray(options.tools) && options.tools.length === 0))) {
      toolsCompatibility.value.set(`${chatProvider.chat(model).baseURL}-${model}`, false)
      return
    }

    const res = await attemptForToolsCompatibilityDiscovery(model, chatProvider, _, { ...options, toolsCompatibility: toolsCompatibility.value })
    toolsCompatibility.value.set(`${chatProvider.chat(model).baseURL}-${model}`, res)
  }

  function stream(model: string, chatProvider: ChatProvider, promptNode: Message, messages: Message[], options?: StreamOptions) {
    return streamFrom(model, chatProvider, promptNode, messages, { ...options, toolsCompatibility: toolsCompatibility.value })
  }

  async function models(apiUrl: string, apiKey: string) {
    if (apiUrl === '') {
      return []
    }

    try {
      return await listModels({
        baseURL: (apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`) as `${string}/`,
        apiKey,
      })
    }
    catch (err) {
      if (String(err).includes(`Failed to construct 'URL': Invalid URL`)) {
        return []
      }

      throw err
    }
  }

  return {
    models,
    stream,
    discoverToolsCompatibility,
    enqueueLlmSegment,
    dequeueLlmSegment,
    clearLlmSegments,
  }
})
