// P2: Fast-path Filter
// Python tri_core_memory_agent.py `_fast_path_filter()` → TypeScript 포팅

const KOREAN_FILLER_RE = /^[ㅋㅎㅠㅜㅡ]+$/
const EMOJI_ONLY_RE = /^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}]+$/u
const SPECIAL_CHAR_SPAM_RE = /^[^\w\s\uAC00-\uD7A3\u3131-\u314E\u314F-\u3163]+$/

/**
 * sLLM 호출 전 규칙 기반 빠른 필터.
 * true 반환 → drop (ignore), false → sLLM Bouncer로 전달.
 */
export function shouldDropFast(text: string): boolean {
    const stripped = text.trim()

    // 빈 메시지
    if (!stripped)
        return true

    // Rule 1: 순수 한국어 필러 (ㅋㅋ, ㅎㅎ, ㅠㅠ 등)
    if (KOREAN_FILLER_RE.test(stripped))
        return true

    // Rule 2: 순수 이모지
    if (EMOJI_ONLY_RE.test(stripped))
        return true

    // Rule 3: 1글자 이하 (? ! 제외)
    const withoutSpaces = stripped.replace(/\s/g, '')
    if (withoutSpaces.length <= 1 && !/[?!？！]/.test(stripped))
        return true

    // Rule 4: 특수문자 스팸 (한글/영문/공백 없음)
    if (SPECIAL_CHAR_SPAM_RE.test(stripped))
        return true

    return false
}

/** 치지직 닉네임 접두사 제거: "[에코바라기님이 말했습니다]: 텍스트" → "텍스트" */
const CHZZK_PREFIX_RE = /^\[[^\]]+님이 말했습니다\]:\s*/

export function stripChzzkPrefix(text: string): string {
    return text.replace(CHZZK_PREFIX_RE, '').trim() || text
}
