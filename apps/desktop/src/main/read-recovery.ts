import { AppError } from './errors'

// Shared policy for read-only collection. No remote write uses these retries.
export const retryableRead = (code: string) =>
  [
    'NETWORK_ERROR',
    'TIMEOUT',
    'BROWSER_NOT_READY',
    'PAGE_CHANGED',
    'INVALID_RESPONSE',
    'EMPTY_RESPONSE',
    'EMPTY_PAGE'
  ].includes(code)
export const rebuildReadPage = (code: string, retries: number, visible: boolean) =>
  retries === 1 &&
  !visible &&
  [
    'TIMEOUT',
    'BROWSER_NOT_READY',
    'PAGE_CHANGED',
    'INVALID_RESPONSE',
    'EMPTY_PAGE',
    'EMPTY_RESPONSE'
  ].includes(code)

export const readRetryDelay = (code: string, retry: number, base: number) =>
  base * (['EMPTY_PAGE', 'EMPTY_RESPONSE'].includes(code) ? 5 : 1) * 3 ** retry

/** A single successful-looking end marker can be a temporary platform reply.
 * Confirm the same cursor and item set twice before committing it as an end. */
export class EndConfirmation {
  private scope = ''
  private previous = ''
  private attempts = 0
  reset() {
    this.scope = ''
    this.previous = ''
    this.attempts = 0
  }
  check(scope: string, ids: string[], hasMore: boolean): boolean {
    if (hasMore) {
      this.reset()
      return true
    }
    if (this.scope !== scope) {
      this.reset()
      this.scope = scope
    }
    const fingerprint = JSON.stringify([...new Set(ids)].sort())
    if (this.attempts && this.previous === fingerprint) return true
    this.previous = fingerprint
    if (++this.attempts >= 3)
      throw new AppError('END_UNCONFIRMED', '平台结束标记反复变化，未确认列表末尾，已暂停并保留断点。')
    return false
  }
}

/** Advancing cursors can still replay the same page forever. This is distinct
 * from legitimate full scans of already-known, but different, pages. */
export class PageProgress {
  private previous = ''
  private repeats = 0
  check(scope: string, ids: string[], hasMore: boolean) {
    const fingerprint = JSON.stringify([scope, [...new Set(ids)].sort()])
    this.repeats = fingerprint === this.previous ? this.repeats + 1 : 1
    this.previous = fingerprint
    if (hasMore && ids.length && this.repeats >= 3)
      throw new AppError('CURSOR_STALLED', '平台连续返回相同内容，已暂停并保留断点，请稍后继续。')
  }
}
