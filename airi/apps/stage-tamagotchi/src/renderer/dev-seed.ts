// 개발 전용: .env.local 설정 → localStorage 자동 주입
// 프로덕션 빌드에는 포함되지 않음 (import.meta.env.DEV 가드)
//
// 사용법:
//   apps/stage-web/.env.local 파일에 설정 → 앱 재시작 시 자동 적용
//   이미 설정된 값은 덮어쓰지 않음 (VITE_DEV_FORCE=1 로 강제 override 가능)

if (import.meta.env.DEV) {
    const force = import.meta.env.VITE_DEV_FORCE === '1'

    function setIfEmpty(key: string, value: string) {
        if (force || !localStorage.getItem(key)) {
            localStorage.setItem(key, value)
            // eslint-disable-next-line no-console
            console.debug(`[dev-seed] ${key} = ${value.slice(0, 40)}...`)
        }
    }

    // ── 1. API 키 주입 ─────────────────────────────────────────────────
    const CREDS_KEY = 'settings/credentials/providers'
    let creds: Record<string, Record<string, unknown>> = {}
    try {
        creds = JSON.parse(localStorage.getItem(CREDS_KEY) ?? '{}')
    }
    catch { creds = {} }

    let credsUpdated = false

    // Gemini (Google AI) — Airi 내부 ID: 'google-generative-ai'
    if (import.meta.env.VITE_GEMINI_API_KEY && (force || !creds['google-generative-ai']?.apiKey)) {
        const geminiCred = {
            apiKey: import.meta.env.VITE_GEMINI_API_KEY,
            baseUrl: import.meta.env.VITE_GEMINI_BASE_URL
                ?? 'https://generativelanguage.googleapis.com/v1beta/openai/',
        }
        creds['google-generative-ai'] = geminiCred
        creds['gemini'] = geminiCred // 호환성 유지
        credsUpdated = true
    }

    // Grok (xAI)
    if (import.meta.env.VITE_GROK_API_KEY && (force || !creds['grok']?.apiKey)) {
        creds['grok'] = {
            apiKey: import.meta.env.VITE_GROK_API_KEY,
            baseUrl: import.meta.env.VITE_GROK_BASE_URL ?? 'https://api.x.ai/v1/',
        }
        credsUpdated = true
    }

    // OpenAI Compatible (로컬 llama.cpp, Ollama 등)
    if (import.meta.env.VITE_OPENAI_COMPAT_API_KEY && (force || !creds['openai-compatible']?.apiKey)) {
        creds['openai-compatible'] = {
            apiKey: import.meta.env.VITE_OPENAI_COMPAT_API_KEY,
            baseUrl: import.meta.env.VITE_OPENAI_COMPAT_BASE_URL ?? 'http://localhost:11434/v1/',
        }
        credsUpdated = true
    }

    if (credsUpdated)
        localStorage.setItem(CREDS_KEY, JSON.stringify(creds))

    // ── 2. 활성 프로바이더 / 모델 설정 ────────────────────────────────
    // consciousness store 키
    if (import.meta.env.VITE_ACTIVE_PROVIDER)
        setIfEmpty('settings/consciousness/active-provider', import.meta.env.VITE_ACTIVE_PROVIDER)

    if (import.meta.env.VITE_ACTIVE_MODEL)
        setIfEmpty('settings/consciousness/active-model', import.meta.env.VITE_ACTIVE_MODEL)

    if (import.meta.env.VITE_ACTIVE_CUSTOM_MODEL)
        setIfEmpty('settings/consciousness/active-custom-model', import.meta.env.VITE_ACTIVE_CUSTOM_MODEL)

    // ── 3. 프로바이더 활성화 (UI에서 "추가"한 것처럼 처리) ──────────────
    if (import.meta.env.VITE_ACTIVE_PROVIDER) {
        const ADDED_KEY = 'settings/providers/added'
        let added: Record<string, boolean> = {}
        try {
            added = JSON.parse(localStorage.getItem(ADDED_KEY) ?? '{}')
        }
        catch { added = {} }

        const pid = import.meta.env.VITE_ACTIVE_PROVIDER
        if (force || !added[pid]) {
            added[pid] = true
            // Airi 내부적으로 Gemini = 'google-generative-ai' ID로 체크함
            if (pid === 'gemini')
                added['google-generative-ai'] = true
            localStorage.setItem(ADDED_KEY, JSON.stringify(added))
        }
    }

    // ── 4. TTS(Speech) 프로바이더 / 모델 설정 ──────────────────────────
    if (import.meta.env.VITE_TTS_PROVIDER)
        setIfEmpty('settings/speech/active-provider', import.meta.env.VITE_TTS_PROVIDER)

    if (import.meta.env.VITE_TTS_MODEL)
        setIfEmpty('settings/speech/active-model', import.meta.env.VITE_TTS_MODEL)

    // TTS 프로바이더도 "added" 목록에 등록해 UI에 보이도록 처리
    if (import.meta.env.VITE_TTS_PROVIDER) {
        const ADDED_KEY = 'settings/providers/added'
        let added: Record<string, boolean> = {}
        try {
            added = JSON.parse(localStorage.getItem(ADDED_KEY) ?? '{}')
        }
        catch { added = {} }

        const ttsId = import.meta.env.VITE_TTS_PROVIDER
        if (force || !added[ttsId]) {
            added[ttsId] = true
            localStorage.setItem(ADDED_KEY, JSON.stringify(added))
        }
    }

    // TTS provider baseUrl / voice → credentials + speech/voice에 주입
    if (import.meta.env.VITE_TTS_BASE_URL || import.meta.env.VITE_TTS_VOICE) {
        const ttsId = import.meta.env.VITE_TTS_PROVIDER
        if (ttsId) {
            // provider credentials에 baseUrl 주입
            if (import.meta.env.VITE_TTS_BASE_URL) {
                const CREDS_KEY = 'settings/credentials/providers'
                let creds: Record<string, Record<string, unknown>> = {}
                try { creds = JSON.parse(localStorage.getItem(CREDS_KEY) ?? '{}') }
                catch { creds = {} }
                if (force || !creds[ttsId]?.baseUrl) {
                    creds[ttsId] = {
                        ...(creds[ttsId] ?? {}),
                        baseUrl: import.meta.env.VITE_TTS_BASE_URL,
                    }
                    localStorage.setItem(CREDS_KEY, JSON.stringify(creds))
                }
            }
            // voice ID 주입
            if (import.meta.env.VITE_TTS_VOICE)
                setIfEmpty('settings/speech/voice', import.meta.env.VITE_TTS_VOICE)
        }
    }

    // ── 5. Onboarding skip (설정 다이얼로그 표시 안 함) ────────────────
    if (force || !localStorage.getItem('onboarding/skipped')) {
        localStorage.setItem('onboarding/skipped', 'true')
        // eslint-disable-next-line no-console
        console.debug('[dev-seed] onboarding/skipped = true')
    }

    // ── 6. 채팅 기록 초기화 (VITE_DEV_CLEAR_CHAT=1 시에만) ────────────
    // ✅ IndexedDB 초기화는 session-store.initialize()에서 처리됨
    //    (dev-seed에서 직접 IndexedDB를 건드리면 race condition 발생)
    if (import.meta.env.VITE_DEV_CLEAR_CHAT === '1') {
        // localStorage chat/message/session 키 제거
        const chatKeys = Object.keys(localStorage).filter(k =>
            k.includes('chat') || k.includes('message') || k.includes('session'),
        )
        chatKeys.forEach(k => localStorage.removeItem(k))
        // eslint-disable-next-line no-console
        if (chatKeys.length > 0)
            console.debug(`[dev-seed] cleared localStorage keys:`, chatKeys)
    }


    // eslint-disable-next-line no-console
    console.debug('[dev-seed] Done. VITE_DEV_FORCE=1 to override existing settings.')
}
