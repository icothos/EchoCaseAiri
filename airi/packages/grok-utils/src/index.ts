/**
 * Grok streaming completion package
 * For `stage-ui` native integration mirroring `gemini-utils`
 */

export * from './stream'

export function isGrokUrl(url: string | URL): boolean {
    const s = typeof url === 'string' ? url : url.href
    return s.includes('api.x.ai') || s.includes('grok')
}
