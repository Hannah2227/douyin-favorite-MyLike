import { useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Filter, LibraryPage } from '../../shared/contracts'
import { call } from './api'

const PAGE_SIZE = 60
const emptyPage: LibraryPage = { items: [], total: 0, years: [] }
type Result = { key: string; revision: number; page: LibraryPage; offset: number }

/** Owns a library view, including a fixed set of selected IDs independent of incoming pages. */
export function useLibrary(
  accountId: string | null,
  visible: boolean,
  revision: number,
  onError: (message: string) => void,
  origin?: { source: Filter['source']; folderId?: string | null }
) {
  const [search, setSearch] = useState('')
  const [type, setType] = useState<Filter['mediaType']>('all')
  const [year, setYear] = useState<number | null>(null)
  const [month, setMonth] = useState<number | null>(null)
  const sort: Filter['sort'] = 'published'
  const [result, setResult] = useState<Result | null>(null)
  const [querying, setQuerying] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [retryToken, setRetryToken] = useState(0)
  const [queryRevision, setQueryRevision] = useState(revision)
  const [pendingChanges, setPendingChanges] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const scroll = useRef<HTMLDivElement>(null),
    savedScroll = useRef(0),
    sentinel = useRef<HTMLDivElement>(null),
    loadedCount = useRef(PAGE_SIZE),
    appendLock = useRef<object | null>(null)
  const sequence = useRef(0),
    selectionSequence = useRef(0)
  const filter: Filter = { accountId: accountId ?? '', search, mediaType: type, year, month, sort, ...origin }
  const key = JSON.stringify(filter),
    scope = useRef(key)
  scope.current = key
  const page = result?.key === key ? result.page : emptyPage
  const hasMore = result?.key === key && result.offset < page.total
  const clearSelection = () => {
    selectionSequence.current++
    setSelected(new Set())
    setSelecting(false)
  }
  useEffect(() => {
    clearSelection()
    loadedCount.current = PAGE_SIZE
    savedScroll.current = 0
    if (scroll.current) scroll.current.scrollTop = 0
  }, [key])
  useEffect(() => {
    setYear(null)
    setMonth(null)
  }, [accountId, origin?.source, origin?.folderId])
  useEffect(() => {
    if (selected.size) setPendingChanges(true)
    else {
      setPendingChanges(false)
      setQueryRevision(revision)
    }
    // A live selection keeps its visible list stable; the selection itself is an ID snapshot.
  }, [revision, accountId])
  useEffect(() => {
    if (!selected.size && pendingChanges) {
      setPendingChanges(false)
      setQueryRevision(revision)
    }
  }, [selected.size, pendingChanges, revision])
  useEffect(() => {
    const seq = ++sequence.current
    appendLock.current = null
    setLoadingMore(false)
    setMoreError('')
    if (!accountId) {
      setResult(null)
      setQuerying(false)
      setLoadError('')
      return
    }
    setQuerying(true)
    setLoadError('')
    const timer = setTimeout(() => {
      void (async () => {
        const target = loadedCount.current
        const first = await call(window.mylike.invoke('query', { ...filter, limit: PAGE_SIZE, offset: 0 }))
        const items = [...first.items]
        let offset = first.items.length
        if (!offset && first.total) throw new Error('列表已变化，请重新读取。')
        while (offset < target && offset < first.total) {
          if (seq !== sequence.current || scope.current !== key) return
          const next = await call(window.mylike.invoke('query', { ...filter, limit: PAGE_SIZE, offset }))
          if (!next.items.length) throw new Error('列表已变化，请重新读取。')
          items.push(...next.items)
          offset += next.items.length
        }
        if (seq === sequence.current && scope.current === key) {
          const unique = [...new Map(items.map((work) => [work.id, work])).values()]
          setResult({ key, revision: queryRevision, page: { ...first, items: unique }, offset })
          loadedCount.current = Math.max(PAGE_SIZE, offset)
        }
      })()
        .catch((e) => {
          if (seq === sequence.current && scope.current === key) {
            setLoadError(e.message)
            onError(e.message)
          }
        })
        .finally(() => {
          if (seq === sequence.current && scope.current === key) setQuerying(false)
        })
    }, 150)
    return () => {
      clearTimeout(timer)
      sequence.current++
    }
  }, [key, queryRevision, retryToken])
  const loadMore = async (retry = false) => {
    if (
      !visible ||
      !accountId ||
      !result ||
      result.key !== key ||
      result.revision !== queryRevision ||
      revision !== queryRevision ||
      !hasMore ||
      querying ||
      loadingMore ||
      appendLock.current ||
      result.offset !== loadedCount.current ||
      pendingChanges ||
      loadError ||
      (moreError && !retry)
    )
      return
    const seq = sequence.current,
      token = {}
    appendLock.current = token
    setLoadingMore(true)
    setMoreError('')
    try {
      const next = await call(
        window.mylike.invoke('query', { ...filter, limit: PAGE_SIZE, offset: result.offset })
      )
      if (seq !== sequence.current || scope.current !== key) return
      const existing = new Set(result.page.items.map((work) => work.id))
      const added = next.items.filter((work) => !existing.has(work.id))
      if (!added.length) throw new Error('列表已变化，请重新读取后继续浏览。')
      const offset = result.offset + next.items.length
      loadedCount.current = offset
      setResult({
        key,
        revision: queryRevision,
        page: { ...next, items: [...result.page.items, ...added] },
        offset
      })
    } catch (error) {
      if (seq === sequence.current && scope.current === key)
        setMoreError(error instanceof Error ? error.message : '加载失败，请重试。')
    } finally {
      if (appendLock.current === token && seq === sequence.current) {
        appendLock.current = null
        setLoadingMore(false)
      }
    }
  }
  const nextPage = useRef<() => void>(() => {})
  nextPage.current = () => void loadMore()
  useEffect(() => {
    if (
      !visible ||
      !hasMore ||
      querying ||
      loadingMore ||
      pendingChanges ||
      loadError ||
      moreError ||
      !scroll.current ||
      !sentinel.current
    )
      return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) nextPage.current()
      },
      { root: scroll.current, rootMargin: '0px 0px 240px 0px' }
    )
    observer.observe(sentinel.current)
    return () => observer.disconnect()
  }, [visible, hasMore, querying, loadingMore, pendingChanges, loadError, moreError, page.items.length])
  const [columns, setColumns] = useState(4),
    [cardWidth, setCardWidth] = useState(180)
  useEffect(() => {
    if (!visible || !scroll.current) return
    const node = scroll.current
    const observer = new ResizeObserver(() => {
      const width = node.clientWidth - 48,
        count = Math.max(2, Math.floor((width + 18) / 195))
      setColumns(count)
      setCardWidth((width - (count - 1) * 18) / count)
    })
    observer.observe(node)
    node.scrollTop = savedScroll.current
    const remember = () => {
      savedScroll.current = node.scrollTop
    }
    node.addEventListener('scroll', remember, { passive: true })
    return () => {
      observer.disconnect()
      node.removeEventListener('scroll', remember)
    }
  }, [visible, page.items.length])
  const rowHeight = cardWidth * 1.25 + 82
  const virtual = useVirtualizer({
    count: Math.ceil(page.items.length / columns),
    getScrollElement: () => scroll.current,
    estimateSize: () => rowHeight,
    overscan: 2
  })
  useEffect(() => {
    virtual.measure()
  }, [rowHeight, columns, virtual])
  const selectAll = async () => {
    if (!accountId) return
    const seq = ++selectionSequence.current,
      requestScope = key
    const ids = await call(window.mylike.invoke('matchingIds', filter))
    if (seq === selectionSequence.current && scope.current === requestScope) {
      setSelected(new Set(ids))
      setSelecting(true)
    }
  }
  const toggle = (id: string) => {
    selectionSequence.current++
    setSelected((old) => {
      const next = new Set(old)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  return {
    search,
    setSearch,
    type,
    setType,
    year,
    setYear,
    month,
    setMonth,
    sort,
    page,
    querying,
    loadError,
    retry: () => setRetryToken((n) => n + 1),
    resetFilters: () => {
      setSearch('')
      setType('all')
      setYear(null)
      setMonth(null)
    },
    filter,
    scroll,
    virtual,
    columns,
    sentinel,
    hasMore,
    loadingMore,
    moreError,
    retryMore: () => void loadMore(true),
    pendingChanges,
    selection: {
      enabled: selecting,
      enable: () => setSelecting(true),
      ids: selected,
      all: selectAll,
      toggle,
      clear: clearSelection
    }
  }
}
export type Library = ReturnType<typeof useLibrary>
