<script setup lang="ts">
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { onMounted } from 'vue'

import InteractiveArea from '../components/InteractiveArea.vue'
import WindowTitleBar from '../components/Window/TitleBar.vue'

const chatSessionStore = useChatSessionStore()

// chat window에서만 session bus를 바인딩 → commitSpokenMessage 중복 호출 방지
onMounted(() => {
  chatSessionStore.bindSessionBus()
})
</script>

<template>
  <div h-full w-full pt="44px" overflow-y-scroll>
    <WindowTitleBar
      title="Chat"
      icon="i-solar:chat-line-bold"
    />
    <InteractiveArea
      class="interaction-area block"
      h-full w-full p-4 transition="opacity duration-250"
    />
  </div>
</template>

<route lang="yaml">
meta:
  layout: stage
</route>
