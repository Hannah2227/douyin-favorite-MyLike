import type { RuntimeEventInput } from '../../shared/runtime-events'

/** Only bounded metadata leaves the engine. No body, URL, cursor or credential
 * is retained, including when the response cannot be parsed. */
export function responseSummary(
  body: string,
  status: number
): Pick<RuntimeEventInput, 'responseType' | 'count'> {
  if (body.length > 16 * 1024 * 1024) return { responseType: 'oversized' }
  if (status < 200 || status >= 300) return { responseType: 'http-error' }
  if (!body.trim()) return { responseType: 'empty-body' }
  if (/<(?:html|!doctype)/i.test(body.slice(0, 500))) return { responseType: 'html' }
  try {
    const data = JSON.parse(body)
    if (!data || typeof data !== 'object' || !Object.keys(data).length) return { responseType: 'empty-body' }
    if (data.status_code != null && String(data.status_code) !== '0') return { responseType: 'api-error' }
    const items = data.aweme_list ?? data.collects_list
    if (Array.isArray(items))
      return {
        responseType: [0, false, '0'].includes(data.has_more)
          ? 'terminal-list'
          : items.length
            ? 'list'
            : 'empty-list',
        count: items.length
      }
    return { responseType: data.user ? 'identity' : 'json' }
  } catch {
    return { responseType: 'invalid-json' }
  }
}
