import type { Eventa } from '@moeru/eventa'

import type { SpeechPipelineEventName } from './eventa'
import type {
  IntentHandle,
  IntentOptions,
  LoggerLike,
  PlaybackItem,
  SpeechPipelineEvents,
  TextSegment,
  TextToken,
  TtsRequest,
  TtsResult,
} from './types'

import { createContext } from '@moeru/eventa'

import { speechPipelineEventMap } from './eventa'
import { createPriorityResolver } from './priority'
import { createTtsSegmentStream } from './processors/tts-chunker'
import { createPushStream } from './stream'

export interface SpeechPipelineOptions<TAudio> {
  tts: (request: TtsRequest, signal: AbortSignal) => Promise<TAudio | null>
  playback: {
    schedule: (item: PlaybackItem<TAudio>) => void
    stopAll: (reason: string) => void
    stopByIntent: (intentId: string, reason: string) => void
    clearWaitingByIntent?: (intentId: string, reason: string) => void
    stopByOwner: (ownerId: string, reason: string) => void
    onStart: (listener: (event: { item: PlaybackItem<TAudio>, startedAt: number }) => void) => void
    onEnd: (listener: (event: { item: PlaybackItem<TAudio>, endedAt: number }) => void) => void
    onInterrupt: (listener: (event: { item: PlaybackItem<TAudio>, reason: string, interruptedAt: number }) => void) => void
    onReject: (listener: (event: { item: PlaybackItem<TAudio>, reason: string }) => void) => void
    getWaitingCount?: () => number
    getActiveCount?: () => number
  }
  logger?: LoggerLike
  priority?: ReturnType<typeof createPriorityResolver>
  segmenter?: (tokens: ReadableStream<TextToken>, meta: { streamId: string, intentId: string }) => ReadableStream<TextSegment>
}

interface IntentState {
  intentId: string
  streamId: string
  priority: number
  ownerId?: string
  sessionId?: string
  behavior: 'queue' | 'interrupt' | 'replace'
  createdAt: number
  controller: AbortController
  stream: ReadableStream<TextToken>
  closeStream: () => void
  canceled: boolean
}

function createId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function writeTtsDebugLog(intentId: string, event: string, details: string) {
  const time = new Date().toISOString()
  const logLine = `[${time}] [Intent: ${intentId.slice(0, 8)}] [${event}] ${details}\n`
  // Try exposed contextBridge
  try {
    if (typeof window !== 'undefined' && typeof (window as any).logTTS === 'function') {
      ;(window as any).logTTS(logLine.trim()).catch((e: any) => console.error('[logTTS IPC Error]', e))
      return
    }
  } catch (e) {
    console.error('[writeTtsDebugLog] Synchronous error calling window.logTTS:', e)
  }
}

export function createSpeechPipeline<TAudio>(options: SpeechPipelineOptions<TAudio>) {
  const logger = options.logger ?? console
  const priorityResolver = options.priority ?? createPriorityResolver()
  const segmenter = options.segmenter ?? createTtsSegmentStream
  const context = createContext()

  const intents = new Map<string, IntentState>()
  const pending: IntentState[] = []
  let activeIntent: IntentState | null = null

  options.playback.onStart(event => context.emit(speechPipelineEventMap.onPlaybackStart, event))
  options.playback.onEnd(event => context.emit(speechPipelineEventMap.onPlaybackEnd, event))
  options.playback.onInterrupt(event => context.emit(speechPipelineEventMap.onPlaybackInterrupt, event))
  options.playback.onReject(event => context.emit(speechPipelineEventMap.onPlaybackReject, event))

  function enqueueIntent(intent: IntentState) {
    pending.push(intent)
  }

  function pickNextIntent() {
    if (pending.length === 0)
      return null
    pending.sort((a, b) => (b.priority - a.priority) || (a.createdAt - b.createdAt))
    return pending.shift() ?? null
  }

  async function runIntent(intent: IntentState) {
    activeIntent = intent
    writeTtsDebugLog(intent.intentId, 'START', `Priority: ${intent.priority}, Behavior: ${intent.behavior}`)
    context.emit(speechPipelineEventMap.onIntentStart, intent.intentId)

    const tokenStream = intent.stream
    const segmentStream = segmenter(tokenStream, { streamId: intent.streamId, intentId: intent.intentId })

    try {
      const reader = segmentStream.getReader()

      while (true) {
        const { value, done } = await reader.read()
        if (done)
          break
        if (!value)
          continue
        if (intent.canceled || intent.controller.signal.aborted) {
          await reader.cancel()
          break
        }

        context.emit(speechPipelineEventMap.onSegment, value)
        writeTtsDebugLog(intent.intentId, 'SEGMENT', `Text: "${value.text.slice(0, 30)}" | Special: ${value.special}`)

        if (value.text === '' && value.special) {
          writeTtsDebugLog(intent.intentId, 'SPECIAL_ONLY', `Skipping TTS, special only: ${value.special}`)
          context.emit(speechPipelineEventMap.onSpecial, value)
          continue
        }

        const request: TtsRequest = {
          streamId: value.streamId,
          intentId: value.intentId,
          segmentId: value.segmentId,
          text: value.text,
          special: value.special,
          priority: intent.priority,
          createdAt: Date.now(),
        }

        context.emit(speechPipelineEventMap.onTtsRequest, request)

        if (options.playback.getWaitingCount) {
          const waitStart = Date.now()
          let waiting = false
          while (options.playback.getWaitingCount() >= 2) {
            if (!waiting) {
              writeTtsDebugLog(intent.intentId, 'WAIT_QUEUE', `Playback queue >= 2, throttling TTS...`)
              waiting = true
            }
            if (intent.canceled || intent.controller.signal.aborted)
              break
            await new Promise(resolve => setTimeout(resolve, 50))
          }
          if (waiting) {
            writeTtsDebugLog(intent.intentId, 'RESUME_QUEUE', `Wait resolved after ${Date.now() - waitStart}ms`)
          }
        }

        if (intent.controller.signal.aborted)
          break

        let audio: TAudio | null = null
        try {
          writeTtsDebugLog(intent.intentId, 'TTS_REQ', `Requesting API: "${request.text.slice(0, 30)}..."`)
          const ttsStart = Date.now()
          audio = await options.tts(request, intent.controller.signal)
          writeTtsDebugLog(intent.intentId, 'TTS_RES', `Audio received (${Date.now() - ttsStart}ms), isNull=${!audio}`)
        }
        catch (err) {
          writeTtsDebugLog(intent.intentId, 'TTS_FAIL', `TTS Generation Failed: ${err}`)
          logger.warn('TTS generation failed:', err)
          if (intent.controller.signal.aborted)
            break
          continue
        }

        if (intent.controller.signal.aborted) {
          writeTtsDebugLog(intent.intentId, 'TTS_ABORT', `Discarding chunk: "${request.text.slice(0, 30)}..."`)
          break
        }

        if (!audio) {
          writeTtsDebugLog(intent.intentId, 'TTS_SKIP', `Audio was null for: "${request.text.slice(0, 30)}..."`)
          continue
        }

        const ttsResult: TtsResult<TAudio> = {
          streamId: request.streamId,
          intentId: request.intentId,
          segmentId: request.segmentId,
          text: request.text,
          special: request.special,
          audio,
          createdAt: Date.now(),
        }

        context.emit(speechPipelineEventMap.onTtsResult, ttsResult)

        writeTtsDebugLog(intent.intentId, 'SCHEDULE', `Queuing playback: "${ttsResult.text.slice(0, 30)}..."`)
        options.playback.schedule({
          id: createId('playback'),
          streamId: ttsResult.streamId,
          intentId: ttsResult.intentId,
          segmentId: ttsResult.segmentId,
          ownerId: intent.ownerId,
          sessionId: intent.sessionId,
          priority: intent.priority,
          text: ttsResult.text,
          special: ttsResult.special,
          audio: ttsResult.audio,
          createdAt: Date.now(),
        })
      }

      reader.releaseLock()
    }
    catch (err) {
      logger.warn('Speech pipeline intent failed:', err)
    }
    finally {
      if (intent.canceled) {
        writeTtsDebugLog(intent.intentId, 'CANCEL', `Reason: ${intent.controller.signal.reason as string | undefined}`)
        context.emit(speechPipelineEventMap.onIntentCancel, { intentId: intent.intentId, reason: intent.controller.signal.reason as string | undefined })
      }
      else {
        writeTtsDebugLog(intent.intentId, 'END', 'Intent fully generated and scheduled.')
        context.emit(speechPipelineEventMap.onIntentEnd, intent.intentId)
      }

      intents.delete(intent.intentId)
      activeIntent = null

      const next = pickNextIntent()
      if (next)
        void runIntent(next)
    }
  }

  function openIntent(optionsInput?: IntentOptions): IntentHandle {
    const intentId = optionsInput?.intentId ?? createId('intent')
    const streamId = optionsInput?.streamId ?? createId('stream')
    const priority = priorityResolver.resolve(optionsInput?.priority)
    const behavior = optionsInput?.behavior ?? 'queue'
    const ownerId = optionsInput?.ownerId
    const sessionId = optionsInput?.sessionId

    const controller = new AbortController()
    const { stream, write, close } = createPushStream<TextToken>()
    let sequence = 0

    const intent: IntentState = {
      intentId,
      streamId,
      priority,
      ownerId,
      sessionId,
      behavior,
      createdAt: Date.now(),
      controller,
      stream,
      closeStream: close,
      canceled: false,
    }

    intents.set(intentId, intent)

    const handle: IntentHandle = {
      intentId,
      streamId,
      priority,
      ownerId,
      stream,
      writeLiteral(text: string) {
        writeTtsDebugLog(intentId, 'HOOK_WRITE_LITERAL', `Received: "${text.slice(0, 30)}" | Canceled=${intent.canceled}`)
        if (intent.canceled)
          return
        write({
          type: 'literal',
          value: text,
          streamId,
          intentId,
          sequence: sequence++,
          createdAt: Date.now(),
        })
      },
      writeSpecial(special: string) {
        writeTtsDebugLog(intentId, 'HOOK_WRITE_SPECIAL', `Received: "${special}" | Canceled=${intent.canceled}`)
        if (intent.canceled)
          return
        write({
          type: 'special',
          value: special,
          streamId,
          intentId,
          sequence: sequence++,
          createdAt: Date.now(),
        })
      },
      writeFlush() {
        writeTtsDebugLog(intentId, 'HOOK_WRITE_FLUSH', `Flushing stream | Canceled=${intent.canceled}`)
        if (intent.canceled)
          return
        write({
          type: 'flush',
          streamId,
          intentId,
          sequence: sequence++,
          createdAt: Date.now(),
        })
      },
      end() {
        close()
      },
      cancel(reason?: string, options?: { keepActive?: boolean }) {
        cancelIntent(intentId, reason, options)
      },
    }

    if (!activeIntent) {
      void runIntent(intent)
      return handle
    }

    if (behavior === 'replace') {
      cancelIntent(activeIntent.intentId, 'replace')
      void runIntent(intent)
      return handle
    }

    if (behavior === 'interrupt' && intent.priority >= activeIntent.priority) {
      cancelIntent(activeIntent.intentId, 'interrupt')
      void runIntent(intent)
      return handle
    }

    enqueueIntent(intent)
    return handle
  }

  function cancelIntent(intentId: string, reason?: string, optionsInput?: { keepActive?: boolean }) {
    const intent = intents.get(intentId)
    if (!intent)
      return
    intent.canceled = true
    intent.controller.abort(reason ?? 'canceled')
    intent.closeStream()

    if (activeIntent?.intentId === intentId) {
      if (optionsInput?.keepActive && options.playback.clearWaitingByIntent) {
        options.playback.clearWaitingByIntent(intentId, reason ?? 'canceled')
      } else {
        options.playback.stopByIntent(intentId, reason ?? 'canceled')
      }
      return
    }

    const index = pending.findIndex(item => item.intentId === intentId)
    if (index >= 0)
      pending.splice(index, 1)

    intents.delete(intentId)
    context.emit(speechPipelineEventMap.onIntentCancel, { intentId, reason: reason ?? 'canceled' })
  }

  function interrupt(reason: string) {
    if (activeIntent)
      cancelIntent(activeIntent.intentId, reason)
  }

  function stopAll(reason: string) {
    for (const intent of intents.values()) {
      intent.canceled = true
      intent.controller.abort(reason)
      intent.closeStream()
    }
    pending.length = 0
    intents.clear()
    activeIntent = null
    options.playback.stopAll(reason)
  }

  return {
    openIntent,
    cancelIntent,
    interrupt,
    stopAll,
    isProcessing: () => intents.size > 0 || activeIntent !== null,
    getActiveCount: () => options.playback.getActiveCount ? options.playback.getActiveCount() : 0,
    on<K extends SpeechPipelineEventName>(event: K, listener: SpeechPipelineEvents<TAudio>[K]) {
      return context.on(speechPipelineEventMap[event] as Eventa<any>, (payload) => {
        listener(payload?.body ?? payload)
      })
    },
  }
}
