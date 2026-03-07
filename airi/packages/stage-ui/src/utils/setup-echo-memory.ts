import { useChatContextStore } from '../stores/chat/context-store'
import { useChatOrchestratorStore } from '../stores/chat'

// A flag to ensure we don't try to mount multiple times if called concurrently
let isEchoMemoryMounting = false

const _seenSystemHashesForFile = new Set<string>()

export async function setupEchoMemory() {
    if (typeof window === 'undefined') return
    if ((window as any).__echoMemory) {
        console.info('[setup-echo-memory] Bouncer is already mounted. Skipping duplicate setup.')
        return
    }

    if (isEchoMemoryMounting) {
        console.info('[setup-echo-memory] Bouncer is currently mounting. Skipping.')
        return
    }

    isEchoMemoryMounting = true

    try {
        const { createLLMLogger, mountEchoMemory, setGlobalLLMLogger } = await import('@proj-airi/echo-memory')

        const echoLogger = createLLMLogger({
            prefix: '[echo-memory]',
            silent: true,
            onLog: (entry: any) => {
                if (typeof (window as any).logLLM === 'function') {
                    const ts = new Date(entry.timestamp).toISOString().slice(11, 23)
                    const dir = entry.direction === 'REQUEST' ? 'REQ' : 'RES'
                    const dur = entry.durationMs !== undefined ? ` (${entry.durationMs}ms)` : ''
                    const model = entry.model ? ` [${entry.model}]` : ''
                    const cleanContent = entry.content
                    const preview = entry.inputPreview ? ` | input: ${entry.inputPreview}` : ''

                    let systemStr = ''
                    if (entry.systemPrompt && entry.systemHash) {
                        if (!_seenSystemHashesForFile.has(entry.systemHash)) {
                            _seenSystemHashesForFile.add(entry.systemHash)
                            systemStr = `\n  [System Prompt Hash: ${entry.systemHash}]\n  ${entry.systemPrompt}`
                        }
                        else {
                            systemStr = `\n  [System Prompt Hash: ${entry.systemHash}] (Omitted)`
                        }
                    }

                    const line = `[echo-memory] ${ts} [${entry.role}]${model} ${dir}${dur}${preview}${systemStr}\n  ${cleanContent}`
                        ; (window as any).logLLM(line).catch(() => { })
                }
            }
        })
        setGlobalLLMLogger(echoLogger)

        const { useSettingsBouncer } = await import('../stores/settings/bouncer')
        const bouncerSettings = useSettingsBouncer()

        if (!bouncerSettings.baseUrl || !bouncerSettings.enabled) {
            console.info('[echo-memory] 비활성화 (Bouncer URL 미설정 또는 설정에서 꺼짐)')
            return
        }

        const geminiBase = import.meta.env.VITE_GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta/openai/'
        const geminiKey = import.meta.env.VITE_GEMINI_API_KEY

        const summarizerHasGemini = !bouncerSettings.summarizerBaseUrl && geminiKey
        const progressHasGemini = !bouncerSettings.progressBaseUrl && geminiKey

        const chatOrchestratorStore = useChatOrchestratorStore()
        const chatContextStore = useChatContextStore()

            ; (window as any).__echoMemory = mountEchoMemory(
                chatOrchestratorStore,
                chatContextStore,
                {
                    bouncer: {
                        baseUrl: bouncerSettings.baseUrl,
                        apiKey: bouncerSettings.apiKey || geminiKey || undefined,
                        model: bouncerSettings.model ?? 'local-model',
                        timeoutMs: Number(bouncerSettings.timeoutMs ?? 5000),
                    },
                    ...(bouncerSettings.summarizerBaseUrl
                        ? {
                            summarizerLLM: {
                                baseUrl: bouncerSettings.summarizerBaseUrl,
                                apiKey: bouncerSettings.summarizerApiKey || geminiKey || undefined,
                                model: bouncerSettings.summarizerModel ?? 'local-model',
                            },
                        }
                        : summarizerHasGemini
                            ? {
                                summarizerLLM: {
                                    baseUrl: `${geminiBase.replace(/\/$/, '')}/`,
                                    apiKey: geminiKey,
                                    model: bouncerSettings.summarizerModel ?? import.meta.env.VITE_ACTIVE_MODEL ?? 'gemini-2.0-flash-lite',
                                },
                            }
                            : {}),
                    ...(bouncerSettings.progressBaseUrl
                        ? {
                            progressLLM: {
                                baseUrl: bouncerSettings.progressBaseUrl,
                                apiKey: bouncerSettings.progressApiKey || geminiKey || undefined,
                                model: bouncerSettings.progressModel ?? 'local-model',
                            },
                        }
                        : progressHasGemini
                            ? {
                                progressLLM: {
                                    baseUrl: `${geminiBase.replace(/\/$/, '')}/`,
                                    apiKey: geminiKey,
                                    model: bouncerSettings.progressModel ?? import.meta.env.VITE_ACTIVE_MODEL ?? 'gemini-2.0-flash-lite',
                                },
                            }
                            : {}),
                },
            )
        console.info('[echo-memory] mounted via singleton util')
    } finally {
        isEchoMemoryMounting = false
    }
}
