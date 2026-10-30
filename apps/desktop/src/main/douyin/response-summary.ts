import type { RuntimeEventInput } from '../../shared/runtime-events'
import type { Operation } from './page-request'
import { assertBusinessResponse, failureResponseType, failureRule } from './response-policy'

/** Only bounded metadata leaves the engine. No body, URL, cursor or credential
 * is retained, including when the response cannot be parsed. */
export function responseSummary(
  body: string,
  status: number,
  operation?: string
): Pick<RuntimeEventInput, 'responseType' | 'count' | 'shape' | 'rule' | 'platformCode'> {
  if (body.length > 16 * 1024 * 1024) return { responseType: 'oversized', rule: 'body.oversized' }
  if (status < 200 || status >= 300)
    return {
      responseType: 'http-error',
      rule: status === 401 || status === 403 ? 'http.auth' : status === 429 ? 'http.rate_limit' : 'http.error'
    }
  if (!body.trim()) return { responseType: 'empty-body', rule: 'body.empty' }
  if (/<(?:html|!doctype)/i.test(body.slice(0, 500))) return { responseType: 'html', rule: 'body.html' }
  try {
    const data = JSON.parse(body)
    if (!data || typeof data !== 'object' || Array.isArray(data))
      return { responseType: 'json', rule: 'payload.invalid_type' }
    if (!Object.keys(data).length) return { responseType: 'empty-body', rule: 'payload.empty_object' }
    // Only small numeric status codes are retained, never platform messages.
    const rawCode =
      typeof data.status_code === 'string' || Number.isSafeInteger(data.status_code)
        ? String(data.status_code)
        : ''
    const platformCode = /^-?\d{1,12}$/.test(rawCode) ? rawCode : undefined
    const items = operation === 'folders' ? data.collects_list : data.aweme_list
    const fieldType = (value: unknown) =>
      value === undefined
        ? '缺失'
        : value === null
          ? 'null'
          : Array.isArray(value)
            ? `数组(${value.length})`
            : typeof value
    const shape = ['favorites', 'folders', 'folderItems'].includes(operation ?? '')
      ? `${operation === 'folders' ? 'collects_list' : 'aweme_list'}=${fieldType(items)}；has_more=${[0, 1, false, true, '0', '1'].includes(data.has_more) ? String(data.has_more) : fieldType(data.has_more)}；status_code=${String(data.status_code) === '0' ? '0' : fieldType(data.status_code)}`
      : undefined
    try {
      assertBusinessResponse(data, { operation: operation as Operation | undefined })
    } catch (error) {
      return {
        responseType: failureResponseType((error as { code?: string }).code) ?? 'api-error',
        rule: failureRule(error),
        ...(platformCode === undefined ? {} : { platformCode }),
        ...(shape ? { shape } : {})
      }
    }
    if (
      items == null &&
      ['favorites', 'folders', 'folderItems'].includes(operation ?? '') &&
      String(data.status_code) === '0' &&
      [0, false, '0'].includes(data.has_more)
    )
      return { responseType: 'terminal-list', count: 0, shape }
    if (Array.isArray(items))
      return {
        responseType: [0, false, '0'].includes(data.has_more)
          ? 'terminal-list'
          : items.length
            ? 'list'
            : 'empty-list',
        count: items.length,
        shape
      }
    return { responseType: data.user ? 'identity' : 'json', shape }
  } catch {
    return { responseType: 'invalid-json', rule: 'body.invalid_json' }
  }
}
