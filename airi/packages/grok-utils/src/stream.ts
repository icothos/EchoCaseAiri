/**
 * Grok streaming completion package using @ai-sdk/xai
 * For `stage-ui` native integration mirroring `gemini-utils`
 */

import { createXai } from '@ai-sdk/xai'
import { streamText, type CoreMessage } from 'ai'

// Simple fast string hashing for prompt deduplication & cache keys
function cyrb53(str: string, seed = 0) {
    let h1 = 0xDEADBEEF ^ seed
    let h2 = 0x41C6CE57 ^ seed
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i)
        h1 = Math.imul(h1 ^ ch, 2654435761)
        h2 = Math.imul(h2 ^ ch, 1597334677)
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

const _seenPromptHashes = new Set<string>()
let _reqCounter = 0

export type GrokStreamChunk
    = | { type: 'text-delta', text: string }
    | { type: 'tool-call', toolCallId: string, toolName: string, args: Record<string, unknown> }
    | { type: 'finish', finishReason: string, usage: any | null }
    | { type: 'error', error: unknown }

export interface GrokStreamOptions {
    baseUrl?: string
    apiKey: string
    model: string
    promptNode?: { role?: string, content: unknown }
    rawSystemPrompt?: string
    messages: Array<{ role: string, content: unknown }>
    tools?: Array<any>
    onEvent: (event: GrokStreamChunk) => Promise<void>
    onLog?: (line: string) => void
}

export async function streamGrok(opts: GrokStreamOptions): Promise<void> {
    const { apiKey, model, promptNode, rawSystemPrompt, messages, tools, onEvent, onLog } = opts

    const _log = (line: string) => {
        // eslint-disable-next-line no-console
        console.debug(line)
        onLog?.(line)
    }

    const xaiOptions: any = { apiKey }

    const xai = createXai(xaiOptions)

    // --- PromptNode Text Formatting & Hashing ---
    let promptNodeText = ''
    let promptHashStr = ''
    let isPromptCachedInLogs = false

    if (promptNode) {
        promptNodeText = typeof promptNode.content === 'string'
            ? promptNode.content
            : Array.isArray(promptNode.content)
                ? (promptNode.content as any[]).map((c: any) => c.text ?? JSON.stringify(c)).join('')
                : JSON.stringify(promptNode.content)
    }

    const textToHash = rawSystemPrompt || promptNodeText

    if (textToHash.trim()) {
        promptHashStr = cyrb53(textToHash).toString(16)
        if (_seenPromptHashes.has(promptHashStr)) {
            isPromptCachedInLogs = true
        } else {
            _seenPromptHashes.add(promptHashStr)
        }
    }

    // --- Logging format Setup ---
    const ts0 = new Date().toISOString().slice(11, 23)
    _reqCounter++
    const reqId = _reqCounter.toString().padStart(4, '0')
    const reqTag = `[#${reqId}] `

    const pureSystemPrompt = rawSystemPrompt || promptNodeText
    let extractedDynamicContext = ''

    if (rawSystemPrompt && promptNodeText !== rawSystemPrompt) {
        extractedDynamicContext = promptNodeText.replace(rawSystemPrompt, '').trim()
    }

    let promptLog = ''
    if (promptNodeText) {
        if (isPromptCachedInLogs) {
            promptLog = `  [system (PromptNode Persona)] [PROMPT_HASH: ${promptHashStr}] (Static persona omitted)\n`
        } else {
            promptLog = `  [system (PromptNode Persona)] [NEW_PROMPT_HASH: ${promptHashStr}]\n${pureSystemPrompt}\n`
        }

        if (extractedDynamicContext) {
            promptLog += `  [system (Injected Dynamic Context)]\n${extractedDynamicContext}\n`
        }
    }

    const extractText = (content: unknown): string => {
        if (typeof content === 'string') return content
        if (Array.isArray(content)) return (content as any[]).map((c: any) => c.text ?? JSON.stringify(c)).join(' ')
        return JSON.stringify(content)
    }

    const messagesLog = messages.map(m => {
        const text = extractText(m.content)
        return `  [${m.role}] ${text}`
    }).join('\n')

    _log(`${reqTag}[GROK→] ${ts0} ${model} | ${messages.length} msgs\n${promptLog}${messagesLog}`)
    const startedAt = Date.now()

    // --- Construct Request Payload for AI SDK ---
    const payloadMessages: CoreMessage[] = []

    for (let i = 0; i < messages.length; i++) {
        let textValue = extractText(messages[i].content)
        if (i === 0 && extractedDynamicContext && messages[i].role !== 'system') {
            textValue = extractedDynamicContext + '\n\n' + textValue
        }
        payloadMessages.push({
            role: (messages[i].role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
            content: textValue
        })
    }

    // Tool formatting for Vercel AI SDK
    const aiTools: Record<string, any> = {}
    if (tools && tools.length > 0) {
        for (const t of tools) {
            aiTools[t.name] = {
                description: t.description || '',
                parameters: t.parameters || { type: 'object', properties: {} }
            }
        }
    }

    try {
        const result = streamText({
            model: xai.languageModel(model),
            system: pureSystemPrompt || undefined,
            messages: payloadMessages,
            // Only pass tools if they exist, otherwise Vercel AI SDK might throw or behave unexpectedly
            ...(Object.keys(aiTools).length > 0 ? { tools: aiTools as any } : {}),
            maxSteps: 10
        })

        let fullText = ''

        // Listen to full stream chunks to catch text, tool calls and finish events
        for await (const chunk of result.fullStream) {
            if (chunk.type === 'text-delta') {
                fullText += chunk.textDelta
                await onEvent({ type: 'text-delta', text: chunk.textDelta })
            } else if (chunk.type === 'tool-call') {
                await onEvent({
                    type: 'tool-call',
                    toolCallId: chunk.toolCallId,
                    toolName: chunk.toolName,
                    args: chunk.args as Record<string, unknown>
                })
            } else if (chunk.type === 'finish') {
                const ms = Date.now() - startedAt
                const ts1 = new Date().toISOString().slice(11, 23)

                const usage = chunk.usage
                const usageMetadata = usage ? {
                    prompt_token_count: usage.promptTokens,
                    candidates_token_count: usage.completionTokens,
                    total_token_count: usage.totalTokens
                } : null

                const tokenInfo = usageMetadata
                    ? `tokens:${JSON.stringify(usageMetadata)}`
                    : `~${Math.round(fullText.length / 2)}tok est.`

                _log(`${reqTag}[GROK←] ${ts1} ${ms}ms | ${tokenInfo}\n  [assistant] ${fullText}`)

                await onEvent({
                    type: 'finish',
                    finishReason: chunk.finishReason,
                    usage: usageMetadata
                })
            } else if (chunk.type === 'error') {
                throw chunk.error
            }
        }

    } catch (e) {
        _log(`${reqTag}[GROK ERROR] ${e}`)
        await onEvent({ type: 'error', error: e })
        throw e
    }
}
