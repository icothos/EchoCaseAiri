import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'

export const useSettingsBouncer = defineStore('settings-bouncer', () => {
    const enabled = useLocalStorageManualReset<boolean>('settings/bouncer/enabled', true)
    const baseUrl = useLocalStorageManualReset<string>('settings/bouncer/base-url', import.meta.env.VITE_BOUNCER_BASE_URL ?? '')
    const apiKey = useLocalStorageManualReset<string>('settings/bouncer/api-key', import.meta.env.VITE_BOUNCER_API_KEY ?? import.meta.env.VITE_GEMINI_API_KEY ?? '')
    const model = useLocalStorageManualReset<string>('settings/bouncer/model', import.meta.env.VITE_BOUNCER_MODEL ?? 'local-model')
    const timeoutMs = useLocalStorageManualReset<number>('settings/bouncer/timeout-ms', Number(import.meta.env.VITE_BOUNCER_TIMEOUT_MS ?? 5000))

    const summarizerBaseUrl = useLocalStorageManualReset<string>('settings/bouncer/summarizer-base-url', import.meta.env.VITE_SUMMARIZER_BASE_URL ?? '')
    const summarizerApiKey = useLocalStorageManualReset<string>('settings/bouncer/summarizer-api-key', import.meta.env.VITE_SUMMARIZER_API_KEY ?? import.meta.env.VITE_GEMINI_API_KEY ?? '')
    const summarizerModel = useLocalStorageManualReset<string>('settings/bouncer/summarizer-model', import.meta.env.VITE_SUMMARIZER_MODEL ?? 'local-model')

    const progressBaseUrl = useLocalStorageManualReset<string>('settings/bouncer/progress-base-url', import.meta.env.VITE_PROGRESS_BASE_URL ?? '')
    const progressApiKey = useLocalStorageManualReset<string>('settings/bouncer/progress-api-key', import.meta.env.VITE_PROGRESS_API_KEY ?? import.meta.env.VITE_GEMINI_API_KEY ?? '')
    const progressModel = useLocalStorageManualReset<string>('settings/bouncer/progress-model', import.meta.env.VITE_PROGRESS_MODEL ?? 'local-model')

    function resetState() {
        enabled.reset()
        baseUrl.reset()
        apiKey.reset()
        model.reset()
        timeoutMs.reset()
        summarizerBaseUrl.reset()
        summarizerApiKey.reset()
        summarizerModel.reset()
        progressBaseUrl.reset()
        progressApiKey.reset()
        progressModel.reset()
    }

    return {
        enabled,
        baseUrl,
        apiKey,
        model,
        timeoutMs,
        summarizerBaseUrl,
        summarizerApiKey,
        summarizerModel,
        progressBaseUrl,
        progressApiKey,
        progressModel,
        resetState,
    }
})
