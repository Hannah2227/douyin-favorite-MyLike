import { filterSchema, type Filter } from '../../shared/contracts'
import type { AppPreferences } from '../../shared/preferences'

type BrowseMode = AppPreferences['libraryMode']
export const browseKey = (accountId: string, source: 'likes' | 'favorites') =>
  'mylike.browse.v1.' + accountId + '.' + source

export function readBrowse(key: string, accountId: string | null, source?: 'favorites') {
  const defaults: Filter = {
    accountId: accountId ?? '',
    source,
    search: '',
    mediaType: 'all',
    year: null,
    month: null,
    sort: 'published'
  }
  const number = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.max(min, Math.min(max, Math.trunc(value)))
      : fallback
  try {
    const entry = key ? JSON.parse(localStorage.getItem(key) ?? 'null') : null
    if (entry) {
      const parsed = filterSchema.safeParse({
        ...entry.filter,
        accountId,
        source,
        folderId: source ? entry.filter?.folderId : undefined
      })
      if (parsed.success) {
        const page = number(entry.page, 1, 1, 10_001)
        return {
          filter: parsed.data,
          mode: entry.mode === 'scroll' ? 'scroll' : 'paged',
          page,
          viewport: number(entry.viewport, 1, 1, page),
          scroll: number(entry.scroll, 0, 0, 50_000_000)
        }
      }
    }
  } catch {
    // Browsing still works if renderer storage is unavailable.
  }
  return { filter: defaults, mode: 'paged', page: 1, viewport: 1, scroll: 0 }
}

export function saveBrowse(
  key: string,
  filter: Filter,
  mode: BrowseMode,
  page: number,
  viewport: number,
  scroll: number
) {
  try {
    localStorage.setItem(key, JSON.stringify({ filter, mode, page, viewport, scroll }))
  } catch {
    // A full renderer profile must not interrupt browsing.
  }
}

export function removeBrowse(accountId: string) {
  try {
    localStorage.removeItem(browseKey(accountId, 'likes'))
    localStorage.removeItem(browseKey(accountId, 'favorites'))
  } catch {
    // Renderer storage can be unavailable.
  }
}
