import type { StreamingAssistantMessage } from '../../types/chat'

import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useChatStreamStore = defineStore('chat-stream', () => {
  const streamingMessage = ref<StreamingAssistantMessage>({ role: 'assistant', content: '', slices: [], tool_results: [], createdAt: Date.now() })

  function beginStream() {
    streamingMessage.value = { role: 'assistant', content: '', slices: [], tool_results: [], createdAt: Date.now() }
  }

  function appendStreamLiteral(literal: string) {
    streamingMessage.value.content += literal

    const lastSlice = streamingMessage.value.slices.at(-1)
    if (lastSlice?.type === 'text') {
      lastSlice.text += literal
      return
    }

    streamingMessage.value.slices.push({
      type: 'text',
      text: literal,
    })
  }

  function finalizeStream(_fullText?: string) {
    streamingMessage.value = { role: 'assistant', content: '', slices: [], tool_results: [] }
  }

  function resetStream() {
    streamingMessage.value = { role: 'assistant', content: '', slices: [], tool_results: [] }
  }

  return {
    streamingMessage,
    beginStream,
    appendStreamLiteral,
    finalizeStream,
    resetStream,
  }
})
