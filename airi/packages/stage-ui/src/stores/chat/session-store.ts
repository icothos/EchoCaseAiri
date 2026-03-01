import type { ChatHistoryItem } from '../../types/chat'
import type { ChatSessionMeta, ChatSessionRecord, ChatSessionsExport, ChatSessionsIndex } from '../../types/chat-session'

import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'

import { client } from '../../composables/api'
import { useLocalFirstRequest } from '../../composables/use-local-first'
import { chatSessionsRepo } from '../../database/repos/chat-sessions.repo'
import { type SessionSpokenCommitPayload, getSessionBusContext, sessionSpokenCommitEvent } from '../../services/session/bus'
import { useAuthStore } from '../auth'
import { useAiriCardStore } from '../modules/airi-card'

export const useChatSessionStore = defineStore('chat-session', () => {
  const { userId, isAuthenticated } = storeToRefs(useAuthStore())
  const { activeCardId, systemPrompt } = storeToRefs(useAiriCardStore())

  const activeSessionId = ref<string>('')
  const sessionMessages = ref<Record<string, ChatHistoryItem[]>>({})
  const sessionMetas = ref<Record<string, ChatSessionMeta>>({})
  const sessionGenerations = ref<Record<string, number>>({})
  const index = ref<ChatSessionsIndex | null>(null)

  const ready = ref(false)
  const isReady = computed(() => ready.value)
  const initializing = ref(false)
  let initializePromise: Promise<void> | null = null

  let persistQueue = Promise.resolve()
  let syncQueue = Promise.resolve()
  const loadedSessions = new Set<string>()
  const loadingSessions = new Map<string, Promise<void>>()

  // I know this nu uh, better than loading all language on rehypeShiki
  const codeBlockSystemPrompt = '- For any programming code block, always specify the programming language that supported on @shikijs/rehype on the rendered markdown, eg. ```python ... ```\n'
  const mathSyntaxSystemPrompt = '- For any math equation, use LaTeX format, eg: $ x^3 $, always escape dollar sign outside math equation\n'

  function getCurrentUserId() {
    return userId.value || 'local'
  }

  function getCurrentCharacterId() {
    return activeCardId.value || 'default'
  }

  function enqueuePersist(task: () => Promise<void>) {
    persistQueue = persistQueue.then(task, task)
    return persistQueue
  }

  function enqueueSync(task: () => Promise<void>) {
    syncQueue = syncQueue.then(task, task)
    return syncQueue
  }

  function snapshotMessages(messages: ChatHistoryItem[]) {
    return JSON.parse(JSON.stringify(messages)) as ChatHistoryItem[]
  }

  function extractMessageContent(message: ChatHistoryItem) {
    if (typeof message.content === 'string')
      return message.content
    if (Array.isArray(message.content)) {
      return message.content.map((part) => {
        if (typeof part === 'string')
          return part
        if (part && typeof part === 'object' && 'text' in part)
          return String(part.text ?? '')
        return ''
      }).join('')
    }
    return ''
  }

  function ensureSessionMessageIds(sessionId: string) {
    const current = sessionMessages.value[sessionId] ?? []
    let changed = false
    const next = current.map((message) => {
      if (message.id)
        return message
      changed = true
      return {
        ...message,
        id: nanoid(),
      }
    })

    if (changed)
      sessionMessages.value[sessionId] = next

    return next
  }

  function buildSyncMessages(messages: ChatHistoryItem[]) {
    return messages.map(message => ({
      id: message.id ?? nanoid(),
      role: message.role,
      content: extractMessageContent(message),
      createdAt: message.createdAt,
    }))
  }

  async function syncSessionToRemote(sessionId: string) {
    let cachedRecord: ChatSessionRecord | null | undefined
    const request = useLocalFirstRequest({
      local: async () => {
        cachedRecord = await chatSessionsRepo.getSession(sessionId)
        return cachedRecord
      },
      remote: async () => {
        if (!cachedRecord)
          cachedRecord = await chatSessionsRepo.getSession(sessionId)
        if (!cachedRecord)
          return cachedRecord

        const members: Array<
          | { type: 'user', userId: string }
          | { type: 'character', characterId: string }
        > = [
            { type: 'user', userId: userId.value },
          ]

        if (cachedRecord.meta.characterId && cachedRecord.meta.characterId !== 'default') {
          members.push({
            type: 'character',
            characterId: cachedRecord.meta.characterId,
          })
        }

        const normalizedMessages = cachedRecord.messages.map(message => message.id ? message : { ...message, id: nanoid() })
        if (normalizedMessages.some((message, index) => cachedRecord?.messages[index]?.id !== message.id)) {
          cachedRecord = {
            ...cachedRecord,
            messages: normalizedMessages,
          }
          await chatSessionsRepo.saveSession(sessionId, cachedRecord)
        }

        const res = await client.api.chats.sync.$post({
          json: {
            chat: {
              id: cachedRecord.meta.sessionId,
              type: 'group',
              title: cachedRecord.meta.title,
              createdAt: cachedRecord.meta.createdAt,
              updatedAt: cachedRecord.meta.updatedAt,
            },
            members,
            messages: buildSyncMessages(cachedRecord.messages),
          },
        })

        if (!res.ok)
          throw new Error('Failed to sync chat session')
        return cachedRecord
      },
      allowRemote: () => isAuthenticated.value,
      lazy: true,
    })

    await request.execute()
  }

  function scheduleSync(sessionId: string) {
    void enqueueSync(async () => {
      try {
        await syncSessionToRemote(sessionId)
      }
      catch (error) {
        console.warn('Failed to sync chat session', error)
      }
    })
  }

  function generateInitialMessageFromPrompt(prompt: string) {
    const content = codeBlockSystemPrompt + mathSyntaxSystemPrompt + prompt

    return {
      role: 'system',
      content,
      id: nanoid(),
      createdAt: Date.now(),
    } satisfies ChatHistoryItem
  }

  function generateInitialMessage() {
    return generateInitialMessageFromPrompt(systemPrompt.value)
  }

  function ensureGeneration(sessionId: string) {
    if (sessionGenerations.value[sessionId] === undefined)
      sessionGenerations.value[sessionId] = 0
  }

  async function loadIndexForUser(currentUserId: string) {
    const stored = await chatSessionsRepo.getIndex(currentUserId)
    index.value = stored ?? {
      userId: currentUserId,
      characters: {},
    }
  }

  function getCharacterIndex(characterId: string) {
    if (!index.value)
      return null
    return index.value.characters[characterId] ?? null
  }

  async function persistIndex() {
    if (!index.value)
      return
    const snapshot = JSON.parse(JSON.stringify(index.value)) as ChatSessionsIndex
    await enqueuePersist(() => chatSessionsRepo.saveIndex(snapshot))
  }

  async function persistSession(sessionId: string) {
    const meta = sessionMetas.value[sessionId]
    if (!meta)
      return
    const messages = snapshotMessages(ensureSessionMessageIds(sessionId))
    const now = Date.now()
    const updatedMeta = {
      ...meta,
      updatedAt: now,
    }

    sessionMetas.value[sessionId] = updatedMeta
    const characterIndex = index.value?.characters[meta.characterId]
    if (characterIndex)
      characterIndex.sessions[sessionId] = updatedMeta

    const record: ChatSessionRecord = {
      meta: updatedMeta,
      messages,
    }

    await enqueuePersist(() => chatSessionsRepo.saveSession(sessionId, record))
    await persistIndex()
    scheduleSync(sessionId)
  }

  function persistSessionMessages(sessionId: string) {
    void persistSession(sessionId)
  }

  function setSessionMessages(sessionId: string, next: ChatHistoryItem[]) {
    sessionMessages.value[sessionId] = next
    void persistSession(sessionId)
  }

  async function loadSession(sessionId: string) {
    if (loadedSessions.has(sessionId))
      return
    if (loadingSessions.has(sessionId)) {
      await loadingSessions.get(sessionId)
      return
    }

    const loadPromise = (async () => {
      const stored = await chatSessionsRepo.getSession(sessionId)
      if (stored) {
        sessionMetas.value[sessionId] = stored.meta
        sessionMessages.value[sessionId] = stored.messages
        ensureGeneration(sessionId)
      }
      loadedSessions.add(sessionId)
    })()

    loadingSessions.set(sessionId, loadPromise)
    await loadPromise
    loadingSessions.delete(sessionId)
  }

  async function createSession(characterId: string, options?: { setActive?: boolean, messages?: ChatHistoryItem[], title?: string }) {
    const currentUserId = getCurrentUserId()
    const sessionId = nanoid()
    const now = Date.now()
    const meta: ChatSessionMeta = {
      sessionId,
      userId: currentUserId,
      characterId,
      title: options?.title,
      createdAt: now,
      updatedAt: now,
    }

    const initialMessages = options?.messages?.length ? options.messages : [generateInitialMessage()]

    sessionMetas.value[sessionId] = meta
    sessionMessages.value[sessionId] = initialMessages
    ensureGeneration(sessionId)

    if (!index.value)
      index.value = { userId: currentUserId, characters: {} }

    const characterIndex = index.value.characters[characterId] ?? {
      activeSessionId: sessionId,
      sessions: {},
    }
    characterIndex.sessions[sessionId] = meta
    if (options?.setActive !== false)
      characterIndex.activeSessionId = sessionId
    index.value.characters[characterId] = characterIndex

    const record: ChatSessionRecord = { meta, messages: initialMessages }
    await enqueuePersist(() => chatSessionsRepo.saveSession(sessionId, record))
    await persistIndex()
    scheduleSync(sessionId)

    if (options?.setActive !== false)
      activeSessionId.value = sessionId

    return sessionId
  }

  async function ensureActiveSessionForCharacter() {
    const currentUserId = getCurrentUserId()
    const characterId = getCurrentCharacterId()

    if (!index.value || index.value.userId !== currentUserId)
      await loadIndexForUser(currentUserId)

    const characterIndex = getCharacterIndex(characterId)
    if (!characterIndex) {
      await createSession(characterId)
      return
    }

    if (!characterIndex.activeSessionId) {
      await createSession(characterId)
      return
    }

    activeSessionId.value = characterIndex.activeSessionId
    await loadSession(characterIndex.activeSessionId)
    ensureSession(characterIndex.activeSessionId)
  }

  async function initialize() {
    if (ready.value)
      return
    if (initializePromise)
      return initializePromise
    initializing.value = true
    bindSessionBus()
    initializePromise = (async () => {
      // 개발 환경: VITE_DEV_CLEAR_CHAT=1 이면 세션 로드 전에 DB 먼저 초기화
      if (import.meta.env.DEV && import.meta.env.VITE_DEV_CLEAR_CHAT === '1') {
        const currentUserId = getCurrentUserId()
        // DB에서 index 강제 로드해서 모든 sessionId 수집 후 삭제
        const existingIndex = await chatSessionsRepo.getIndex(currentUserId)
        if (existingIndex) {
          for (const character of Object.values(existingIndex.characters)) {
            for (const sessionId of Object.keys(character.sessions))
              await chatSessionsRepo.deleteSession(sessionId)
          }
        }
        // 빈 index 저장
        await chatSessionsRepo.saveIndex({ userId: currentUserId, characters: {} })
        index.value = { userId: currentUserId, characters: {} }
        // eslint-disable-next-line no-console
        console.debug('[session-store] VITE_DEV_CLEAR_CHAT: chat DB cleared')
      }

      await ensureActiveSessionForCharacter()
      ready.value = true
    })()

    try {
      await initializePromise
    }
    finally {
      initializePromise = null
      initializing.value = false
    }
  }


  function ensureSession(sessionId: string) {
    ensureGeneration(sessionId)
    if (!sessionMessages.value[sessionId] || sessionMessages.value[sessionId].length === 0) {
      sessionMessages.value[sessionId] = [generateInitialMessage()]
      void persistSession(sessionId)
    }
  }

  const messages = computed<ChatHistoryItem[]>({
    get: () => {
      if (!activeSessionId.value)
        return []
      ensureSession(activeSessionId.value)
      if (ready.value)
        void loadSession(activeSessionId.value)
      return sessionMessages.value[activeSessionId.value] ?? []
    },
    set: (value) => {
      if (!activeSessionId.value)
        return
      sessionMessages.value[activeSessionId.value] = value
      void persistSession(activeSessionId.value)
    },
  })

  function setActiveSession(sessionId: string) {
    activeSessionId.value = sessionId
    ensureSession(sessionId)

    const characterId = getCurrentCharacterId()
    const characterIndex = index.value?.characters[characterId]
    if (characterIndex) {
      characterIndex.activeSessionId = sessionId
      void persistIndex()
    }

    if (ready.value)
      void loadSession(sessionId)
  }

  function cleanupMessages(sessionId = activeSessionId.value) {
    ensureGeneration(sessionId)
    sessionGenerations.value[sessionId] += 1
    setSessionMessages(sessionId, [generateInitialMessage()])
    // 다음 loadSession 호출 시 DB에서 다시 읽도록 캐시 제거
    loadedSessions.delete(sessionId)
  }

  function getAllSessions() {
    return JSON.parse(JSON.stringify(sessionMessages.value)) as Record<string, ChatHistoryItem[]>
  }

  async function resetAllSessions() {
    const currentUserId = getCurrentUserId()
    const characterId = getCurrentCharacterId()
    const sessionIds = new Set<string>()

    // index가 아직 로드되지 않았거나 userId가 다르면 DB에서 강제 로드
    if (!index.value || index.value.userId !== currentUserId)
      await loadIndexForUser(currentUserId)

    if (index.value) {
      for (const character of Object.values(index.value.characters)) {
        for (const sessionId of Object.keys(character.sessions))
          sessionIds.add(sessionId)
      }
    }

    // 현재 메모리에 있는 세션도 모두 포함
    for (const sessionId of Object.keys(sessionMessages.value))
      sessionIds.add(sessionId)
    for (const sessionId of Object.keys(sessionMetas.value))
      sessionIds.add(sessionId)

    // 모든 세션 DB에서 삭제
    for (const sessionId of sessionIds)
      await enqueuePersist(() => chatSessionsRepo.deleteSession(sessionId))

    // 빈 index를 DB에 명시적으로 저장
    const emptyIndex = { userId: currentUserId, characters: {} }
    await enqueuePersist(() => chatSessionsRepo.saveIndex(emptyIndex))

    sessionMessages.value = {}
    sessionMetas.value = {}
    sessionGenerations.value = {}
    loadedSessions.clear()
    loadingSessions.clear()

    index.value = emptyIndex

    await createSession(characterId)
  }

  function getSessionMessages(sessionId: string) {
    ensureSession(sessionId)
    if (ready.value)
      void loadSession(sessionId)
    return sessionMessages.value[sessionId] ?? []
  }

  function getSessionGeneration(sessionId: string) {
    ensureGeneration(sessionId)
    return sessionGenerations.value[sessionId] ?? 0
  }

  function bumpSessionGeneration(sessionId: string) {
    ensureGeneration(sessionId)
    sessionGenerations.value[sessionId] += 1
    return sessionGenerations.value[sessionId]
  }

  /**
   * TTS 재생 완료된 텍스트를 assistant 메시지로 session history에 추가한다.
   * 마지막 메시지가 assistant이면 append, 아니면 새로 push.
   * playbackManager.onEnd마다 청크별로 호출된다.
   *
   * @param sessionId 대상 세션 ID
   * @param spokenText 재생 완료된 청크 텍스트
   */
  function commitSpokenMessage(sessionId: string, spokenText: string) {
    const text = spokenText.trim()
      ; (window as any).logChat?.('[DEBUG] commitSpokenMessage sessionId=' + sessionId + ' text=' + text.slice(0, 40))
    if (!text)
      return
    const msgs = sessionMessages.value[sessionId]
      ; (window as any).logChat?.('[DEBUG] commitSpokenMessage msgs=' + (msgs ? 'array(' + msgs.length + ')' : 'UNDEFINED'))
    if (!msgs)
      return

    const lastIdx = msgs.length - 1
    const last = msgs[lastIdx]
    if (last?.role === 'assistant') {
      // 직접 mutation 대신 splice로 새 객체 교체 → Vue reactivity 확실히 트리거
      const newContent = (last.content as string) + ' ' + text
      const updated: ChatHistoryItem = {
        ...last,
        content: newContent,
        slices: [{ type: 'text', text: newContent }],
      }
      msgs.splice(lastIdx, 1, updated)
    }
    else {
      msgs.push({
        role: 'assistant',
        content: text,
        createdAt: Date.now(),
        id: nanoid(),
        slices: [{ type: 'text', text }],
        tool_results: [],
      } as ChatHistoryItem)
    }
    persistSessionMessages(sessionId)
  }

  /**
   * TTS 창(Stage.vue)에서 보낸 sessionSpokenCommitEvent를 수신해
   * 이 창의 in-memory session을 직접 갱신한다.
   * DB 재읽기 없이 크로스윈도우 동기화가 가능하다.
   */
  function bindSessionBus() {
    const context = getSessionBusContext()
    context.on(sessionSpokenCommitEvent, (evt) => {
      const payload = (evt as { body?: SessionSpokenCommitPayload })?.body
      if (!payload?.sessionId || !payload?.text)
        return
      commitSpokenMessage(payload.sessionId, payload.text)
    })
  }

  function getSessionGenerationValue(sessionId?: string) {
    const target = sessionId ?? activeSessionId.value
    return getSessionGeneration(target)
  }

  async function forkSession(options: { fromSessionId: string, atIndex?: number, reason?: string, hidden?: boolean }) {
    const characterId = getCurrentCharacterId()
    const parentMessages = getSessionMessages(options.fromSessionId)
    const forkIndex = options.atIndex ?? parentMessages.length
    const nextMessages = parentMessages.slice(0, forkIndex)
    return await createSession(characterId, { setActive: false, messages: nextMessages })
  }

  async function exportSessions(): Promise<ChatSessionsExport> {
    if (!ready.value)
      await initialize()

    if (!index.value) {
      return {
        format: 'chat-sessions-index:v1',
        index: { userId: getCurrentUserId(), characters: {} },
        sessions: {},
      }
    }

    const sessions: Record<string, ChatSessionRecord> = {}
    for (const character of Object.values(index.value.characters)) {
      for (const sessionId of Object.keys(character.sessions)) {
        const stored = await chatSessionsRepo.getSession(sessionId)
        if (stored) {
          sessions[sessionId] = stored
          continue
        }
        const meta = sessionMetas.value[sessionId]
        const messages = sessionMessages.value[sessionId]
        if (meta && messages)
          sessions[sessionId] = { meta, messages }
      }
    }

    return {
      format: 'chat-sessions-index:v1',
      index: index.value,
      sessions,
    }
  }

  async function importSessions(payload: ChatSessionsExport) {
    if (payload.format !== 'chat-sessions-index:v1')
      return

    index.value = payload.index
    sessionMessages.value = {}
    sessionMetas.value = {}
    sessionGenerations.value = {}
    loadedSessions.clear()
    loadingSessions.clear()

    await enqueuePersist(() => chatSessionsRepo.saveIndex(payload.index))

    for (const [sessionId, record] of Object.entries(payload.sessions)) {
      sessionMetas.value[sessionId] = record.meta
      sessionMessages.value[sessionId] = record.messages
      ensureGeneration(sessionId)
      await enqueuePersist(() => chatSessionsRepo.saveSession(sessionId, record))
    }

    await ensureActiveSessionForCharacter()
  }

  watch([userId, activeCardId], () => {
    if (!ready.value)
      return
    void ensureActiveSessionForCharacter()
  })

  return {
    ready,
    isReady,
    initialize,

    activeSessionId,
    messages,

    setActiveSession,
    cleanupMessages,
    getAllSessions,
    resetAllSessions,

    ensureSession,
    setSessionMessages,
    persistSessionMessages,
    getSessionMessages,
    getSessionGeneration,
    bumpSessionGeneration,
    commitSpokenMessage,
    getSessionGenerationValue,

    forkSession,
    exportSessions,
    importSessions,
  }
})
