import { AppError } from './errors'

// Shared policy for read-only collection. No remote write uses these retries.
export const retryableRead = (code: string) =>
  [
    'NETWORK_ERROR',
    'TIMEOUT',
    'BROWSER_NOT_READY',
    'PAGE_CHANGED',
    'INVALID_RESPONSE',
    'EMPTY_PAGE'
  ].includes(code)
export const rebuildReadPage = (code: string, retries: number, visible: boolean) =>
  retries === 1 &&
  !visible &&
  ['TIMEOUT', 'BROWSER_NOT_READY', 'PAGE_CHANGED', 'INVALID_RESPONSE', 'EMPTY_PAGE'].includes(code)

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
