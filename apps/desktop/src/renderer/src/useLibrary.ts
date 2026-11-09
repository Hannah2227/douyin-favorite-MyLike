import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Filter, LibraryPage } from '../../shared/contracts'
import { call } from './api'

export const LIBRARY_PAGE_SIZE = 100
const emptyPage: LibraryPage = { items: [], total: 0, years: [] }
type Result = { scope: string; number: number; revision: number; retry: number; page: LibraryPage }

export function useLibrary(
  accountId: string | null,
  visible: boolean,
  revision: number,
  origin?: { source: Filter['source']; folderId?: string | null }
) {
  const [search, setSearch] = useState('')
  const [type, setType] = useState<Filter['mediaType']>('all')
  const [author, setAuthor] = useState<string>()
  const [year, setYear] = useState<Filter['year']>(null)
  const [month, setMonth] = useState<number | null>(null)
  const [sort, setSort] = useState<Filter['sort']>('published')
  const [position, setPosition] = useState({ scope: '', number: 1 })
  const [result, setResult] = useState<Result | null>(null)
  const [querying, setQuerying] = useState(false)
  const [failure, setFailure] = useState<{ scope: string; number: number; message: string } | null>(null)
  const [retryToken, setRetryToken] = useState(0)
  const [queryRevision, setQueryRevision] = useState(revision)
  const [pendingChanges, setPendingChanges] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const scroll = useRef<HTMLDivElement>(null)
  const controls = useRef<HTMLDivElement>(null)
  const grid = useRef<HTMLDivElement>(null)
  const savedScroll = useRef(0)
  const selectionSequence = useRef(0)
  const previousSearch = useRef(search)
  const byLikes = sort === 'liked'
  const filter: Filter = {
    accountId: accountId ?? '',
    search,
    author,
    mediaType: type,
    year: byLikes ? null : year,
    month: byLikes || year === 'unknown' ? null : month,
    sort,
    ...origin
  }
  const key = JSON.stringify(filter)
  const scope = useRef(key)
  scope.current = key
  const pageNumber = position.scope === key ? position.number : 1
  const sameFilter = result?.scope === key ? result : null
  const current = sameFilter?.number === pageNumber ? sameFilter.page : null
  const page = current ?? (sameFilter ? { ...sameFilter.page, items: [] } : emptyPage)
  const loadError = failure?.scope === key && failure.number === pageNumber ? failure.message : ''
  const pageCount = Math.max(1, Math.min(10_001, Math.ceil(page.total / LIBRARY_PAGE_SIZE)))
  const goToPage = (number: number) => {
    if (Number.isInteger(number))
      setPosition({ scope: key, number: Math.max(1, Math.min(number, pageCount)) })
  }
  const clearSelection = () => {
    selectionSequence.current++
    setSelected(new Set())
    setSelecting(false)
  }
  useLayoutEffect(() => {
    setPosition({ scope: key, number: 1 })
    clearSelection()
  }, [key])
  useLayoutEffect(() => {
    savedScroll.current = 0
    if (scroll.current) scroll.current.scrollTop = 0
  }, [key, pageNumber])
  useEffect(() => {
    setAuthor(undefined)
    setYear(null)
    setMonth(null)
  }, [accountId, origin?.source, origin?.folderId])
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
    if (current && sameFilter?.revision === queryRevision && sameFilter.retry === retryToken) {
      setQuerying(false)
      return
    }
    let active = true
    setQuerying(true)
    setFailure(null)
    const searchChanged = previousSearch.current !== search
    previousSearch.current = search
    const timer = setTimeout(
      () => {
        void call(
          window.mylike.invoke('query', {
            ...filter,
            limit: LIBRARY_PAGE_SIZE,
            offset: (pageNumber - 1) * LIBRARY_PAGE_SIZE
          })
        )
          .then((next) => {
            if (!active || scope.current !== key) return
            const last = Math.max(1, Math.ceil(next.total / LIBRARY_PAGE_SIZE))
            if (pageNumber > last) setPosition({ scope: key, number: last })
            else
              setResult({
                scope: key,
                number: pageNumber,
                revision: queryRevision,
                retry: retryToken,
                page: next
              })
          })
          .catch((error) => {
            if (active && scope.current === key) {
              setFailure({ scope: key, number: pageNumber, message: error.message })
            }
          })
          .finally(() => {
            if (active) setQuerying(false)
          })
      },
      searchChanged ? 150 : 0
    )
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [visible, key, pageNumber, queryRevision, retryToken])
  const [geometry, setGeometry] = useState({ columns: 4, cardWidth: 180, margin: 0 })
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
    if (grid.current) observer.observe(grid.current)
    node.scrollTop = savedScroll.current
    const remember = () => {
      savedScroll.current = node.scrollTop
    }
    node.addEventListener('scroll', remember, { passive: true })
    return () => {
      observer.disconnect()
      node.removeEventListener('scroll', remember)
    }
  }, [visible, key, pageNumber, page.items.length, loadError])
  const { columns, cardWidth, margin } = geometry
  const rowHeight = cardWidth * 1.25 + 82
  const virtual = useVirtualizer({
    count: Math.ceil(page.items.length / columns),
    getScrollElement: () => scroll.current,
    estimateSize: () => rowHeight,
    scrollMargin: margin,
    overscan: 2
  })
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
  const resetFilters = () => {
    setSearch('')
    setAuthor(undefined)
    setType('all')
    setYear(null)
    setMonth(null)
  }
  return {
    search,
    setSearch,
    clearAuthor: () => setAuthor(undefined),
    type,
    setType,
    year,
    setYear,
    month,
    setMonth,
    sort,
    setSort,
    page,
    pageNumber,
    pageCount,
    goToPage,
    querying: visible && !!accountId && (querying || (!current && !loadError)),
    loadError,
    retry: () => setRetryToken((n) => n + 1),
    resetFilters,
    applyDashboardFilter: (target: { year: Filter['year'] } | { author: string }) => {
      resetFilters()
      if ('year' in target) {
        setSort('published')
        setYear(target.year)
      } else setAuthor(target.author)
      setPosition({ scope: '', number: 1 })
      clearSelection()
      savedScroll.current = 0
    },
    filter,
    scroll,
    controls,
    grid,
    virtual,
    columns,
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
