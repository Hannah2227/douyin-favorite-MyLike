import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Store } from '../../src/main/storage/database'
import { saveMobileLibrary } from '../../src/main/mobile-export'
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
  it('exports only the selected account likes in observed order, with safe mobile metadata', () => {
    const { store } = setup()
    const earlier = item('7637322941528689935')
    const recent = {
      ...item('7637322941528689936'),
      coverUrl: 'https://p3-pc.douyinpic.com/cover.jpg?x=a%2Fb',
      mediaType: 'gallery' as const,
      isLive: true
    }
    store.call('savePage', {
      accountId: 'a',
      remoteId: 'remote-a',
      cursor: '0',
      hasMore: false,
      items: [
        {
          ...item('8'),
          publishedAt: recent.publishedAt + 1,
          coverUrl: 'https://douyinpic.com.example.test/cover.jpg'
        }
      ]
    })
    store.call('startCollection', { accountId: 'a', id: 'run-a', mode: 'full' })
    store.call('saveCollectionPage', {
      accountId: 'a',
      taskId: 'run-a',
      remoteId: 'remote-a',
      requestCursor: '0',
      items: [earlier, recent],
      cursor: '0',
      hasMore: false
    })
    store.call('createAccount', { id: 'b', name: 'B' })
    store.call('bindAccount', { accountId: 'b', remoteId: 'remote-b', nickname: 'B', avatarUrl: null })
    store.call('savePage', {
      accountId: 'b',
      remoteId: 'remote-b',
      items: [item('9')],
      cursor: '0',
      hasMore: false
    })
    store.call('favoriteConfirm', { accountId: 'a', remoteId: 'remote-a', work: item('10') })
    const { text, count } = store.call('mobileLibraryExport', { accountId: 'a' })
    const exportFile = JSON.parse(text)
    expect(count).toBe(3)
    expect(exportFile).toMatchObject({
      format: 'mylike.library',
      version: 2,
      order: 'desktop-liked',
      source: { kind: 'douyin.likes', label: 'A' }
    })
    expect(exportFile.items.map((work: Work) => work.id)).toEqual([earlier.id, recent.id, '8'])
    expect(exportFile.items[1]).toEqual({
      id: recent.id,
      title: recent.title,
      author: recent.author,
      publishedAt: new Date(recent.publishedAt * 1000).toISOString(),
      kind: 'live-gallery',
      coverUrl: recent.coverUrl
    })
    expect(exportFile.items[2]).not.toHaveProperty('coverUrl')
    expect(text).not.toContain('remote-a')
  })

  it('keeps the MyLike data directory out of bounds for exported files', async () => {
    const { file } = setup()
    const target = join(dirname(file), 'export.json')
    await expect(saveMobileLibrary(target, '{}', dirname(file))).rejects.toMatchObject({
      code: 'EXPORT_LOCATION'
    })
    expect(readdirSync(dirname(file))).not.toContain('export.json')
  })

  it('aggregates account-wide dashboard counts without cross-account rows', () => {
    const { store } = setup()
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000)
    expect(store.call('libraryOverview', { accountId: 'a' })).toMatchObject({
      total: 0,
      videos: 0,
      galleries: 0,
      live: 0
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
  it('ranks up to six stored author names by work count and excludes missing names', () => {
    const { store } = setup()
    store.call('savePage', {
      accountId: 'a',
      remoteId: 'remote-a',
      cursor: '0',
      hasMore: false,
      items: ['B', 'A', 'A', 'C', 'D', 'E', 'F', 'G', '', '   '].map((author, index) => ({
        ...item(String(index + 1)),
        author
      }))
    })
    expect(store.call('libraryOverview', { accountId: 'a' }).authors).toEqual([
      { nickname: 'A', count: 2 },
      ...['B', 'C', 'D', 'E', 'F'].map((nickname) => ({ nickname, count: 1 }))
    ])
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
  it('caps favorite selection to the first 1000 visible matches within the chosen folder', () => {
    const { store, file } = setup()
    const items = Array.from({ length: 1305 }, (_, i) => ({
      ...item(String(8000000 + i)),
      publishedAt: 1700000000 + i,
      title: i % 10 === 0 ? '旅行' : '日常'
    }))
    store.call('savePage', { accountId: 'a', remoteId: 'remote-a', items, cursor: '0', hasMore: false })
    const db = new DatabaseSync(file)
    try {
      db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE')
      for (const [id, count] of [
        ['8', 1205],
        ['9', 100]
      ] as const)
        db.prepare('INSERT INTO saved_folders VALUES(?,?,?,?,?)').run(
          'a',
          id,
          'Folder ' + id,
          count,
          'fixture'
        )
      const saved = db.prepare('INSERT INTO saved_items VALUES(?,?,?)'),
        member = db.prepare('INSERT INTO saved_members VALUES(?,?,?,?)')
      items.forEach((work, i) => {
        saved.run('a', work.id, i)
        member.run('a', i < 1205 ? '8' : '9', work.id, 'fixture')
      })
      db.exec('COMMIT')
    } finally {
      db.close()
    }
    const filter = { ...query, source: 'favorites' as const, folderId: '8' }
    expect(store.call('query', filter).total).toBe(1205)
    const expected = items
      .slice(0, 1205)
      .reverse()
      .slice(0, 1000)
      .map((work) => work.id)
    for (const sort of ['published', 'collected'] as const)
      expect(store.call('matchingIds', { ...filter, sort })).toEqual(expected)
    expect(store.call('matchingIds', { ...filter, search: '旅行' })).toEqual(
      items
        .slice(0, 1205)
        .filter((work) => work.title === '旅行')
        .reverse()
        .map((work) => work.id)
    )
    expect(store.call('matchingIds', { ...filter, folderId: '9' })).toHaveLength(100)
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
    for (const sort of ['published', 'collected'] as const) {
      const filter = { ...query, search: '旅行', sort }
      const expected = Array.from({ length: 10 }, (_, i) =>
        store.call('query', { ...filter, offset: i * 100, limit: 100 }).items.map((w) => w.id)
      ).flat()
      expect(store.call('matchingIds', filter)).toEqual(expected)
      expect(expected).toHaveLength(1000)
    }
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

it('preserves an interrupted head and deep cursor when switching to downward collection without a schema upgrade', () => {
  const { store } = setup()
  store.call('savePage', {
    accountId: 'a',
    remoteId: 'remote-a',
    items: [item()],
    cursor: '999',
    hasMore: true
  })
  let task = store.call('startCollection', { accountId: 'a', id: 'head-direction', mode: 'incremental' })
  store.call('saveCollectionPage', {
    accountId: 'a',
    taskId: task.id,
    remoteId: 'remote-a',
    requestCursor: '0',
    items: [item('456')],
    cursor: '5',
    hasMore: true
  })
  store.call('updateCollection', { accountId: 'a', taskId: task.id, status: 'stopped', reason: 'stop' })
  task = store.call('updateCollection', {
    accountId: 'a',
    taskId: task.id,
    status: 'running',
    reason: null,
    mode: 'update'
  })
  expect(task).toMatchObject({ phase: 'head', cursor: '5', backfillCursor: '999', mode: 'update' })
  task = store.call('saveCollectionPage', {
    accountId: 'a',
    taskId: task.id,
    remoteId: 'remote-a',
    requestCursor: '5',
    items: [],
    cursor: '0',
    hasMore: false
  })
  expect(task).toMatchObject({ phase: 'backfill', cursor: '999', status: 'running' })
  expect(store.call('checkpoint', { accountId: 'a' })).toMatchObject({ cursor: '999', hasMore: true })
  expect(store.call('query', query).total).toBe(2)
})

it('backfills platform like order in page order, resumes after restart and moves newer likes to the front', () => {
  const { file, store } = setup()
  const account = { accountId: 'a', remoteId: 'remote-a' }
  const liked = { ...query, sort: 'liked' as const }
  store.call('savePage', {
    ...account,
    items: [item('99'), item('7'), item('2'), item('8')],
    cursor: '0',
    hasMore: false
  })
  expect(store.call('query', liked).unrankedLikes).toBe(4)
  const task = store.call('startCollection', { accountId: 'a', id: 'rank', mode: 'full' })
  store.call('saveCollectionPage', {
    ...account,
    taskId: task.id,
    requestCursor: '0',
    items: [item('7'), item('2')],
    cursor: '10',
    hasMore: true
  })
  store.call('close', undefined)
  const resumed = new Store(file)
  stores.push(resumed)
  resumed.call('updateCollection', { accountId: 'a', taskId: task.id, status: 'running', reason: null })
  resumed.call('saveCollectionPage', {
    ...account,
    taskId: task.id,
    requestCursor: '10',
    items: [item('8'), item('2')],
    cursor: '0',
    hasMore: false
  })
  expect(resumed.call('query', liked).items.map((work) => work.id)).toEqual(['7', '2', '8', '99'])
  expect(resumed.call('query', liked).unrankedLikes).toBe(1)
  expect(resumed.call('query', { ...liked, offset: 1, limit: 2 }).items.map((work) => work.id)).toEqual([
    '2',
    '8'
  ])
  const head = resumed.call('startCollection', { accountId: 'a', id: 'head', mode: 'incremental' })
  resumed.call('saveCollectionPage', {
    ...account,
    taskId: head.id,
    requestCursor: '0',
    items: [item('8'), item('7')],
    cursor: '0',
    hasMore: false
  })
  expect(resumed.call('matchingIds', liked)).toEqual(['8', '7', '2', '99'])
  const queue = resumed.call('queueCreate', {
    accountId: 'a',
    mode: 'sequence',
    source: { type: 'ids', ids: ['99', '2', '7', '8'], sort: 'liked' }
  })
  expect(queue.work.id).toBe('8')
  expect(queue.next?.id).toBe('7')
})
