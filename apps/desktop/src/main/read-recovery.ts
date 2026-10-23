// Shared policy for read-only collection. No remote write uses these retries.
export const retryableRead = (code: string) =>
  ['NETWORK_ERROR', 'TIMEOUT', 'BROWSER_NOT_READY', 'PAGE_CHANGED', 'INVALID_RESPONSE'].includes(code)
export const rebuildReadPage = (code: string, retries: number, visible: boolean) =>
  retries === 1 &&
  !visible &&
  ['TIMEOUT', 'BROWSER_NOT_READY', 'PAGE_CHANGED', 'INVALID_RESPONSE'].includes(code)
