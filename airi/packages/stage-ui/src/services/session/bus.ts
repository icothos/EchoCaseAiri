import { defineEventa } from '@moeru/eventa'
import { createContext as createBroadcastChannelContext } from '@moeru/eventa/adapters/broadcast-channel'

/**
 * Stage.vue(TTS 창) → LLM 창 방향의 session commit 시그널.
 * TTS onEnd 시 Stage.vue가 emit하고, session-store가 in-memory session을 직접 갱신한다.
 * DB 재읽기 없이 크로스윈도우 동기화가 가능하다.
 */
export interface SessionSpokenCommitPayload {
    sessionId: string
    text: string
    createdAt: number
}

export const sessionSpokenCommitEvent = defineEventa<SessionSpokenCommitPayload>('eventa:session:spoken:commit')

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
