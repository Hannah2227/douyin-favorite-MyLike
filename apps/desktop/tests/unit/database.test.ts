import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Store } from '../../src/main/storage/database'
import type { Work } from '../../src/shared/contracts'

const directories: string[] = [],
  stores: Store[] = []
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'mylike-db-test-'))
  directories.push(directory)
  const file = join(directory, 'test.sqlite')
  const store = new Store(file)
  stores.push(store)
  store.call('createAccount', { id: 'a', name: 'A' })
  store.call('bindAccount', { accountId: 'a', remoteId: 'remote-a', nickname: 'A', avatarUrl: null })
  return { file, store }
}
const item = (id = '123'): Work => ({
  id,
  title: '100%_喜欢的内容',
  author: '作者',
  publishedAt: 1_700_000_000,
  coverUrl: null,
  mediaType: 'video',
  isLive: false
})
const query = {
  accountId: 'a',
  search: '',
  mediaType: 'all' as const,
  year: null,
  month: null,
  sort: 'published' as const,
  offset: 0,
  limit: 60
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0))
    try {
      store.call('close', undefined)
    } catch {
      /* already closed by persistence test */
    }
  for (const directory of directories.splice(0)) {
    if (
      dirname(resolve(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith('mylike-db-test-')
    )
      throw new Error('Unsafe temporary cleanup path')
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('SQLite transactions and account ownership', () => {
  it('aggregates account-wide dashboard counts with bounded recent items and no cross-account rows', () => {
    const { store } = setup()
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000)
    expect(store.call('libraryOverview', { accountId: 'a' })).toMatchObject({
      total: 0,
      videos: 0,
      galleries: 0,
      live: 0,
      recent: []
    })
    store.call('savePage', {
      accountId: 'a',
      remoteId: 'remote-a',
      cursor: '0',
      hasMore: false,
      items: [
        item('1'),
        { ...item('2'), mediaType: 'gallery' },
        { ...item('3'), mediaType: 'gallery', isLive: true },
        item('4'),
        item('5')
      ]
    })
    store.call('createAccount', { id: 'b', name: 'B' })
    store.call('bindAccount', { accountId: 'b', remoteId: 'remote-b', nickname: 'B', avatarUrl: null })
    store.call('savePage', {
      accountId: 'b',
      remoteId: 'remote-b',
      items: [item('1')],
      cursor: '0',
      hasMore: false
    })
    const summary = store.call('libraryOverview', { accountId: 'a' })
    expect(summary).toMatchObject({ accountId: 'a', total: 5, videos: 3, galleries: 2, live: 1 })
    expect(summary.recent.map((work) => work.id)).toEqual(['5', '4', '3', '2'])
    store.call('deleteLocal', { accountId: 'a', workIds: ['1', '3'] })
    expect(store.call('libraryOverview', { accountId: 'a' })).toMatchObject({
      total: 3,
      videos: 2,
      galleries: 1,
      live: 0
    })
    expect(store.call('libraryOverview', { accountId: 'b' })).toMatchObject({
      total: 1,
      videos: 1,
      galleries: 0,
      live: 0
    })
  })
  it('persists page and cursor together, is idempotent, and survives reopening', () => {
    const { store, file } = setup()
    const page = {
      accountId: 'a',
      remoteId: 'remote-a',
      items: [item()],
      cursor: '7381234567890123456',
      hasMore: true
    }
    expect(store.call('savePage', page).added).toBe(1)
    expect(store.call('savePage', page).added).toBe(0)
    store.call('close', undefined)
    const reopened = new Store(file)
    stores.push(reopened)
    expect(reopened.call('checkpoint', { accountId: 'a' })?.cursor).toBe(page.cursor)
    expect(reopened.call('query', query).total).toBe(1)
  })
  it('rolls back inserted rows and leaves the checkpoint unchanged when a page fails midway', () => {
    const { store } = setup()
    store.call('savePage', {
      accountId: 'a',
      remoteId: 'remote-a',
      items: [item()],
      cursor: '1',
      hasMore: true
    })
    expect(() =>
      store.call('savePage', {
        accountId: 'a',
        remoteId: 'remote-a',
        items: [item('456'), { ...item('789'), title: undefined as unknown as string }],
        cursor: '2',
        hasMore: true
      })
    ).toThrow()
    expect(store.call('query', query).total).toBe(1)
    expect(store.call('checkpoint', { accountId: 'a' })?.cursor).toBe('1')
  })
  it('does not expose another account records or rebind a different remote identity', () => {
    const { store } = setup()
    store.call('savePage', {
      accountId: 'a',
      remoteId: 'remote-a',
      items: [item()],
      cursor: '1',
      hasMore: false
    })
    store.call('createAccount', { id: 'b', name: 'B' })
    expect(store.call('query', { ...query, accountId: 'b' }).total).toBe(0)
    expect(() =>
      store.call('bindAccount', { accountId: 'a', remoteId: 'remote-b', nickname: 'Wrong', avatarUrl: null })
    ).toThrow(/不一致/)
    expect(() =>
      store.call('savePage', {
        accountId: 'a',
        remoteId: 'remote-b',
        items: [item('456')],
        cursor: '2',
        hasMore: false
      })
    ).toThrow()
    expect(store.call('query', { ...query, search: '%_' }).total).toBe(1)
    expect(store.call('query', { ...query, search: "' OR 1=1 --" }).total).toBe(0)
  })
  it('does not replace a corrupt database with an empty one', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mylike-db-test-'))
    directories.push(directory)
    const file = join(directory, 'broken.sqlite'),
      bytes = Buffer.from('not a SQLite database\noriginal contents')
    writeFileSync(file, bytes)
    expect(() => new Store(file)).toThrow()
    expect(readFileSync(file)).toEqual(bytes)
  })
  it('filters local month boundaries and orders by the requested publication or collection time', () => {
    const { store } = setup(),
      now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const base = { accountId: 'a', remoteId: 'remote-a', cursor: '0', hasMore: false }
    store.call('savePage', { ...base, items: [{ ...item('1'), publishedAt: +new Date(2024, 1, 1) / 1000 }] })
    now.mockReturnValue(2000)
    store.call('savePage', {
      ...base,
      items: [
        { ...item('2'), publishedAt: +new Date(2024, 0, 31, 23, 59, 59) / 1000 },
        { ...item('3'), publishedAt: +new Date(2024, 2, 1) / 1000 }
      ]
    })
    expect(store.call('query', { ...query, year: 2024, month: 2 }).items.map((w) => w.id)).toEqual(['1'])
    expect(store.call('query', { ...query, month: 1 }).items.map((w) => w.id)).toEqual(['2'])
    expect(store.call('query', query).items.map((w) => w.id)).toEqual(['3', '1', '2'])
    expect(store.call('query', { ...query, sort: 'collected' }).items.map((w) => w.id)).toEqual([
      '3',
      '2',
      '1'
    ])
  })
  it('selects the full filtered set and preserves that snapshot while new content arrives; local deletion stays account-scoped', () => {
    const { store, file } = setup(),
      items = Array.from({ length: 250 }, (_, i) => item(String(i + 1000)))
    const base = { accountId: 'a', remoteId: 'remote-a', cursor: '1', hasMore: true }
    store.call('savePage', { ...base, items })
    store.call('createAccount', { id: 'b', name: 'B' })
    store.call('bindAccount', { accountId: 'b', remoteId: 'remote-b', nickname: 'B', avatarUrl: null })
    store.call('savePage', { ...base, accountId: 'b', remoteId: 'remote-b', items: [items[0]!] })
    expect(store.call('query', query).items).toHaveLength(60)
    const ids = store.call('matchingIds', query)
    expect(ids).toHaveLength(250)
    store.call('savePage', { ...base, items: [item('9999')] })
    expect(ids).not.toContain('9999')
    expect(store.call('deleteLocal', { accountId: 'a', workIds: ids })).toEqual({ removed: 250 })
    expect(store.call('query', query).items.map((w) => w.id)).toEqual(['9999'])
    expect(store.call('query', { ...query, accountId: 'b' }).total).toBe(1)
    const backup = new DatabaseSync(
      join(dirname(file), 'backups', readdirSync(join(dirname(file), 'backups'))[0]!)
    )
    expect(backup.prepare('SELECT count(*) AS n FROM account_items WHERE accountId=?').get('a')?.n).toBe(251)
    backup.close()
  })
  it('rolls back a partially failing local deletion without removing another account data', () => {
    const { store, file } = setup()
    store.call('savePage', {
      accountId: 'a',
      remoteId: 'remote-a',
      items: [item('1'), item('2')],
      cursor: '20',
      hasMore: true
    })
    const raw = new DatabaseSync(file)
    raw.exec(
      "CREATE TRIGGER fail_local_delete BEFORE DELETE ON account_items WHEN OLD.workId='2' BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END;"
    )
    raw.close()
    expect(() => store.call('deleteLocal', { accountId: 'a', workIds: ['1', '2'] })).toThrow(
      /fixture storage failure/
    )
    expect(store.call('query', query).total).toBe(2)
    expect(store.call('checkpoint', { accountId: 'a' })?.cursor).toBe('20')
  })
  it('queries and selects a 50,000-row library with bounded result pages', () => {
    const { store } = setup(),
      items = Array.from({ length: 50000 }, (_, i) => ({
        ...item(String(100000 + i)),
        title: `第${i}条${i % 10 === 0 ? '旅行' : '日常'}`,
        publishedAt: +new Date(2020 + (i % 6), i % 12, 1) / 1000,
        mediaType: i % 2 ? ('gallery' as const) : ('video' as const)
      }))
    store.call('savePage', { accountId: 'a', remoteId: 'remote-a', items, cursor: '0', hasMore: false })
    const times: number[] = []
    let first = 0
    for (let i = 0; i < 30; i++) {
      const begin = performance.now()
      const page = store.call('query', {
        ...query,
        search: i % 3 === 0 ? '旅行' : '',
        year: i % 3 === 1 ? 2024 : null,
        month: i % 3 === 1 ? 5 : null,
        sort: i % 2 ? 'collected' : 'published'
      })
      const elapsed = performance.now() - begin
      if (i === 0) first = elapsed
      times.push(elapsed)
      expect(page.items.length).toBeLessThanOrEqual(60)
    }
    expect(store.call('matchingIds', { ...query, search: '旅行' })).toHaveLength(5000)
    console.log(
      '50k SQLite benchmark:',
      JSON.stringify({
        firstQueryMs: Math.round(first),
        p95Ms: Math.round(times.sort((a, b) => a - b)[Math.ceil(times.length * 0.95) - 1]!),
        samples: times.length
      })
    )
  }, 20000)
})
