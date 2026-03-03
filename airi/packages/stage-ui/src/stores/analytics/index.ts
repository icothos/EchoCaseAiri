import type { AboutBuildInfo } from '../../components/scenarios/about/types'

import { defineStore } from 'pinia'
import { ref } from 'vue'

import { useBuildInfo } from '../../composables'

export const useSharedAnalyticsStore = defineStore('analytics-shared', () => {
  const buildInfo = ref<AboutBuildInfo>(useBuildInfo())
  const isInitialized = ref(false)

  const appStartTime = ref<number | null>(null)
  const firstMessageTracked = ref(false)

  function initialize() {
    if (isInitialized.value)
      return

    appStartTime.value = Date.now()

    // Analytics removed

    isInitialized.value = true
  }

  function markFirstMessageTracked() {
    firstMessageTracked.value = true
  }

  return {
    buildInfo,
    appStartTime,
    firstMessageTracked,
    initialize,
    markFirstMessageTracked,
  }
})
