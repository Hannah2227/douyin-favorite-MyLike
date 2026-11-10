import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Filter, LibraryPage } from '../../shared/contracts'
import type { AppPreferences } from '../../shared/preferences'
import { call } from './api'
import { browseKey, readBrowse, saveBrowse } from './library-browse'

export const LIBRARY_PAGE_SIZE = 100
const emptyPage: LibraryPage = { items: [], total: 0, years: [] }
type Result = {
  scope: string
  number: number
  first: number
  last: number
  revision: number
  retry: number
  page: LibraryPage
}

const lastPage = (total: number) => Math.max(1, Math.min(10_001, Math.ceil(total / LIBRARY_PAGE_SIZE)))

export function useLibrary(
  accountId: string | null,
  visible: boolean,
  revision: number,
  mode: AppPreferences['libraryMode'],
  source?: 'favorites'
) {
  const storageKey = accountId ? browseKey(accountId, source ?? 'likes') : ''
  const stored = useMemo(() => readBrowse(storageKey, accountId, source), [storageKey, accountId, source])
  const [filters, setFilters] = useState<{ scope: string; filter: Filter } | null>(null)
  const raw = filters?.scope === storageKey ? filters.filter : stored.filter
  const update = (patch: Partial<Filter>) => {
    setFilters((old) => ({
      scope: storageKey,
      filter: { ...(old?.scope === storageKey ? old.filter : stored.filter), ...patch }
    }))
  }
  const { search, mediaType: type, year, month, sort, folderId } = raw
  const filter = {
    ...raw,
    year: sort === 'liked' ? null : year,
    month: sort === 'liked' || year === 'unknown' ? null : month
  }
  const [position, setPosition] = useState({ scope: '', number: 1 })
  const [viewport, setViewport] = useState({ scope: '', number: 1 })
  const [result, setResult] = useState<Result | null>(null)
  const [querying, setQuerying] = useState(false)
  const [failure, setFailure] = useState<{ scope: string; range: string; message: string } | null>(null)
  const [retryToken, setRetryToken] = useState(0)
  const [queryRevision, setQueryRevision] = useState(revision)
  const [pendingChanges, setPendingChanges] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const scroll = useRef<HTMLDivElement>(null)
  const controls = useRef<HTMLDivElement>(null)
  const toolbar = useRef<HTMLDivElement>(null)
  const gridArea = useRef<HTMLDivElement>(null)
  const grid = useRef<HTMLDivElement>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  const savedScroll = useRef(0)
  const restored = useRef('')
  const selectionSequence = useRef(0)
  const previousSearch = useRef(search)
  const [geometry, setGeometry] = useState({ columns: 4, cardWidth: 180, margin: 0 })
  const { columns, cardWidth, margin } = geometry
  const rowHeight = cardWidth * 1.25 + 64

  const paginated = mode === 'paged'
  const key = JSON.stringify([filter, mode])
  const scope = useRef(key)
  scope.current = key
  const restore = restored.current !== storageKey && stored.mode === mode ? stored : null
  const pageNumber = position.scope === key ? position.number : (restore?.page ?? 1)
  const visibleBatch = Math.min(
    pageNumber,
    viewport.scope === key ? viewport.number : (restore?.viewport ?? 1)
  )
  const firstBatch = paginated ? pageNumber : Math.max(1, visibleBatch - 1)
  const lastBatch = paginated ? pageNumber : Math.min(pageNumber, visibleBatch + 1)
  const range = [pageNumber, firstBatch, lastBatch, queryRevision, retryToken].join(':')
  const sameFilter = result?.scope === key ? result : null
  const current = sameFilter && (!paginated || sameFilter.number === pageNumber) ? sameFilter.page : null
  const page = current ?? (sameFilter ? { ...sameFilter.page, items: [] } : emptyPage)
  const error = failure?.scope === key && failure.range === range ? failure.message : ''
  const pageCount = lastPage(page.total)
  const append = !paginated && !!sameFilter && pageNumber > sameFilter.number
  const hasMore = !paginated && !!sameFilter && sameFilter.number < pageCount
  const loading = visible && !!accountId && (querying || (!current && !error))
  const moreError = append ? error : ''
  const loadError = append ? '' : error

  const clearSelection = () => {
    selectionSequence.current++
    setSelected(new Set())
    setSelecting(false)
  }
  useLayoutEffect(() => {
    restored.current = storageKey
    setPosition({ scope: key, number: restore?.page ?? 1 })
    setViewport({ scope: key, number: restore?.viewport ?? 1 })
    savedScroll.current = restore?.scroll ?? 0
    clearSelection()
  }, [key])
  useEffect(() => {
    if (selected.size) setPendingChanges(true)
    else {
      setPendingChanges(false)
      setQueryRevision(revision)
    }
  }, [revision, accountId])
  useEffect(() => {
    if (!selected.size && pendingChanges) {
      setPendingChanges(false)
      setQueryRevision(revision)
    }
  }, [selected.size, pendingChanges, revision])

  useEffect(() => {
    if (!visible || !accountId) return
    if (
      sameFilter?.number === pageNumber &&
      sameFilter.revision === queryRevision &&
      sameFilter.retry === retryToken &&
      sameFilter.first <= firstBatch &&
      sameFilter.last >= lastBatch
    ) {
      setQuerying(false)
      return
    }
    let active = true
    setQuerying(true)
    setFailure(null)
    const searchChanged = previousSearch.current !== search
    previousSearch.current = search
    const timer = setTimeout(
      async () => {
        const stillCurrent = () => active && scope.current === key
        const cached =
          sameFilter?.revision === queryRevision && sameFilter.retry === retryToken ? sameFilter : null
        try {
          const pages = await Promise.all(
            Array.from({ length: lastBatch - firstBatch + 1 }, (_, index) => {
              const number = firstBatch + index
              if (cached && number >= cached.first && number <= cached.last) {
                const offset = (number - cached.first) * LIBRARY_PAGE_SIZE
                return {
                  ...cached.page,
                  items: cached.page.items.slice(offset, offset + LIBRARY_PAGE_SIZE)
                }
              }
              return call(
                window.mylike.invoke('query', {
                  ...filter,
                  limit: LIBRARY_PAGE_SIZE,
                  offset: (number - 1) * LIBRARY_PAGE_SIZE
                })
              )
            })
          )
          if (!stillCurrent()) return
          const total =
            pages.find(
              (_, index) => !cached || firstBatch + index < cached.first || firstBatch + index > cached.last
            ) ?? pages[0]!
          const number = Math.min(pageNumber, lastPage(total.total))
          if (number !== pageNumber) {
            setPosition({ scope: key, number })
            setViewport({ scope: key, number: Math.min(visibleBatch, number) })
            if (paginated) savedScroll.current = 0
            return
          }
          const items = pages.flatMap((chunk) => chunk.items)
          const node = scroll.current
          if (!paginated && sameFilter && sameFilter.revision !== queryRevision && node && grid.current) {
            const top = node.scrollTop + (toolbar.current?.offsetHeight ?? 0) - grid.current.offsetTop
            if (top > 0) {
              const row = Math.floor(top / rowHeight)
              const anchor = sameFilter.page.items[row * columns - (sameFilter.first - 1) * LIBRARY_PAGE_SIZE]
              const index = anchor ? items.findIndex(({ id }) => id === anchor.id) : -1
              if (index >= 0) {
                const newRow = Math.floor(((firstBatch - 1) * LIBRARY_PAGE_SIZE + index) / columns)
                savedScroll.current = Math.max(0, node.scrollTop + (newRow - row) * rowHeight)
              }
            }
          }
          setResult({
            scope: key,
            number,
            first: firstBatch,
            last: lastBatch,
            revision: queryRevision,
            retry: retryToken,
            page: { ...total, items }
          })
        } catch (error) {
          if (stillCurrent()) setFailure({ scope: key, range, message: (error as Error).message })
        } finally {
          if (stillCurrent()) setQuerying(false)
        }
      },
      searchChanged ? 150 : 0
    )
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [visible, key, range])

  useEffect(() => {
    const root = scroll.current
    const target = sentinel.current
    if (!visible || !root || !target || !hasMore || loading || append || error || pendingChanges) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && scope.current === key) {
          setPosition({ scope: key, number: pageNumber + 1 })
        }
      },
      { root, rootMargin: '0px 0px 240px 0px' }
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [visible, key, hasMore, loading, append, error, pendingChanges, pageNumber])

  const persist = useRef<() => void>(() => {})
  persist.current = () => {
    if (storageKey && current && sameFilter)
      saveBrowse(storageKey, raw, mode, sameFilter.number, visibleBatch, savedScroll.current)
  }
  useEffect(() => {
    persist.current()
  }, [visible, key, result, visibleBatch])
  useEffect(() => window.mylike.onBeforeQuit(async () => persist.current()), [])

  useLayoutEffect(() => {
    const node = scroll.current
    if (!visible || !node) return
    const measure = () => {
      const width = Math.max(1, node.clientWidth - 48)
      const columns = Math.max(2, Math.floor((width + 18) / 195))
      const cardWidth = (width - (columns - 1) * 18) / columns
      const margin = grid.current ? grid.current.offsetTop : (controls.current?.offsetHeight ?? 0)
      setGeometry((old) =>
        old.columns === columns && old.cardWidth === cardWidth && old.margin === margin
          ? old
          : { columns, cardWidth, margin }
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    if (controls.current) observer.observe(controls.current)
    if (toolbar.current) observer.observe(toolbar.current)
    if (gridArea.current) observer.observe(gridArea.current)
    return () => observer.disconnect()
  }, [visible, key, result, loadError])
  useLayoutEffect(() => {
    const node = scroll.current
    if (!visible || !node || !current) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const remember = () => {
      savedScroll.current = node.scrollTop
      if (!paginated && grid.current) {
        const row = Math.floor(Math.max(0, node.scrollTop - grid.current.offsetTop) / rowHeight)
        const number = Math.floor((row * columns) / LIBRARY_PAGE_SIZE) + 1
        setViewport((old) => (old.scope === key && old.number === number ? old : { scope: key, number }))
      }
      clearTimeout(timer)
      timer = setTimeout(() => persist.current(), 180)
    }
    node.addEventListener('scroll', remember, { passive: true })
    return () => {
      node.removeEventListener('scroll', remember)
      clearTimeout(timer)
      if (scope.current === key) persist.current()
    }
  }, [visible, key, rowHeight, columns, paginated, !!current])

  const itemCount = paginated
    ? page.items.length
    : Math.min(page.total, (sameFilter?.number ?? 0) * LIBRARY_PAGE_SIZE)
  const virtual = useVirtualizer({
    count: Math.ceil(itemCount / columns),
    getScrollElement: () => scroll.current,
    estimateSize: () => rowHeight,
    scrollMargin: margin,
    overscan: 2
  })
  useLayoutEffect(() => {
    if (visible && current && scroll.current) scroll.current.scrollTop = savedScroll.current
  }, [visible, key, result, rowHeight])
  useEffect(() => virtual.measure(), [rowHeight, columns, virtual])

  const selectAll = async () => {
    if (!accountId) return
    const seq = ++selectionSequence.current
    const ids = await call(window.mylike.invoke('matchingIds', filter))
    if (seq === selectionSequence.current && scope.current === key) {
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
  const reset = { search: '', author: undefined, mediaType: 'all', year: null, month: null } as const
  return {
    search,
    setSearch: (value: string) => update({ search: value }),
    clearAuthor: () => update({ author: undefined }),
    type,
    setType: (value: Filter['mediaType']) => update({ mediaType: value }),
    year,
    setYear: (value: Filter['year']) =>
      update({ year: value, ...(value === 'unknown' ? { month: null } : {}) }),
    setMonth: (value: Filter['month']) => update({ month: value }),
    sort,
    setSort: (value: Filter['sort']) => update({ sort: value }),
    folderId,
    setFolderId: (value: string | null) =>
      update({ folderId: value, author: undefined, year: null, month: null }),
    page,
    pageNumber,
    pageCount,
    paginated,
    goToPage: (number: number) => {
      if (!Number.isInteger(number)) return
      const next = Math.max(1, Math.min(number, pageCount))
      if (next !== pageNumber) savedScroll.current = 0
      setPosition({ scope: key, number: next })
    },
    querying: loading && !append && (paginated || !current),
    loadingMore: loading && append,
    moreError,
    loadError,
    retry: () => setRetryToken((n) => n + 1),
    resetFilters: () => update(reset),
    applyDashboardFilter: (target: { year: Filter['year'] } | { author: string }) => {
      update({ ...reset, ...target, ...('year' in target ? { sort: 'published' as const } : {}) })
      setPosition({ scope: key, number: 1 })
      setViewport({ scope: key, number: 1 })
      clearSelection()
      savedScroll.current = 0
    },
    rowItems: (row: number) => {
      const start = paginated ? 0 : ((sameFilter?.first ?? 1) - 1) * LIBRARY_PAGE_SIZE
      const index = row * columns
      return Array.from(
        { length: Math.min(columns, itemCount - index) },
        (_, offset) => page.items[index + offset - start]
      )
    },
    filter,
    scroll,
    controls,
    toolbar,
    gridArea,
    grid,
    sentinel,
    hasMore,
    virtual,
    columns,
    pendingChanges,
    selection: {
      enabled: selecting,
      enable: () => setSelecting(true),
      ids: selected,
      all: selectAll,
      toggle,
      add: (ids: string[]) => {
        selectionSequence.current++
        setSelected((old) => new Set([...old, ...ids]))
      },
      clear: clearSelection
    }
  }
}
export type Library = ReturnType<typeof useLibrary>
