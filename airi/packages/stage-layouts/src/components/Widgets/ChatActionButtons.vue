<script setup lang="ts">
import { useChatMaintenanceStore } from '@proj-airi/stage-ui/stores/chat/maintenance'
import { useTheme } from '@proj-airi/ui'
import { ref } from 'vue'

import { BackgroundDialogPicker } from '../Backgrounds'

const { cleanupMessages, resetAllSessions } = useChatMaintenanceStore()
const { isDark, toggleDark } = useTheme()

const backgroundDialogOpen = ref(false)
const isResetting = ref(false)

async function handleResetAllSessions() {
  if (!confirm('모든 채팅 기록을 DB에서 완전히 삭제할까요? 이 작업은 되돌릴 수 없습니다.'))
    return
  isResetting.value = true
  try {
    await resetAllSessions()
  }
  finally {
    isResetting.value = false
  }
}
</script>

<template>
  <BackgroundDialogPicker v-model="backgroundDialogOpen" />
  <div absolute bottom--8 right-0 flex gap-2>
    <button
      class="max-h-[10lh] min-h-[1lh]"
      bg="neutral-100 dark:neutral-800"
      text="lg neutral-500 dark:neutral-400"
      hover:text="red-500 dark:red-400"
      flex items-center justify-center rounded-md p-2 outline-none
      transition-colors transition-transform active:scale-95
      title="현재 채팅 초기화"
      @click="cleanupMessages()"
    >
      <div class="i-solar:trash-bin-2-bold-duotone" />
    </button>

    <button
      class="max-h-[10lh] min-h-[1lh]"
      bg="neutral-100 dark:neutral-800"
      text="lg neutral-500 dark:neutral-400"
      hover:text="orange-500 dark:orange-400"
      flex items-center justify-center rounded-md p-2 outline-none
      transition-colors transition-transform active:scale-95
      title="DB 전체 초기화 (모든 채팅 삭제)"
      :disabled="isResetting"
      :op="isResetting ? '50' : '100'"
      @click="handleResetAllSessions()"
    >
      <div class="i-solar:database-bold-duotone" />
    </button>

    <button
      class="max-h-[10lh] min-h-[1lh]"
      bg="neutral-100 dark:neutral-800"
      text="lg neutral-500 dark:neutral-400"
      flex items-center justify-center rounded-md p-2 outline-none
      transition-colors transition-transform active:scale-95
      @click="() => toggleDark()"
    >
      <Transition name="fade" mode="out-in">
        <div v-if="isDark" i-solar:moon-bold />
        <div v-else i-solar:sun-2-bold />
      </Transition>
    </button>
    <button
      class="max-h-[10lh] min-h-[1lh]"
      bg="neutral-100 dark:neutral-800"
      text="lg neutral-500 dark:neutral-400"
      flex items-center justify-center rounded-md p-2 outline-none
      transition-colors transition-transform active:scale-95
      title="Background"
      @click="backgroundDialogOpen = true"
    >
      <div i-solar:gallery-wide-bold-duotone />
    </button>
  </div>
</template>

