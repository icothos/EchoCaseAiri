/**
 * stage-ui용 Gemini 유틸 — @proj-airi/gemini-utils 래퍼
 *
 * 범용 Gemini 기능은 @proj-airi/gemini-utils에서 가져오고,
 * xsai ChatProvider 타입에 의존하는 stage-ui 전용 헬퍼만 여기 정의.
 */

import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message, Tool } from '@xsai/shared-chat'

import { isGeminiUrl, streamGemini } from '@proj-airi/gemini-utils'

// 범용 Gemini 유틸 — 공유 패키지에서 re-export
export {
    callGemini,
    countGeminiTokens,
    getGenAI,
    isGeminiUrl,
    streamGemini,
} from '@proj-airi/gemini-utils'
export type { GeminiMessage, GeminiStreamChunk, GeminiStreamOptions } from '@proj-airi/gemini-utils'

/**
 * xsai ChatProvider 기반 Gemini 판별
 * (stage-ui 전용 — xsai 타입 의존)
 */
export function isGeminiProvider(chatProvider: ChatProvider, model: string): boolean {
    try {
        return isGeminiUrl(String(chatProvider.chat(model).baseURL ?? ''))
    }
    catch {
        return false
    }
}

/**
 * xsai Message[] / Tool[] 기반 Gemini 스트리밍
 * (stage-ui 전용 — xsai 타입 의존)
 */
export async function streamGeminiNative(
    model: string,
    apiKey: string,
    promptNode: Message,
    messages: Message[],
    tools: Tool[] | undefined,
    onEvent: (event: any) => Promise<void>,
    onLog?: (line: string) => void,
    rawSystemPrompt?: string
): Promise<void> {
    // xsai Tool → gemini-utils 포맷 변환
    const geminiTools = tools && tools.length > 0
        ? tools.map((t: any) => ({
            name: t.function?.name ?? t.name ?? '',
            description: t.function?.description ?? t.description ?? '',
            parameters: t.function?.parameters ?? t.parameters,
        }))
        : undefined

    await streamGemini({
        apiKey,
        model,
        promptNode: promptNode as any,
        messages: messages as any,
        tools: geminiTools,
        onEvent,
        onLog,
        rawSystemPrompt
    })
}
