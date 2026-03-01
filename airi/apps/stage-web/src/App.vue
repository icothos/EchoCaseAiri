<script setup lang="ts">
import { OnboardingDialog, ToasterRoot } from '@proj-airi/stage-ui/components'
import { useSharedAnalyticsStore } from '@proj-airi/stage-ui/stores/analytics'
import { useCharacterOrchestratorStore } from '@proj-airi/stage-ui/stores/character'
import { useChatContextStore } from '@proj-airi/stage-ui/stores/chat/context-store'
import { useChatOrchestratorStore } from '@proj-airi/stage-ui/stores/chat'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useDisplayModelsStore } from '@proj-airi/stage-ui/stores/display-models'
import { useModsServerChannelStore } from '@proj-airi/stage-ui/stores/mods/api/channel-server'
import { useContextBridgeStore } from '@proj-airi/stage-ui/stores/mods/api/context-bridge'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { useOnboardingStore } from '@proj-airi/stage-ui/stores/onboarding'
import { useSettings } from '@proj-airi/stage-ui/stores/settings'
import { mountEchoMemory } from '@proj-airi/echo-memory'
import type { EchoMemoryInstance } from '@proj-airi/echo-memory'
import { useTheme } from '@proj-airi/ui'
import { StageTransitionGroup } from '@proj-airi/ui-transitions'
import { storeToRefs } from 'pinia'
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterView } from 'vue-router'
import { toast, Toaster } from 'vue-sonner'

import PerformanceOverlay from './components/Devtools/PerformanceOverlay.vue'

import { usePWAStore } from './stores/pwa'

usePWAStore()

const contextBridgeStore = useContextBridgeStore()
const i18n = useI18n()
const displayModelsStore = useDisplayModelsStore()
const settingsStore = useSettings()
const settings = storeToRefs(settingsStore)
const onboardingStore = useOnboardingStore()
const chatSessionStore = useChatSessionStore()
const serverChannelStore = useModsServerChannelStore()
const chatOrchestratorStore = useChatOrchestratorStore()
const chatContextStore = useChatContextStore()
const characterOrchestratorStore = useCharacterOrchestratorStore()
const { shouldShowSetup } = storeToRefs(onboardingStore)
const { isDark } = useTheme()
const cardStore = useAiriCardStore()
const analyticsStore = useSharedAnalyticsStore()

let echoMemory: EchoMemoryInstance | null = null

const primaryColor = computed(() => {
  return isDark.value
    ? `color-mix(in srgb, oklch(95% var(--chromatic-chroma-900) calc(var(--chromatic-hue) + ${0})) 70%, oklch(50% 0 360))`
    : `color-mix(in srgb, oklch(95% var(--chromatic-chroma-900) calc(var(--chromatic-hue) + ${0})) 90%, oklch(90% 0 360))`
})

const secondaryColor = computed(() => {
  return isDark.value
    ? `color-mix(in srgb, oklch(95% var(--chromatic-chroma-900) calc(var(--chromatic-hue) + ${180})) 70%, oklch(50% 0 360))`
    : `color-mix(in srgb, oklch(95% var(--chromatic-chroma-900) calc(var(--chromatic-hue) + ${180})) 90%, oklch(90% 0 360))`
})

const tertiaryColor = computed(() => {
  return isDark.value
    ? `color-mix(in srgb, oklch(95% var(--chromatic-chroma-900) calc(var(--chromatic-hue) + ${60})) 70%, oklch(50% 0 360))`
    : `color-mix(in srgb, oklch(95% var(--chromatic-chroma-900) calc(var(--chromatic-hue) + ${60})) 90%, oklch(90% 0 360))`
})

const colors = computed(() => {
  return [primaryColor.value, secondaryColor.value, tertiaryColor.value, isDark.value ? '#121212' : '#FFFFFF']
})

watch(settings.language, () => {
  i18n.locale.value = settings.language.value
})

watch(settings.themeColorsHue, () => {
  document.documentElement.style.setProperty('--chromatic-hue', settings.themeColorsHue.value.toString())
}, { immediate: true })

watch(settings.themeColorsHueDynamic, () => {
  document.documentElement.classList.toggle('dynamic-hue', settings.themeColorsHueDynamic.value)
}, { immediate: true })

// Initialize first-time setup check when app mounts
onMounted(async () => {
  analyticsStore.initialize()
  cardStore.initialize()

  onboardingStore.initializeSetupCheck()

  await chatSessionStore.initialize()
  await serverChannelStore.initialize({ possibleEvents: ['ui:configure'] }).catch(err => console.error('Failed to initialize Mods Server Channel in App.vue:', err))
  await contextBridgeStore.initialize()
  characterOrchestratorStore.initialize()

  // ── echo-memory 마운트 ─────────────────────────────────────────────
  // .env.local에서 설정 읽기. VITE_BOUNCER_BASE_URL 없으면 echo-memory 비활성화
  const bouncerBaseUrl = import.meta.env.VITE_BOUNCER_BASE_URL
  if (bouncerBaseUrl) {
    const geminiBase = import.meta.env.VITE_GEMINI_BASE_URL
      ?? 'https://generativelanguage.googleapis.com/v1beta/openai/'
    const geminiKey = import.meta.env.VITE_GEMINI_API_KEY

    // Summarizer용 LLM (미설정 시 Bouncer 공유)
    const summarizerBaseUrl = import.meta.env.VITE_SUMMARIZER_BASE_URL
    const summarizerModel = import.meta.env.VITE_SUMMARIZER_MODEL
    const summarizerHasGemini = !summarizerBaseUrl && geminiKey

    // Progress Summarizer용 LLM (미설정 시 Summarizer → Bouncer 폴백)
    const progressBaseUrl = import.meta.env.VITE_PROGRESS_BASE_URL
    const progressModel = import.meta.env.VITE_PROGRESS_MODEL
    const progressHasGemini = !progressBaseUrl && geminiKey

    echoMemory = mountEchoMemory(
      serverChannelStore,
      chatOrchestratorStore,
      chatContextStore,
      {
        bouncer: {
          baseUrl: bouncerBaseUrl,
          apiKey: import.meta.env.VITE_BOUNCER_API_KEY || geminiKey || undefined,
          model: import.meta.env.VITE_BOUNCER_MODEL ?? 'local-model',
          timeoutMs: Number(import.meta.env.VITE_BOUNCER_TIMEOUT_MS ?? 5000),
        },
        // Summarizer LLM: VITE_SUMMARIZER_BASE_URL 설정 시 독립 엔드포인트,
        // 없고 Gemini 키가 있으면 Gemini 사용, 둘 다 없으면 Bouncer 공유
        ...(summarizerBaseUrl
          ? {
              summarizerLLM: {
                baseUrl: summarizerBaseUrl,
                apiKey: import.meta.env.VITE_SUMMARIZER_API_KEY || geminiKey || undefined,
                model: summarizerModel ?? 'local-model',
              },
            }
          : summarizerHasGemini
            ? {
                summarizerLLM: {
                  baseUrl: `${geminiBase.replace(/\/$/, '')}/`,
                  apiKey: geminiKey,
                  model: summarizerModel ?? import.meta.env.VITE_ACTIVE_MODEL ?? 'gemini-2.0-flash-lite',
                },
              }
            : {}),
        // Progress LLM: 동일 폴백 체인
        ...(progressBaseUrl
          ? {
              progressLLM: {
                baseUrl: progressBaseUrl,
                apiKey: import.meta.env.VITE_PROGRESS_API_KEY || geminiKey || undefined,
                model: progressModel ?? 'local-model',
              },
            }
          : progressHasGemini
            ? {
                progressLLM: {
                  baseUrl: `${geminiBase.replace(/\/$/, '')}/`,
                  apiKey: geminiKey,
                  model: progressModel ?? import.meta.env.VITE_ACTIVE_MODEL ?? 'gemini-2.0-flash-lite',
                },
              }
            : {}),
      },
    )
    // eslint-disable-next-line no-console
    console.debug('[echo-memory] mounted', echoMemory)
  }
  else {
    // eslint-disable-next-line no-console
    console.debug('[echo-memory] 비활성화 (VITE_BOUNCER_BASE_URL 미설정)')
  }
  // ────────────────────────────────────────────────────────────────────

  await displayModelsStore.loadDisplayModelsFromIndexedDB()
  await settingsStore.initializeStageModel()
})

onUnmounted(() => {
  echoMemory?.dispose()
  contextBridgeStore.dispose()
})

// Handle first-time setup events
function handleSetupConfigured() {
  onboardingStore.markSetupCompleted()
}

function handleSetupSkipped() {
  onboardingStore.markSetupSkipped()
}
</script>

<template>
  <StageTransitionGroup
    :primary-color="primaryColor"
    :secondary-color="secondaryColor"
    :tertiary-color="tertiaryColor"
    :colors="colors"
    :z-index="100"
    :disable-transitions="settings.disableTransitions.value"
    :use-page-specific-transitions="settings.usePageSpecificTransitions.value"
  >
    <RouterView v-slot="{ Component }">
      <KeepAlive :include="['IndexScenePage', 'StageScenePage']">
        <component :is="Component" />
      </KeepAlive>
    </RouterView>
  </StageTransitionGroup>

  <ToasterRoot @close="id => toast.dismiss(id)">
    <Toaster />
  </ToasterRoot>

  <!-- First Time Setup Dialog -->
  <OnboardingDialog
    v-model="shouldShowSetup"
    @configured="handleSetupConfigured"
    @skipped="handleSetupSkipped"
  />

  <PerformanceOverlay />
</template>

<style>
/* We need this to properly animate the CSS variable */
@property --chromatic-hue {
  syntax: '<number>';
  initial-value: 0;
  inherits: true;
}

@keyframes hue-anim {
  from {
    --chromatic-hue: 0;
  }
  to {
    --chromatic-hue: 360;
  }
}

.dynamic-hue {
  animation: hue-anim 10s linear infinite;
}
</style>
