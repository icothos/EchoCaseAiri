import type { WebSocketEventInputs } from '@proj-airi/server-sdk'
import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { CommonContentPart, Message, ToolMessage } from '@xsai/shared-chat'

import type { ChatAssistantMessage, ChatSlices, ChatStreamEventContext, StreamingAssistantMessage } from '../types/chat'
import type { StreamEvent, StreamOptions } from './llm'

import { createQueue } from '@proj-airi/stream-kit'
import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { ref, toRaw } from 'vue'

import { useAnalytics } from '../composables'
import { useLlmmarkerParser } from '../composables/llm-marker-parser'
import { categorizeResponse, createStreamingCategorizer } from '../composables/response-categoriser'
import { createDatetimeContext } from './chat/context-providers'
import { useChatContextStore } from './chat/context-store'
import { createChatHooks } from './chat/hooks'
import { useChatSessionStore } from './chat/session-store'
import { useChatStreamStore } from './chat/stream-store'
import { useLLM } from './llm'
import { useConsciousnessStore } from './modules/consciousness'

interface SendOptions {
  model: string
  chatProvider: ChatProvider
  providerConfig?: Record<string, unknown>
  attachments?: { type: 'image', data: string, mimeType: string }[]
  tools?: StreamOptions['tools']
  input?: WebSocketEventInputs
  promptOptions?: import('./chat/session-store').PromptOptions
  /** auto-speak 트리거에 의한 호출임을 표시 - 빈 메시지도 LLM 호출을 허용 */
  isAutoSpeak?: boolean
}

interface ForkOptions {
  fromSessionId?: string
  atIndex?: number
  reason?: string
  hidden?: boolean
}

interface QueuedSend {
  sendingMessage: string
  options: SendOptions
  generation: number
  sessionId: string
  cancelled?: boolean
  deferred: {
    resolve: () => void
    reject: (error: unknown) => void
  }
}

export const useChatOrchestratorStore = defineStore('chat-orchestrator', () => {
  const llmStore = useLLM()
  const consciousnessStore = useConsciousnessStore()
  const { activeProvider } = storeToRefs(consciousnessStore)
  const { trackFirstMessage } = useAnalytics()

  const chatSession = useChatSessionStore()
  const chatStream = useChatStreamStore()
  const chatContext = useChatContextStore()
  const { activeSessionId } = storeToRefs(chatSession)
  const { streamingMessage } = storeToRefs(chatStream)

  const sending = ref(false)
  const currentSendingSessionId = ref('') // performSend가 실제로 사용하는 sessionId
  const currentTurnToken = ref('') // 현재 터의 식별 토큰 (TTS 완료 후 auto-speak 판정용)
  const pendingQueuedSends = ref<QueuedSend[]>([])
  const hooks = createChatHooks()

  const chatCooldownMs = Number(import.meta.env.VITE_CHAT_COOLDOWN_MS ?? 0)

  const sendQueue = createQueue<QueuedSend>({
    handlers: [
      async ({ data }) => {
        const { sendingMessage, options, generation, deferred, sessionId, cancelled } = data

        if (cancelled) {
          console.warn('[Chat] sendQueue cancelled item before processing', sessionId)
          return
        }

        if (chatSession.getSessionGeneration(sessionId) !== generation) {
          console.warn('[Chat] sendQueue rejected: session generation mismatch', sessionId, generation)
          deferred.reject(new Error('Chat session was reset before send could start'))
          return
        }

        // ① 현재 pending 중 같은 sessionId의 나머지 항목 수거해 하나로 병합
        //    (쏟아진 메시지를 한 번의 LLM 호출로 처리)
        const pendingForSession = pendingQueuedSends.value.filter(
          item => item !== data && !item.cancelled && item.sessionId === sessionId,
        )
        let finalMessage = sendingMessage
        if (pendingForSession.length > 0) {
          const allMessages = [sendingMessage, ...pendingForSession.map(p => p.sendingMessage)]
            .filter(Boolean)
          finalMessage = allMessages.length > 1
            ? allMessages.join('\n')
            : allMessages[0] ?? ''
          // 병합된 항목들은 조용히 완료 처리
          for (const item of pendingForSession) {
            item.cancelled = true
            item.deferred.resolve()
          }
        }

        try {
          await performSend(finalMessage, options, generation, sessionId)
          deferred.resolve()
        }
        catch (error) {
          console.error('[Chat] performSend error inside sendQueue:', error)
          deferred.reject(error)
        }

        // ② LLM 완료 후 cooldown — 다음 큐 항목 처리 전 대기 (VITE_CHAT_COOLDOWN_MS)
        if (chatCooldownMs > 0)
          await new Promise<void>(resolve => setTimeout(resolve, chatCooldownMs))
      },
    ],
  })

  sendQueue.on('enqueue', (queuedSend) => {
    pendingQueuedSends.value = [...pendingQueuedSends.value, queuedSend]
  })

  sendQueue.on('dequeue', (queuedSend) => {
    pendingQueuedSends.value = pendingQueuedSends.value.filter(item => item !== queuedSend)
  })

  async function performSend(
    sendingMessage: string,
    options: SendOptions,
    generation: number,
    sessionId: string,
  ) {
    if (sending.value) {
      return
    }

    if (!sendingMessage && !options.attachments?.length && !options.isAutoSpeak) {
      return
    }

    // auto-speak 시스템 컨텍스터 메시지 (LLM에게 자율 발화입을 알림)
    const autoSpeakContext = options.isAutoSpeak
      ? '[SYSTEM NOTE] The user has been idle for a while. DO NOT repeat your previous response. Say something new, change the topic, or ask a question to re-engage them.'
      : ''

    chatSession.ensureSession(sessionId)

    // Inject current datetime context before composing the message
    chatContext.ingestContextMessage(createDatetimeContext())

    const sendingCreatedAt = Date.now()
    // 터마다 새 turnToken 발급 → 이전 TTS의 scheduleAutoSpeak이 실행되더라도 토큰 불일치로 자동 무효화
    currentTurnToken.value = nanoid()

    const streamingMessageContext: ChatStreamEventContext = {
      sessionId,
      turnToken: currentTurnToken.value,
      message: { role: 'user', content: sendingMessage, createdAt: sendingCreatedAt, id: nanoid() },
      contexts: chatContext.getContextsSnapshot(),
      composedMessage: [],
      input: options.input,
    }

    const isStaleGeneration = () => chatSession.getSessionGeneration(sessionId) !== generation
    const shouldAbort = () => isStaleGeneration()
    if (shouldAbort())
      return

    sending.value = true

    const isForegroundSession = () => sessionId === activeSessionId.value

    const buildingMessage: StreamingAssistantMessage = { role: 'assistant', content: '', slices: [], tool_results: [], createdAt: Date.now(), id: nanoid() }

    const updateUI = () => {
      if (isForegroundSession()) {
        streamingMessage.value = JSON.parse(JSON.stringify(buildingMessage))
      }
    }

    updateUI()
    trackFirstMessage()

    try {
      currentSendingSessionId.value = sessionId
      await hooks.emitBeforeMessageComposedHooks(sendingMessage, streamingMessageContext)

      const contentParts: CommonContentPart[] = [{ type: 'text', text: sendingMessage }]

      if (options.attachments) {
        for (const attachment of options.attachments) {
          if (attachment.type === 'image') {
            contentParts.push({
              type: 'image_url',
              image_url: {
                url: `data:${attachment.mimeType};base64,${attachment.data}`,
              },
            })
          }
        }
      }

      const finalContent = contentParts.length > 1 ? contentParts : sendingMessage
      if (!streamingMessageContext.input) {
        streamingMessageContext.input = {
          type: 'input:text',
          data: {
            text: sendingMessage,
          },
        }
      }

      const isStaleGeneration = () => {
        const currentGeneration = chatSession.getSessionGeneration(sessionId)
        if (currentGeneration !== generation) {
          return true
        }
        return false
      }
      const shouldAbort = () => isStaleGeneration()

      if (shouldAbort())
        return

      // sessionMessages.value[sessionId]를 직접 뮤테이션 (캐시된 참조가 stale해지는 문제 방지)
      chatSession.appendSessionMessage(sessionId, { role: 'user', content: finalContent, createdAt: sendingCreatedAt, id: nanoid() })

      // LLM 호출용 메시지는 append 이후 최신 배열을 다시 읽음
      const sessionMessagesForSend = chatSession.getSessionMessages(sessionId)

      const categorizer = createStreamingCategorizer(activeProvider.value)
      let streamPosition = 0

      const parser = useLlmmarkerParser({
        onLiteral: async (literal) => {
          if (shouldAbort()) {
            return
          }

          categorizer.consume(literal)
          const speechOnly = categorizer.filterToSpeech(literal, streamPosition)

          if (typeof window !== 'undefined' && typeof (window as any).logTTS === 'function') {
            (window as any).logTTS(`[${new Date().toISOString()}] [CHAT_CATEGORIZER] literal: "${literal.replace(/\n/g, '\\n')}" -> speechOnly: "${speechOnly.replace(/\n/g, '\\n')}"\n`).catch((e: any) => console.error(e))
          }

          if (options.isAutoSpeak && speechOnly.trim() === '') {
            console.warn('[Chat Parser] AutoSpeak emitted token but filterToSpeech returned empty string! Literal:', literal)
          }

          streamPosition += literal.length

          if (speechOnly.trim()) {
            buildingMessage.content += speechOnly

            await hooks.emitTokenLiteralHooks(speechOnly, streamingMessageContext)

            const lastSlice = buildingMessage.slices.at(-1)
            if (lastSlice?.type === 'text') {
              lastSlice.text += speechOnly
            }
            else {
              buildingMessage.slices.push({
                type: 'text',
                text: speechOnly,
              })
            }
            updateUI()
          }
        },
        onSpecial: async (special) => {
          if (shouldAbort())
            return

          await hooks.emitTokenSpecialHooks(special, streamingMessageContext)
        },
        onEnd: async (fullText) => {
          if (isStaleGeneration())
            return

          const finalCategorization = categorizeResponse(fullText, activeProvider.value)

          buildingMessage.categorization = {
            speech: finalCategorization.speech,
            reasoning: finalCategorization.reasoning,
          }
          updateUI()
        },
        minLiteralEmitLength: 24,
      })

      const toolCallQueue = createQueue<ChatSlices>({
        handlers: [
          async (ctx) => {
            if (shouldAbort())
              return
            if (ctx.data.type === 'tool-call') {
              buildingMessage.slices.push(ctx.data)
              updateUI()
              return
            }

            if (ctx.data.type === 'tool-call-result') {
              buildingMessage.tool_results.push(ctx.data)
              updateUI()
            }
          },
        ],
      })

      let newMessages = sessionMessagesForSend.map((msg) => {
        const { context: _context, id: _id, ...withoutContext } = msg
        const rawMessage = toRaw(withoutContext)

        if (rawMessage.role === 'assistant') {
          const { slices: _slices, tool_results, categorization: _categorization, ...rest } = rawMessage as ChatAssistantMessage
          return {
            ...toRaw(rest),
            tool_results: toRaw(tool_results),
          }
        }

        return rawMessage
      })

      const contextsSnapshot = chatContext.getContextsSnapshot()
      // Disabled context snapshot injection per user request (temporary bypass)
      if (false && Object.keys(contextsSnapshot).length > 0) {
        const system = newMessages.slice(0, 1)
        const afterSystem = newMessages.slice(1, newMessages.length)

        newMessages = [
          ...system,
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: ''
                  + 'These are the contextual information retrieved or on-demand updated from other modules, you may use them as context for chat, or reference of the next action, tool call, etc.:\n'
                  + `${Object.entries(contextsSnapshot).map(([key, value]) => `Module ${key}: ${JSON.stringify(value)}`).join('\n')}\n`,
              },
            ],
          },
          ...afterSystem,
        ]
      }

      if (options.isAutoSpeak && autoSpeakContext && newMessages.length > 0) {
        let lastMsg = newMessages[newMessages.length - 1]

        // If the last message is NOT a user message (e.g. assistant), force append a new user message for context
        if (lastMsg.role !== 'user') {
          console.info('[Chat] Last message is not user; appending new user message for AutoSpeak context')
          newMessages.push({ role: 'user', content: '' } as unknown as Message)
          lastMsg = newMessages[newMessages.length - 1]
        }

        const isContentEmpty = !lastMsg.content
          || lastMsg.content === ''
          || (Array.isArray(lastMsg.content) && lastMsg.content.length === 1 && lastMsg.content[0]?.type === 'text' && lastMsg.content[0].text === '')
          || (Array.isArray(lastMsg.content) && lastMsg.content.length === 0)

        if (isContentEmpty) {
          lastMsg.content = autoSpeakContext
          console.info('[Chat] Successfully injected isAutoSpeak context into lastMsg')
        } else {
          console.warn('[Chat] Failed to inject AutoSpeak: content was not empty!', lastMsg.content)
        }
      }

      streamingMessageContext.composedMessage = newMessages as Message[]

      await hooks.emitAfterMessageComposedHooks(sendingMessage, streamingMessageContext)
      await hooks.emitBeforeSendHooks(sendingMessage, streamingMessageContext)

      let fullText = ''
      const headers = (options.providerConfig?.headers || {}) as Record<string, string>

      if (shouldAbort()) {
        console.warn('[Chat] Aborted before LLM stream (stale generation)')
        return
      }

      const promptNode = chatSession.getPromptNode(options.promptOptions) as Message
      console.info('[Chat] Starting LLM stream for provider:', options.chatProvider)

      try {
        await llmStore.stream(options.model, options.chatProvider, promptNode, newMessages as Message[], {
          headers,
          tools: options.tools,
          onStreamEvent: async (event: StreamEvent) => {
            switch (event.type) {
              case 'tool-call':
                toolCallQueue.enqueue({
                  type: 'tool-call',
                  toolCall: event,
                })

                break
              case 'tool-result':
                toolCallQueue.enqueue({
                  type: 'tool-call-result',
                  id: event.toolCallId,
                  result: event.result,
                })

                break
              case 'text-delta':
                fullText += event.text
                if (typeof window !== 'undefined' && typeof (window as any).logTTS === 'function') {
                  (window as any).logTTS(`[${new Date().toISOString()}] [LLM_STREAM] text-delta: "${event.text.replace(/\n/g, '\\n')}"\n`).catch((e: any) => console.error(e))
                }
                await parser.consume(event.text)
                break
              case 'finish':
                break
              case 'error':
                throw event.error ?? new Error('Stream error')
            }
          },
        })
      }
      finally {
        // ALWAYS flush remaining parser buffers (specifically sentences <24 chars) to the TTS intent.
        // And ensure the intent is properly ended so `isProcessing` doesn't leak forever.
        try {
          await parser.end()
          await hooks.emitStreamEndHooks(streamingMessageContext)
          await hooks.emitAssistantResponseEndHooks(fullText, streamingMessageContext)
        }
        catch (finalizeError) {
          console.warn('[Chat] Error while finalizing stream processing:', finalizeError)
        }
      }



      await hooks.emitAfterSendHooks(sendingMessage, streamingMessageContext)
      await hooks.emitAssistantMessageHooks({ ...buildingMessage }, fullText, streamingMessageContext)
      await hooks.emitChatTurnCompleteHooks({
        output: { ...buildingMessage },
        outputText: fullText,
        toolCalls: sessionMessagesForSend.filter(msg => msg.role === 'tool') as ToolMessage[],
      }, streamingMessageContext)

      if (isForegroundSession()) {
        streamingMessage.value = { role: 'assistant', content: '', slices: [], tool_results: [] }
      }
    }
    catch (error) {
      console.error('Error sending message:', error)
      throw error
    }
    finally {
      sending.value = false
    }
  }

  async function ingest(
    sendingMessage: string,
    options: SendOptions,
    targetSessionId?: string,
  ) {
    const sessionId = targetSessionId || activeSessionId.value
    const generation = chatSession.getSessionGeneration(sessionId)

    return new Promise<void>((resolve, reject) => {
      sendQueue.enqueue({
        sendingMessage,
        options,
        generation,
        sessionId,
        deferred: { resolve, reject },
      })
    })
  }

  async function ingestOnFork(
    sendingMessage: string,
    options: SendOptions,
    forkOptions?: ForkOptions,
  ) {
    const baseSessionId = forkOptions?.fromSessionId ?? activeSessionId.value
    if (!forkOptions)
      return ingest(sendingMessage, options, baseSessionId)

    const forkSessionId = await chatSession.forkSession({
      fromSessionId: baseSessionId,
      atIndex: forkOptions.atIndex,
      reason: forkOptions.reason,
      hidden: forkOptions.hidden,
    })
    return ingest(sendingMessage, options, forkSessionId || baseSessionId)
  }

  function cancelPendingSends(sessionId?: string) {
    for (const queued of pendingQueuedSends.value) {
      if (sessionId && queued.sessionId !== sessionId)
        continue

      queued.cancelled = true
      queued.deferred.reject(new Error('Chat session was reset before send could start'))
    }

    pendingQueuedSends.value = sessionId
      ? pendingQueuedSends.value.filter(item => item.sessionId !== sessionId)
      : []
  }

  async function scheduleAutoSpeak(token: string, delayMs: number, sessionId?: string) {
    await new Promise<void>(resolve => setTimeout(resolve, delayMs))
    // delayMs 후 현재 토큰이 일치하는 경우만 auto-speak 트리거
    if (currentTurnToken.value === token) {
      // 발동 전에 토큰을 갱신 → auto-speak이 만든 TTS가 끝나도 재발화 방지 (무한루프 차단)
      currentTurnToken.value = nanoid()
      await hooks.emitAutoSpeakHooks(sessionId)
    }
  }

  return {
    sending,
    currentSendingSessionId,

    discoverToolsCompatibility: llmStore.discoverToolsCompatibility,

    ingest,
    ingestOnFork,
    cancelPendingSends,
    scheduleAutoSpeak,
    currentTurnToken,

    clearHooks: hooks.clearHooks,

    emitBeforeMessageComposedHooks: hooks.emitBeforeMessageComposedHooks,
    emitAfterMessageComposedHooks: hooks.emitAfterMessageComposedHooks,
    emitBeforeSendHooks: hooks.emitBeforeSendHooks,
    emitAfterSendHooks: hooks.emitAfterSendHooks,
    emitTokenLiteralHooks: hooks.emitTokenLiteralHooks,
    emitTokenSpecialHooks: hooks.emitTokenSpecialHooks,
    emitStreamEndHooks: hooks.emitStreamEndHooks,
    emitAssistantResponseEndHooks: hooks.emitAssistantResponseEndHooks,
    emitAssistantMessageHooks: hooks.emitAssistantMessageHooks,
    emitChatTurnCompleteHooks: hooks.emitChatTurnCompleteHooks,
    emitAutoSpeakHooks: hooks.emitAutoSpeakHooks,

    onBeforeMessageComposed: hooks.onBeforeMessageComposed,
    onAfterMessageComposed: hooks.onAfterMessageComposed,
    onBeforeSend: hooks.onBeforeSend,
    onAfterSend: hooks.onAfterSend,
    onTokenLiteral: hooks.onTokenLiteral,
    onTokenSpecial: hooks.onTokenSpecial,
    onStreamEnd: hooks.onStreamEnd,
    onAssistantResponseEnd: hooks.onAssistantResponseEnd,
    onAssistantMessage: hooks.onAssistantMessage,
    onAutoSpeak: hooks.onAutoSpeak,
    onChatTurnComplete: hooks.onChatTurnComplete,
  }
})
