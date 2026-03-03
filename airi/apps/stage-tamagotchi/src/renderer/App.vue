<script setup lang="ts">
import type { EchoMemoryInstance } from '@proj-airi/echo-memory'

import { defineInvokeHandler } from '@moeru/eventa'
import { createLLMLogger, mountEchoMemory, setGlobalLLMLogger } from '@proj-airi/echo-memory'
import { useElectronEventaContext, useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { themeColorFromValue, useThemeColor } from '@proj-airi/stage-layouts/composables/theme-color'
import { ToasterRoot } from '@proj-airi/stage-ui/components'
import { useSharedAnalyticsStore } from '@proj-airi/stage-ui/stores/analytics'
import { useCharacterOrchestratorStore } from '@proj-airi/stage-ui/stores/character'
import { useChatOrchestratorStore } from '@proj-airi/stage-ui/stores/chat'
import { useChatContextStore } from '@proj-airi/stage-ui/stores/chat/context-store'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { usePluginHostInspectorStore } from '@proj-airi/stage-ui/stores/devtools/plugin-host-debug'
import { useDisplayModelsStore } from '@proj-airi/stage-ui/stores/display-models'
import { useModsServerChannelStore } from '@proj-airi/stage-ui/stores/mods/api/channel-server'
import { useContextBridgeStore } from '@proj-airi/stage-ui/stores/mods/api/context-bridge'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { useConsciousnessStore } from '@proj-airi/stage-ui/stores/modules/consciousness'
import { useOnboardingStore } from '@proj-airi/stage-ui/stores/onboarding'
import { usePerfTracerBridgeStore } from '@proj-airi/stage-ui/stores/perf-tracer-bridge'
import { listProvidersForPluginHost, shouldPublishPluginHostCapabilities } from '@proj-airi/stage-ui/stores/plugin-host-capabilities'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { useSettings } from '@proj-airi/stage-ui/stores/settings'
import { useTheme } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterView, useRoute, useRouter } from 'vue-router'
import { toast, Toaster } from 'vue-sonner'

import ResizeHandler from './components/ResizeHandler.vue'

import {
  electronGetServerChannelConfig,
  electronOpenSettings,
  electronPluginInspect,
  electronPluginList,
  electronPluginLoad,
  electronPluginLoadEnabled,
  electronPluginSetEnabled,
  electronPluginUnload,
  electronPluginUpdateCapability,
  electronStartTrackMousePosition,
  pluginProtocolListProviders,
  pluginProtocolListProvidersEventName,
} from '../shared/eventa'
import { useServerChannelSettingsStore } from './stores/settings/server-channel'

const { isDark: dark } = useTheme()
const i18n = useI18n()
const contextBridgeStore = useContextBridgeStore()
const displayModelsStore = useDisplayModelsStore()
const settingsStore = useSettings()
const { language, themeColorsHue, themeColorsHueDynamic } = storeToRefs(settingsStore)
const serverChannelSettingsStore = useServerChannelSettingsStore()
const onboardingStore = useOnboardingStore()
const router = useRouter()
const route = useRoute()
const cardStore = useAiriCardStore()
const chatSessionStore = useChatSessionStore()
const serverChannelStore = useModsServerChannelStore()
const chatOrchestratorStore = useChatOrchestratorStore()
const chatContextStore = useChatContextStore()
const characterOrchestratorStore = useCharacterOrchestratorStore()
const consciousnessStore = useConsciousnessStore()
const { activeProvider, activeModel } = storeToRefs(consciousnessStore)
const providersStore = useProvidersStore()
const analyticsStore = useSharedAnalyticsStore()
const pluginHostInspectorStore = usePluginHostInspectorStore()
usePerfTracerBridgeStore()

let echoMemory: EchoMemoryInstance | null = null

watch(language, () => {
  i18n.locale.value = language.value
})

const { updateThemeColor } = useThemeColor(themeColorFromValue({ light: 'rgb(255 255 255)', dark: 'rgb(18 18 18)' }))
watch(dark, () => updateThemeColor(), { immediate: true })
watch(route, () => updateThemeColor(), { immediate: true })
onMounted(() => updateThemeColor())

onMounted(async () => {
  const context = useElectronEventaContext()
  const getServerChannelConfig = useElectronEventaInvoke(electronGetServerChannelConfig)
  const listPlugins = useElectronEventaInvoke(electronPluginList)
  const setPluginEnabled = useElectronEventaInvoke(electronPluginSetEnabled)
  const loadEnabledPlugins = useElectronEventaInvoke(electronPluginLoadEnabled)
  const loadPlugin = useElectronEventaInvoke(electronPluginLoad)
  const unloadPlugin = useElectronEventaInvoke(electronPluginUnload)
  const inspectPluginHost = useElectronEventaInvoke(electronPluginInspect)

  // NOTICE: register plugin host bridge before long async startup work so devtools pages can use it immediately.
  pluginHostInspectorStore.setBridge({
    list: () => listPlugins(),
    setEnabled: payload => setPluginEnabled(payload),
    loadEnabled: () => loadEnabledPlugins(),
    load: payload => loadPlugin(payload),
    unload: payload => unloadPlugin(payload),
    inspect: () => inspectPluginHost(),
  })

  analyticsStore.initialize()
  cardStore.initialize()
  onboardingStore.initializeSetupCheck()

  await chatSessionStore.initialize()
  await displayModelsStore.loadDisplayModelsFromIndexedDB()
  await settingsStore.initializeStageModel()

  const serverChannelConfig = await getServerChannelConfig()
  serverChannelSettingsStore.websocketTlsConfig = serverChannelConfig.websocketTlsConfig

  await serverChannelStore.initialize({ possibleEvents: ['ui:configure'] }).catch(err => console.error('Failed to initialize Mods Server Channel in App.vue:', err))
  await contextBridgeStore.initialize()
  characterOrchestratorStore.initialize()

  // ── echo-memory 마운트 ─────────────────────────────────────────────
  console.log('[App.vue] .env dump:', {
    bouncerBase: import.meta.env.VITE_BOUNCER_BASE_URL,
    geminiKey: import.meta.env.VITE_GEMINI_API_KEY ? 'EXISTS' : 'MISSING',
  })

  // echo-memory LLM 로깅을 llm.log로 연동
  const echoLogger = createLLMLogger({
    prefix: '[echo-memory]',
    onLog: (entry) => {
      if (typeof (window as any).logLLM === 'function') {
        const ts = new Date(entry.timestamp).toISOString().slice(11, 23)
        const dir = entry.direction === 'REQUEST' ? 'REQ' : 'RES'
        const dur = entry.durationMs !== undefined ? ` (${entry.durationMs}ms)` : ''
        const model = entry.model ? ` [${entry.model}]` : ''
        const cleanContent = entry.content.replace(/\r?\n/g, ' ')
        const preview = entry.inputPreview ? ` | input: ${entry.inputPreview.slice(0, 60).replace(/\r?\n/g, ' ')}` : ''
        
        const line = `[echo-memory] ${ts} [${entry.role}]${model} ${dir}${dur}${preview} - ${cleanContent}`
        ;(window as any).logLLM(line).catch(() => {})
      }
    }
  })
  setGlobalLLMLogger(echoLogger)

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
        autoSpeak: undefined,
      },
    )
    console.info('[echo-memory] mounted (tamagotchi)', echoMemory)
  }
  else {
    console.info('[echo-memory] 비활성화 (VITE_BOUNCER_BASE_URL 미설정)')
  }

  // ── auto-speak: onAutoSpeak 훅으로 ingest() 토대 (sendQueue 경유) ────────────────
  chatOrchestratorStore.onAutoSpeak(async (sessionId?: string) => {
    if (!activeProvider.value || !activeModel.value)
      return
    const chatProvider = await providersStore.getProviderInstance(activeProvider.value)
    if (!chatProvider)
      return

    // ingest()를 통해 sendQueue에 넣어 정상 performSend 파이프라인을 탐
    // (currentTurnToken 갱신 + onBeforeMessageComposed + LLM 호출까지 순서 보장)
    await chatOrchestratorStore.ingest('', {
      model: activeModel.value,
      chatProvider: chatProvider as any,
      isAutoSpeak: true,
      // auto-speak은 유저 메시지가 아니므로 input 미설정
    }, sessionId)
  })
  // ─────────────────────────────────────────────────────────────────────────

  const startTrackingCursorPoint = useElectronEventaInvoke(electronStartTrackMousePosition)
  const reportPluginCapability = useElectronEventaInvoke(electronPluginUpdateCapability)
  await startTrackingCursorPoint()

  // Expose stage provider definitions to plugin host APIs.
  defineInvokeHandler(context.value, pluginProtocolListProviders, async () => listProvidersForPluginHost())

  if (shouldPublishPluginHostCapabilities()) {
    await reportPluginCapability({
      key: pluginProtocolListProvidersEventName,
      state: 'ready',
      metadata: {
        source: 'stage-ui',
      },
    })
  }

  // Listen for open-settings IPC message from main process
  defineInvokeHandler(context.value, electronOpenSettings, () => router.push('/settings'))
})

watch(themeColorsHue, () => {
  document.documentElement.style.setProperty('--chromatic-hue', themeColorsHue.value.toString())
}, { immediate: true })

watch(themeColorsHueDynamic, () => {
  document.documentElement.classList.toggle('dynamic-hue', themeColorsHueDynamic.value)
}, { immediate: true })

onUnmounted(() => {
  echoMemory?.dispose()
  contextBridgeStore.dispose()
})
</script>

<template>
  <ToasterRoot @close="id => toast.dismiss(id)">
    <Toaster />
  </ToasterRoot>
  <ResizeHandler />
  <RouterView />
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
