/**
 * stage-ui용 Grok 유틸 — @proj-airi/grok-utils 래퍼
 *
 * 범용 xAI/Grok 기능은 @proj-airi/grok-utils에서 가져오고,
 * xsai ChatProvider 타입에 의존하는 stage-ui 전용 헬퍼만 여기 정의.
 */

import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message, Tool } from '@xsai/shared-chat'

import { isGrokUrl, streamGrok } from '@proj-airi/grok-utils'

export { isGrokUrl, streamGrok } from '@proj-airi/grok-utils'
export type { GrokStreamChunk, GrokStreamOptions } from '@proj-airi/grok-utils'

/**
 * xsai ChatProvider 기반 Grok 판별
 * (stage-ui 전용 — xsai 타입 의존)
 */
export function isGrokProvider(chatProvider: ChatProvider, model: string): boolean {
    try {
        return isGrokUrl(String(chatProvider.chat(model).baseURL ?? '')) || model.toLowerCase().includes('grok')
    }
    catch {
        return false
    }
}

/**
 * xsai Message[] / Tool[] 기반 Grok 스트리밍
 * (stage-ui 전용 — xsai 타입 의존)
 */
export async function streamGrokNative(
    model: string,
    apiKey: string,
    promptNode: Message,
    messages: Message[],
    tools: Tool[] | undefined,
    onEvent: (event: any) => Promise<void>,
    onLog?: (line: string) => void,
    rawSystemPrompt?: string,
    attachSearchTools?: boolean
): Promise<void> {
    
    // xsai Tool → grok-utils 포맷 변환 (Grok은 OpenAI 호환 포맷을 사용)
    const grokTools = tools && tools.length > 0
        ? tools.map((t: any) => ({
            name: t.function?.name ?? t.name ?? '',
            description: t.function?.description ?? t.description ?? '',
            parameters: t.function?.parameters ?? t.parameters,
        }))
        : undefined

    await streamGrok({
        apiKey,
        model,
        promptNode: promptNode as any,
        messages: messages as any,
        tools: grokTools,
        onEvent,
        onLog,
        rawSystemPrompt,
        attachSearchTools
    })
}
