import type { ToolMessage } from '@xsai/shared-chat'

import type { ChatStreamEventContext, StreamingAssistantMessage } from '../../types/chat'

export interface ChatHookRegistry {
  onBeforeMessageComposed: (cb: (message: string, context: Omit<ChatStreamEventContext, 'composedMessage'>) => Promise<void>) => () => void
  onAfterMessageComposed: (cb: (message: string, context: ChatStreamEventContext) => Promise<void>) => () => void
  onBeforeSend: (cb: (message: string, context: ChatStreamEventContext) => Promise<void>) => () => void
  onAfterSend: (cb: (message: string, context: ChatStreamEventContext) => Promise<void>) => () => void
  onTokenLiteral: (cb: (literal: string, context: ChatStreamEventContext) => Promise<void>) => () => void
  onTokenSpecial: (cb: (special: string, context: ChatStreamEventContext) => Promise<void>) => () => void
  onStreamEnd: (cb: (context: ChatStreamEventContext) => Promise<void>) => () => void
  onAssistantResponseEnd: (cb: (message: string, context: ChatStreamEventContext) => Promise<void>) => () => void
  onAssistantMessage: (cb: (message: StreamingAssistantMessage, messageText: string, context: ChatStreamEventContext) => Promise<void>) => () => void
  onChatTurnComplete: (cb: (chat: { output: StreamingAssistantMessage, outputText: string, toolCalls: ToolMessage[] }, context: ChatStreamEventContext) => Promise<void>) => () => void
  onAutoSpeak: (cb: (sessionId?: string) => Promise<void>) => () => void
  onAssistantSpeechComplete: (cb: (payload: { sessionId: string; isInterrupted: boolean; playedText: string }) => Promise<void>) => () => void
  emitBeforeMessageComposedHooks: (message: string, context: Omit<ChatStreamEventContext, 'composedMessage'>) => Promise<void>
  emitAfterMessageComposedHooks: (message: string, context: ChatStreamEventContext) => Promise<void>
  emitBeforeSendHooks: (message: string, context: ChatStreamEventContext) => Promise<void>
  emitAfterSendHooks: (message: string, context: ChatStreamEventContext) => Promise<void>
  emitTokenLiteralHooks: (literal: string, context: ChatStreamEventContext) => Promise<void>
  emitTokenSpecialHooks: (special: string, context: ChatStreamEventContext) => Promise<void>
  emitStreamEndHooks: (context: ChatStreamEventContext) => Promise<void>
  emitAssistantResponseEndHooks: (message: string, context: ChatStreamEventContext) => Promise<void>
  emitAssistantMessageHooks: (message: StreamingAssistantMessage, messageText: string, context: ChatStreamEventContext) => Promise<void>
  emitChatTurnCompleteHooks: (chat: { output: StreamingAssistantMessage, outputText: string, toolCalls: ToolMessage[] }, context: ChatStreamEventContext) => Promise<void>
  emitAutoSpeakHooks: (sessionId?: string) => Promise<void>
  emitAssistantSpeechCompleteHooks: (payload: { sessionId: string; isInterrupted: boolean; playedText: string }) => Promise<void>
  clearHooks: () => void
}

export function createChatHooks(): ChatHookRegistry {
  const onBeforeMessageComposedHooks: Array<(message: string, context: Omit<ChatStreamEventContext, 'composedMessage'>) => Promise<void>> = []
  const onAfterMessageComposedHooks: Array<(message: string, context: ChatStreamEventContext) => Promise<void>> = []
  const onBeforeSendHooks: Array<(message: string, context: ChatStreamEventContext) => Promise<void>> = []
  const onAfterSendHooks: Array<(message: string, context: ChatStreamEventContext) => Promise<void>> = []
  const onTokenLiteralHooks: Array<(literal: string, context: ChatStreamEventContext) => Promise<void>> = []
  const onTokenSpecialHooks: Array<(special: string, context: ChatStreamEventContext) => Promise<void>> = []
  const onStreamEndHooks: Array<(context: ChatStreamEventContext) => Promise<void>> = []
  const onAssistantResponseEndHooks: Array<(message: string, context: ChatStreamEventContext) => Promise<void>> = []
  const onAssistantMessageHooks: Array<(message: StreamingAssistantMessage, messageText: string, context: ChatStreamEventContext) => Promise<void>> = []
  const onChatTurnCompleteHooks: Array<(chat: { output: StreamingAssistantMessage, outputText: string, toolCalls: ToolMessage[] }, context: ChatStreamEventContext) => Promise<void>> = []
  const onAutoSpeakHooks: Array<(sessionId?: string) => Promise<void>> = []
  const onAssistantSpeechCompleteHooks: Array<(payload: { sessionId: string; isInterrupted: boolean; playedText: string }) => Promise<void>> = []

  function onBeforeMessageComposed(cb: (message: string, context: Omit<ChatStreamEventContext, 'composedMessage'>) => Promise<void>) {
    onBeforeMessageComposedHooks.push(cb)
    return () => {
      const index = onBeforeMessageComposedHooks.indexOf(cb)
      if (index >= 0)
        onBeforeMessageComposedHooks.splice(index, 1)
    }
  }

  function onAfterMessageComposed(cb: (message: string, context: ChatStreamEventContext) => Promise<void>) {
    onAfterMessageComposedHooks.push(cb)
    return () => {
      const index = onAfterMessageComposedHooks.indexOf(cb)
      if (index >= 0)
        onAfterMessageComposedHooks.splice(index, 1)
    }
  }

  function onBeforeSend(cb: (message: string, context: ChatStreamEventContext) => Promise<void>) {
    onBeforeSendHooks.push(cb)
    return () => {
      const index = onBeforeSendHooks.indexOf(cb)
      if (index >= 0)
        onBeforeSendHooks.splice(index, 1)
    }
  }

  function onAfterSend(cb: (message: string, context: ChatStreamEventContext) => Promise<void>) {
    onAfterSendHooks.push(cb)
    return () => {
      const index = onAfterSendHooks.indexOf(cb)
      if (index >= 0)
        onAfterSendHooks.splice(index, 1)
    }
  }

  function onTokenLiteral(cb: (literal: string, context: ChatStreamEventContext) => Promise<void>) {
    onTokenLiteralHooks.push(cb)
    return () => {
      const index = onTokenLiteralHooks.indexOf(cb)
      if (index >= 0)
        onTokenLiteralHooks.splice(index, 1)
    }
  }

  function onTokenSpecial(cb: (special: string, context: ChatStreamEventContext) => Promise<void>) {
    onTokenSpecialHooks.push(cb)
    return () => {
      const index = onTokenSpecialHooks.indexOf(cb)
      if (index >= 0)
        onTokenSpecialHooks.splice(index, 1)
    }
  }

  function onStreamEnd(cb: (context: ChatStreamEventContext) => Promise<void>) {
    onStreamEndHooks.push(cb)
    return () => {
      const index = onStreamEndHooks.indexOf(cb)
      if (index >= 0)
        onStreamEndHooks.splice(index, 1)
    }
  }

  function onAssistantResponseEnd(cb: (message: string, context: ChatStreamEventContext) => Promise<void>) {
    onAssistantResponseEndHooks.push(cb)
    return () => {
      const index = onAssistantResponseEndHooks.indexOf(cb)
      if (index >= 0)
        onAssistantResponseEndHooks.splice(index, 1)
    }
  }

  function onAssistantMessage(cb: (message: StreamingAssistantMessage, messageText: string, context: ChatStreamEventContext) => Promise<void>) {
    onAssistantMessageHooks.push(cb)
    return () => {
      const index = onAssistantMessageHooks.indexOf(cb)
      if (index >= 0)
        onAssistantMessageHooks.splice(index, 1)
    }
  }

  function onChatTurnComplete(cb: (chat: { output: StreamingAssistantMessage, outputText: string, toolCalls: ToolMessage[] }, context: ChatStreamEventContext) => Promise<void>) {
    onChatTurnCompleteHooks.push(cb)
    return () => {
      const index = onChatTurnCompleteHooks.indexOf(cb)
      if (index >= 0)
        onChatTurnCompleteHooks.splice(index, 1)
    }
  }

  function onAutoSpeak(cb: (sessionId?: string) => Promise<void>) {
    onAutoSpeakHooks.push(cb)
    return () => {
      const index = onAutoSpeakHooks.indexOf(cb)
      if (index >= 0)
        onAutoSpeakHooks.splice(index, 1)
    }
  }

  function onAssistantSpeechComplete(cb: (payload: { sessionId: string; isInterrupted: boolean; playedText: string }) => Promise<void>) {
    onAssistantSpeechCompleteHooks.push(cb)
    return () => {
      const index = onAssistantSpeechCompleteHooks.indexOf(cb)
      if (index >= 0)
        onAssistantSpeechCompleteHooks.splice(index, 1)
    }
  }

  function clearHooks() {
    onBeforeMessageComposedHooks.length = 0
    onAfterMessageComposedHooks.length = 0
    onBeforeSendHooks.length = 0
    onAfterSendHooks.length = 0
    onTokenLiteralHooks.length = 0
    onTokenSpecialHooks.length = 0
    onStreamEndHooks.length = 0
    onAssistantResponseEndHooks.length = 0
    onAssistantMessageHooks.length = 0
    onChatTurnCompleteHooks.length = 0
    onAutoSpeakHooks.length = 0
    onAssistantSpeechCompleteHooks.length = 0
  }

  async function emitBeforeMessageComposedHooks(message: string, context: Omit<ChatStreamEventContext, 'composedMessage'>) {
    for (const hook of onBeforeMessageComposedHooks)
      await hook(message, context)
  }

  async function emitAfterMessageComposedHooks(message: string, context: ChatStreamEventContext) {
    for (const hook of onAfterMessageComposedHooks)
      await hook(message, context)
  }

  async function emitBeforeSendHooks(message: string, context: ChatStreamEventContext) {
    for (const hook of onBeforeSendHooks)
      await hook(message, context)
  }

  async function emitAfterSendHooks(message: string, context: ChatStreamEventContext) {
    for (const hook of onAfterSendHooks)
      await hook(message, context)
  }

  async function emitTokenLiteralHooks(literal: string, context: ChatStreamEventContext) {
    for (const hook of onTokenLiteralHooks)
      await hook(literal, context)
  }

  async function emitTokenSpecialHooks(special: string, context: ChatStreamEventContext) {
    for (const hook of onTokenSpecialHooks)
      await hook(special, context)
  }

  async function emitStreamEndHooks(context: ChatStreamEventContext) {
    for (const hook of onStreamEndHooks)
      await hook(context)
  }

  async function emitAssistantResponseEndHooks(message: string, context: ChatStreamEventContext) {
    for (const hook of onAssistantResponseEndHooks)
      await hook(message, context)
  }

  async function emitAssistantMessageHooks(message: StreamingAssistantMessage, messageText: string, context: ChatStreamEventContext) {
    for (const hook of onAssistantMessageHooks)
      await hook(message, messageText, context)
  }

  async function emitChatTurnCompleteHooks(chat: { output: StreamingAssistantMessage, outputText: string, toolCalls: ToolMessage[] }, context: ChatStreamEventContext) {
    for (const hook of onChatTurnCompleteHooks)
      await hook(chat, context)
  }

  async function emitAutoSpeakHooks(sessionId?: string) {
    for (const hook of onAutoSpeakHooks)
      await hook(sessionId)
  }

  async function emitAssistantSpeechCompleteHooks(payload: { sessionId: string; isInterrupted: boolean; playedText: string }) {
    console.info(`[ChatHooks] emitAssistantSpeechCompleteHooks called with payload:`, payload, `(Listeners count: ${onAssistantSpeechCompleteHooks.length})`)
    for (const hook of onAssistantSpeechCompleteHooks)
      await hook(payload)
  }

  return {
    onBeforeMessageComposed,
    onAfterMessageComposed,
    onBeforeSend,
    onAfterSend,
    onTokenLiteral,
    onTokenSpecial,
    onStreamEnd,
    onAssistantResponseEnd,
    onAssistantMessage,
    onChatTurnComplete,
    onAutoSpeak,
    onAssistantSpeechComplete,
    emitBeforeMessageComposedHooks,
    emitAfterMessageComposedHooks,
    emitBeforeSendHooks,
    emitAfterSendHooks,
    emitTokenLiteralHooks,
    emitTokenSpecialHooks,
    emitStreamEndHooks,
    emitAssistantResponseEndHooks,
    emitAssistantMessageHooks,
    emitChatTurnCompleteHooks,
    emitAutoSpeakHooks,
    emitAssistantSpeechCompleteHooks,
    clearHooks,
  }
}
