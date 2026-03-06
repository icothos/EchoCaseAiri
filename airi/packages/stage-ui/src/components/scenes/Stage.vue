<script setup lang="ts">
import type { DuckDBWasmDrizzleDatabase } from '@proj-airi/drizzle-duckdb-wasm'
import type { Live2DLipSync, Live2DLipSyncOptions } from '@proj-airi/model-driver-lipsync'
import type { Profile } from '@proj-airi/model-driver-lipsync/shared/wlipsync'
import type { SpeechProviderWithExtraOptions } from '@xsai-ext/providers/utils'
import type { UnElevenLabsOptions } from 'unspeech'

import type { EmotionPayload } from '../../constants/emotions'

import { drizzle } from '@proj-airi/drizzle-duckdb-wasm'
import { getImportUrlBundles } from '@proj-airi/drizzle-duckdb-wasm/bundles/import-url-browser'
import { createLive2DLipSync } from '@proj-airi/model-driver-lipsync'
import { wlipsyncProfile } from '@proj-airi/model-driver-lipsync/shared/wlipsync'
import { createPlaybackManager, createSpeechPipeline } from '@proj-airi/pipelines-audio'
import { Live2DScene, useLive2d } from '@proj-airi/stage-ui-live2d'
import { ThreeScene, useModelStore } from '@proj-airi/stage-ui-three'
import { animations } from '@proj-airi/stage-ui-three/assets/vrm'
import { createQueue } from '@proj-airi/stream-kit'
import { useBroadcastChannel } from '@vueuse/core'
// import { createTransformers } from '@xsai-transformers/embed'
// import embedWorkerURL from '@xsai-transformers/embed/worker?worker&url'
// import { embed } from '@xsai/embed'
import { generateSpeech } from '@xsai/generate-speech'
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref } from 'vue'

import { useDelayMessageQueue, useEmotionsMessageQueue } from '../../composables/queues'
import { llmInferenceEndToken } from '../../constants'
import { EMOTION_EmotionMotionName_value, EMOTION_VRMExpressionName_value, EmotionThinkMotionName } from '../../constants/emotions'
import { getSessionBusContext, sessionTtsSegmentStartedEvent } from '../../services/session/bus'
import { useAudioContext, useSpeakingStore } from '../../stores/audio'
import { useChatOrchestratorStore } from '../../stores/chat'
import { useAiriCardStore } from '../../stores/modules'
import { useSpeechStore } from '../../stores/modules/speech'
import { useProvidersStore } from '../../stores/providers'
import { useSettings } from '../../stores/settings'
import { useSpeechRuntimeStore } from '../../stores/speech-runtime'

withDefaults(defineProps<{
  paused?: boolean
  focusAt: { x: number, y: number }
  xOffset?: number | string
  yOffset?: number | string
  scale?: number
}>(), { paused: false, scale: 1 })

const componentState = defineModel<'pending' | 'loading' | 'mounted'>('state', { default: 'pending' })

const db = ref<DuckDBWasmDrizzleDatabase>()
// const transformersProvider = createTransformers({ embedWorkerURL })

const vrmViewerRef = ref<InstanceType<typeof ThreeScene>>()
const live2dSceneRef = ref<InstanceType<typeof Live2DScene>>()

const settingsStore = useSettings()
const {
  stageModelRenderer,
  stageViewControlsEnabled,
  live2dDisableFocus,
  stageModelSelectedUrl,
  stageModelSelected,
  themeColorsHue,
  themeColorsHueDynamic,
  live2dIdleAnimationEnabled,
  live2dAutoBlinkEnabled,
  live2dForceAutoBlinkEnabled,
  live2dShadowEnabled,
  live2dMaxFps,
  hardInterrupt,
} = storeToRefs(settingsStore)
const { mouthOpenSize } = storeToRefs(useSpeakingStore())
const { audioContext } = useAudioContext()
const currentAudioSource = ref<AudioBufferSourceNode>()

const chatOrchestrator = useChatOrchestratorStore()
const { onBeforeMessageComposed, onBeforeSend, onTokenLiteral, onTokenSpecial, onStreamEnd, onAssistantResponseEnd } = chatOrchestrator
const { currentTurnToken } = storeToRefs(chatOrchestrator)
const chatHookCleanups: Array<() => void> = []
// WORKAROUND: clear previous handlers on unmount to avoid duplicate calls when this component remounts.
//             We keep per-hook disposers instead of wiping the global chat hooks to play nicely with
//             cross-window broadcast wiring.

const providersStore = useProvidersStore()
const live2dStore = useLive2d()
const vrmStore = useModelStore()

const showStage = ref(true)
const viewUpdateCleanups: Array<() => void> = []

// Caption + Presentation broadcast channels
type CaptionChannelEvent
  = | { type: 'caption-speaker', text: string }
    | { type: 'caption-assistant', text: string }
const { post: postCaption } = useBroadcastChannel<CaptionChannelEvent, CaptionChannelEvent>({ name: 'airi-caption-overlay' })
const assistantCaption = ref('')

type PresentEvent
  = | { type: 'assistant-reset' }
    | { type: 'assistant-append', text: string }
const { post: postPresent } = useBroadcastChannel<PresentEvent, PresentEvent>({ name: 'airi-chat-present' })

viewUpdateCleanups.push(live2dStore.onShouldUpdateView(async () => {
  showStage.value = false
  await settingsStore.updateStageModel()
  setTimeout(() => {
    showStage.value = true
  }, 100)
}))

viewUpdateCleanups.push(vrmStore.onShouldUpdateView(async () => {
  showStage.value = false
  await settingsStore.updateStageModel()
  setTimeout(() => {
    showStage.value = true
  }, 100)
}))

const audioAnalyser = ref<AnalyserNode>()
const nowSpeaking = ref(false)
const lipSyncStarted = ref(false)
const lipSyncLoopId = ref<number>()
const live2dLipSync = ref<Live2DLipSync>()
const live2dLipSyncOptions: Live2DLipSyncOptions = { mouthUpdateIntervalMs: 50, mouthLerpWindowMs: 50 }

const { activeCard } = storeToRefs(useAiriCardStore())
const speechStore = useSpeechStore()
const { ssmlEnabled, activeSpeechProvider, activeSpeechModel, activeSpeechVoice, pitch } = storeToRefs(speechStore)
const activeCardId = computed(() => activeCard.value?.name ?? 'default')
const speechRuntimeStore = useSpeechRuntimeStore()
const sessionBusContext = getSessionBusContext()

const { currentMotion } = storeToRefs(useLive2d())

const emotionsQueue = createQueue<EmotionPayload>({
  handlers: [
    async (ctx) => {
      if (stageModelRenderer.value === 'vrm') {
        // console.debug('VRM emotion anime: ', ctx.data)
        const value = EMOTION_VRMExpressionName_value[ctx.data.name]
        if (!value)
          return

        await vrmViewerRef.value!.setExpression(value, ctx.data.intensity)
      }
      else if (stageModelRenderer.value === 'live2d') {
        currentMotion.value = { group: EMOTION_EmotionMotionName_value[ctx.data.name] }
      }
    },
  ],
})

const emotionMessageContentQueue = useEmotionsMessageQueue(emotionsQueue)
emotionMessageContentQueue.onHandlerEvent('emotion', (emotion) => {
  // eslint-disable-next-line no-console
  console.debug('emotion detected', emotion)
})

const delaysQueue = useDelayMessageQueue()
delaysQueue.onHandlerEvent('delay', (delay) => {
  // eslint-disable-next-line no-console
  console.debug('delay detected', delay)
})

// Play special token: delay or emotion
function playSpecialToken(special: string) {
  delaysQueue.enqueue(special)
  emotionMessageContentQueue.enqueue(special)
}
const lipSyncNode = ref<AudioNode>()

async function playFunction(item: Parameters<Parameters<typeof createPlaybackManager<AudioBuffer>>[0]['play']>[0], signal: AbortSignal): Promise<void> {
  if (!audioContext || !item.audio)
    return

  // Ensure audio context is resumed (browsers suspend it by default until user interaction)
  if (audioContext.state === 'suspended') {
    try {
      await audioContext.resume()
    }
    catch {
      return
    }
  }

  const source = audioContext.createBufferSource()
  currentAudioSource.value = source
  source.buffer = item.audio

  source.connect(audioContext.destination)
  if (audioAnalyser.value)
    source.connect(audioAnalyser.value)
  if (lipSyncNode.value)
    source.connect(lipSyncNode.value)

  return new Promise<void>((resolve) => {
    let settled = false
    const resolveOnce = () => {
      if (settled)
        return
      settled = true
      resolve()
    }

    const stopPlayback = () => {
      clearTimeout(safetyTimeoutId)
      try {
        source.stop()
        source.disconnect()
      }
      catch {}
      if (currentAudioSource.value === source)
        currentAudioSource.value = undefined
      resolveOnce()
    }

    // Chrome WebAudio 버그 방어 로직: 매우 짧은 버퍼나 특정 조건에서 onended 이벤트를 삼키는 경우에 대비
    // 오디오 길이에 500ms 여유를 더해 무조건 정리되도록 강제 타임아웃 설정
    const safetyTimeoutMs = (item.audio.duration * 1000) + 500
    const safetyTimeoutId = setTimeout(stopPlayback, safetyTimeoutMs)

    if (signal.aborted) {
      stopPlayback()
      return
    }

    signal.addEventListener('abort', stopPlayback, { once: true })
    source.onended = () => {
      signal.removeEventListener('abort', stopPlayback)
      stopPlayback()
    }

    try {
      source.start(0)
    }
    catch {
      stopPlayback()
    }
  })
}

const playbackManager = createPlaybackManager<AudioBuffer>({
  play: playFunction,
  maxVoices: 1,
  maxVoicesPerOwner: 1,
  overflowPolicy: 'queue',
  ownerOverflowPolicy: 'steal-oldest',
})

const speechPipeline = createSpeechPipeline<AudioBuffer>({
  tts: async (request, signal) => {
    if (signal.aborted) {
      console.info(`[Speech Pipeline] tts aborted (request: ${request.text?.slice(0, 30)}...)`)
      return null
    }

    if (!activeSpeechProvider.value) {
      console.warn('[Speech Pipeline] No activeSpeechProvider')
      return null
    }

    const provider = await providersStore.getProviderInstance(activeSpeechProvider.value) as SpeechProviderWithExtraOptions<string, UnElevenLabsOptions>
    if (!provider) {
      console.error('[Speech Pipeline] Failed to initialize speech provider')
      return null
    }

    if (!request.text && !request.special) {
      console.info('[Speech Pipeline] Empty request text and special')
      return null
    }

    console.warn(`[TRACER] [Speech Pipeline] Generating TTS for: ${request.text?.slice(0, 30)} (is special: ${!!request.special})`)
    const providerConfig = providersStore.getProviderConfig(activeSpeechProvider.value)

    // For OpenAI Compatible providers, always use provider config for model and voice
    // since these are manually configured in provider settings
    let model = activeSpeechModel.value
    let voice = activeSpeechVoice.value

    if (activeSpeechProvider.value === 'openai-compatible-audio-speech') {
      // Always prefer provider config for OpenAI Compatible (user configured it there)
      if (providerConfig?.model) {
        model = providerConfig.model as string
      }
      else {
        // Fallback to default if not in provider config
        model = 'tts-1'
        console.warn('[Speech Pipeline] OpenAI Compatible: No model in provider config, using default', { providerConfig })
      }

      if (providerConfig?.voice) {
        voice = {
          id: providerConfig.voice as string,
          name: providerConfig.voice as string,
          description: providerConfig.voice as string,
          previewURL: '',
          languages: [{ code: 'en', title: 'English' }],
          provider: activeSpeechProvider.value,
          gender: 'neutral',
        }
      }
      else {
        // Fallback to default if not in provider config
        voice = {
          id: 'alloy',
          name: 'alloy',
          description: 'alloy',
          previewURL: '',
          languages: [{ code: 'en', title: 'English' }],
          provider: activeSpeechProvider.value,
          gender: 'neutral',
        }
        console.warn('[Speech Pipeline] OpenAI Compatible: No voice in provider config, using default', { providerConfig })
      }
    }

    if (!model || !voice)
      return null

    const input = ssmlEnabled.value
      ? speechStore.generateSSML(request.text, voice, { ...providerConfig, pitch: pitch.value })
      : request.text

    try {
      const controller = new AbortController()

      const timeoutId = setTimeout(() => {
        controller.abort(new Error('TTS timeout'))
      }, 10000)

      const onSignalAbort = () => {
        controller.abort(signal.reason)
      }

      if (signal.aborted) {
        onSignalAbort()
      }
      else {
        signal.addEventListener('abort', onSignalAbort, { once: true })
      }

      try {
        const res = await generateSpeech({
          ...provider.speech(model, providerConfig),
          input,
          voice: voice.id,
          signal: controller.signal as any,
        })

        if (controller.signal.aborted || !res || res.byteLength === 0)
          return null

        const audioBuffer = await audioContext.decodeAudioData(res)
        return audioBuffer
      }
      finally {
        clearTimeout(timeoutId)
        signal.removeEventListener('abort', onSignalAbort)
      }
    }
    catch (err) {
      console.error('[Stage] TTS generateSpeech error:', err)
      return null
    }
  },
  playback: {
    ...playbackManager,
    getWaitingCount: playbackManager.getWaitingCount,
  },
})

void speechRuntimeStore.registerHost(speechPipeline)

speechPipeline.on('onSpecial', (segment) => {
  if (segment.special)
    playSpecialToken(segment.special)
})

speechPipeline.on('onIntentEnd', (intentId) => {
  // TTS 다운로드 파이프라인이 하나의 Intent를 완전히 완료했을 때.
  // 이전에 여기서 Auto-Speak을 콜했으나 사용자의 요청으로 제거됨.
})

// onStart: TTS 오디오 재생 시작 시점 → text 포함하여 windows:chat에 started 신호 전송 → 텍스트 표시
playbackManager.onStart(({ item }) => {
  if (item.text && !item.special && item.sessionId) {
    sessionBusContext.emit(sessionTtsSegmentStartedEvent, { sessionId: item.sessionId, text: item.text })
  }
})

playbackManager.onEnd(({ item }) => {
  if (item.text && !item.special) { // Removed TTS log per user requested
    // ;(window as any).logChat?.(`[TTS onEnd] sessionId=${item.sessionId ?? 'none'} text=${item.text.slice(0, 40)}`)
    const ts = new Date().toISOString().slice(0, 19).replace('T', ' ')
    ;(window as any).logChat?.(`[${ts}] [Airi] ${item.text}`)
  }

  nowSpeaking.value = false
  mouthOpenSize.value = 0

  // 1. TTS 큐가 비어있고, 2. LLM 생성 도중이 아니며, 3. TTS 파이프라인에서 남은 청크 다운로드 처리가 없는 경우에만 auto-speak 스케줄
  tryScheduleAutoSpeak(item.intentId || currentTurnToken.value, item.sessionId, '[Stage] 마지막 TTS 오디오 재생 완료 및 대기 중인 오디오/처리 없음')
})

playbackManager.onInterrupt(({ item, reason }) => {
  if (item.text && !item.special) {
    const ts = new Date().toISOString().slice(0, 19).replace('T', ' ')
    ;(window as any).logChat?.(`[${ts}] [Airi][INTERRUPTED reason=${reason}] ${item.text}`)
  }
  nowSpeaking.value = false
  mouthOpenSize.value = 0
})

playbackManager.onReject(({ item, reason }) => {
  if (item.text && !item.special) {
    const ts = new Date().toISOString().slice(0, 19).replace('T', ' ')
    ;(window as any).logChat?.(`[${ts}] [Airi][REJECTED reason=${reason}] ${item.text}`)
  }
  nowSpeaking.value = false
  mouthOpenSize.value = 0
})

playbackManager.onStart(({ item }) => {
  nowSpeaking.value = true
  // NOTICE: postCaption and postPresent may throw errors if the BroadcastChannel is closed
  // (e.g., when navigating away from the page). We wrap these in try-catch to prevent
  // breaking playback when the channel is unavailable.
  assistantCaption.value += ` ${item.text}`
  try {
    postCaption({ type: 'caption-assistant', text: assistantCaption.value })
  }
  catch {
    // BroadcastChannel may be closed - don't break playback
  }
  try {
    postPresent({ type: 'assistant-append', text: item.text })
  }
  catch {
    // BroadcastChannel may be closed - don't break playback
  }
})

function startLipSyncLoop() {
  if (lipSyncLoopId.value)
    return

  const tick = () => {
    if (!nowSpeaking.value || !live2dLipSync.value) {
      mouthOpenSize.value = 0
    }
    else {
      mouthOpenSize.value = live2dLipSync.value.getMouthOpen()
    }
    lipSyncLoopId.value = requestAnimationFrame(tick)
  }

  lipSyncLoopId.value = requestAnimationFrame(tick)
}

async function setupLipSync() {
  if (lipSyncStarted.value)
    return

  try {
    const lipSync = await createLive2DLipSync(audioContext, wlipsyncProfile as Profile, live2dLipSyncOptions)
    live2dLipSync.value = lipSync
    lipSyncNode.value = lipSync.node
    await audioContext.resume()
    startLipSyncLoop()
    lipSyncStarted.value = true
  }
  catch (error) {
    lipSyncStarted.value = false
    console.error('Failed to setup Live2D lip sync', error)
  }
}

function setupAnalyser() {
  if (!audioAnalyser.value) {
    audioAnalyser.value = audioContext.createAnalyser()
  }
}

import { shallowRef } from 'vue'

const currentChatIntent = shallowRef<ReturnType<typeof speechRuntimeStore.openIntent> | null>(null)

chatHookCleanups.push(onBeforeMessageComposed(async (_message, context) => {
  setupAnalyser()
  await setupLipSync()
  // Reset assistant caption for a new message
  assistantCaption.value = ''
  try {
    postCaption({ type: 'caption-assistant', text: '' })
  }
  catch (error) {
    console.warn('[Stage] Failed to post caption reset (channel may be closed)', { error })
  }
  try {
    postPresent({ type: 'assistant-reset' })
  }
  catch (error) {
    console.warn('[Stage] Failed to post present reset (channel may be closed)', { error })
  }

  if (currentChatIntent.value) {
    currentChatIntent.value.cancel('new-message', { keepActive: !hardInterrupt.value })
    currentChatIntent.value = null
  }

  const sessionId = context.sessionId
  currentChatIntent.value = speechRuntimeStore.openIntent({
    ownerId: activeCardId.value,
    sessionId,
    intentId: context.turnToken,
    priority: 'normal',
    behavior: 'queue',
  })
}))

chatHookCleanups.push(onBeforeSend(async (message) => {
  // 채팅 로그: 유저 메시지
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ')
  ;(window as any).logChat?.(`[${ts}] [User] ${message}`)
  currentMotion.value = { group: EmotionThinkMotionName }
}))

chatHookCleanups.push(onTokenLiteral(async (literal) => {
  currentChatIntent.value?.writeLiteral(literal)
}))

chatHookCleanups.push(onTokenSpecial(async (special) => {
  // console.debug('Stage received special token:', special)
  currentChatIntent.value?.writeSpecial(special)
}))

chatHookCleanups.push(onStreamEnd(async () => {
  currentChatIntent.value?.writeFlush()
  delaysQueue.enqueue(llmInferenceEndToken)
}))

chatHookCleanups.push(onAssistantResponseEnd(async (_message, context) => {
  currentChatIntent.value?.end()
  currentChatIntent.value = null

  console.warn(`[TRACER] [Stage] onAssistantResponseEnd. waiting: ${playbackManager.getWaitingCount()}, nowSpeaking: ${nowSpeaking.value}, isProcessing: ${speechRuntimeStore.isProcessing()}, activeCount: ${speechRuntimeStore.getActiveCount()}`)
  // 예전에는 여기서 Auto-Speak을 초기 호출했으나 유저 요청으로 오직 오디오 재생이 끝난 시점 (playbackManager.onEnd) 에서만 스케줄합니다.
}))

let isAutoSpeakScheduled = false

function tryScheduleAutoSpeak(token: string | undefined, sessionId: string | undefined, debugReason: string) {
  if (!token) return

  // 150ms 딜레이를 주어 WebAudio Event Loop의 micro-task 간극(Gap)을 안전하게 넘깁니다.
  // 주의: setTimeout 내부에서 중복 스케줄링을 방지하기 위해 isAutoSpeakScheduled 플래그를 사용합니다.
  setTimeout(() => {
    if (isAutoSpeakScheduled) return

    const isSending = chatOrchestrator.sending
    const activePlaybackCount = speechRuntimeStore.getActiveCount()
    const waitingPlaybackCount = playbackManager.getWaitingCount()

    // 1. LLM 생성 중이 아니고
    // 2. TTS 파이프라인 다운로드 중이 아니고
    // 3. WebAudio 큐에 활성 재생중인 오디오가 없고
    // 4. WebAudio 큐에 대기중인 항목이 없을 때만 스케줄!
    const isProcessing = speechRuntimeStore.isProcessing()
    if (!isSending && !isProcessing && activePlaybackCount === 0 && waitingPlaybackCount === 0) {
      isAutoSpeakScheduled = true
      console.debug(`${debugReason} - auto-speak 스케줄 (token: ${token.slice(0, 8)})`)

      void chatOrchestrator.scheduleAutoSpeak(token, Number(import.meta.env.VITE_AUTO_SPEAK_IDLE_MS ?? 5_000), sessionId).finally(() => {
        isAutoSpeakScheduled = false
      })
    } else {
      console.debug(`[Stage] tryScheduleAutoSpeak 조건 미충족. 취소됨. (sending:${isSending}, act:${activePlaybackCount}, wait:${waitingPlaybackCount})`)
    }
  }, 150)
}

onUnmounted(() => {
  lipSyncStarted.value = false
})

// Resume audio context on first user interaction (browser requirement)
let audioContextResumed = false
function resumeAudioContextOnInteraction() {
  if (audioContextResumed || !audioContext)
    return
  audioContextResumed = true
  audioContext.resume().catch(() => {
    // Ignore errors - audio context will be resumed when needed
  })
}

// Add event listeners for user interaction
if (typeof window !== 'undefined') {
  const events = ['click', 'touchstart', 'keydown']
  events.forEach((event) => {
    window.addEventListener(event, resumeAudioContextOnInteraction, { once: true, passive: true })
  })
}

onMounted(async () => {
  db.value = drizzle({ connection: { bundles: getImportUrlBundles() } })
  await db.value.execute(`CREATE TABLE memory_test (vec FLOAT[768]);`)
})

function canvasElement() {
  if (stageModelRenderer.value === 'live2d')
    return live2dSceneRef.value?.canvasElement()

  else if (stageModelRenderer.value === 'vrm')
    return vrmViewerRef.value?.canvasElement()
}

function readRenderTargetRegionAtClientPoint(clientX: number, clientY: number, radius: number) {
  if (stageModelRenderer.value !== 'vrm')
    return null

  return vrmViewerRef.value?.readRenderTargetRegionAtClientPoint?.(clientX, clientY, radius) ?? null
}

onUnmounted(() => {
  if (lipSyncLoopId.value) {
    cancelAnimationFrame(lipSyncLoopId.value)
    lipSyncLoopId.value = undefined
  }

  chatHookCleanups.forEach(dispose => dispose?.())
  viewUpdateCleanups.forEach(dispose => dispose?.())
})

defineExpose({
  canvasElement,
  readRenderTargetRegionAtClientPoint,
})
</script>

<template>
  <div relative>
    <div h-full w-full>
      <Live2DScene
        v-if="stageModelRenderer === 'live2d' && showStage"
        ref="live2dSceneRef"
        v-model:state="componentState"
        min-w="50% <lg:full" min-h="100 sm:100"
        h-full w-full flex-1
        :model-src="stageModelSelectedUrl"
        :model-id="stageModelSelected"
        :focus-at="focusAt"
        :mouth-open-size="mouthOpenSize"
        :paused="paused"
        :x-offset="xOffset"
        :y-offset="yOffset"
        :scale="scale"
        :disable-focus-at="live2dDisableFocus"
        :theme-colors-hue="themeColorsHue"
        :theme-colors-hue-dynamic="themeColorsHueDynamic"
        :live2d-idle-animation-enabled="live2dIdleAnimationEnabled"
        :live2d-auto-blink-enabled="live2dAutoBlinkEnabled"
        :live2d-force-auto-blink-enabled="live2dForceAutoBlinkEnabled"
        :live2d-shadow-enabled="live2dShadowEnabled"
        :live2d-max-fps="live2dMaxFps"
      />
      <ThreeScene
        v-if="stageModelRenderer === 'vrm' && showStage"
        ref="vrmViewerRef"
        v-model:state="componentState"
        :model-src="stageModelSelectedUrl"
        :idle-animation="animations.idleLoop.toString()"
        min-w="50% <lg:full" min-h="100 sm:100" h-full w-full flex-1
        :paused="paused"
        :show-axes="stageViewControlsEnabled"
        :current-audio-source="currentAudioSource"
        @error="console.error"
      />
    </div>
  </div>
</template>
