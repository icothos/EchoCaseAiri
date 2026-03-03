import { defineEventa } from '@moeru/eventa'
import { createContext as createBroadcastChannelContext } from '@moeru/eventa/adapters/broadcast-channel'

/**
 * Stage.vue(windows:main) → session-store(windows:chat) 방향의 session 동기화 버스.
 *
 * [흐름]
 * 1. playbackManager.onStart 시 Stage.vue → sessionTtsSegmentStartedEvent { sessionId, text } 발송
 * 2. windows:chat session-store → 수신 → 바로 commitSpokenMessage 호출 (같은 창 ✓)
 */

export interface SessionTtsSegmentStartedPayload {
    sessionId: string
    text: string
}

export const sessionTtsSegmentStartedEvent = defineEventa<SessionTtsSegmentStartedPayload>('eventa:session:tts:segment:started')

const BUS_CHANNEL_NAME = 'proj-airi:session:spoken'

let context: ReturnType<typeof createBroadcastChannelContext>['context'] | undefined
let channel: BroadcastChannel | undefined

function getChannel() {
    if (!channel)
        channel = new BroadcastChannel(BUS_CHANNEL_NAME)
    return channel
}

export function getSessionBusContext() {
    if (!context)
        context = createBroadcastChannelContext(getChannel()).context
    return context
}
