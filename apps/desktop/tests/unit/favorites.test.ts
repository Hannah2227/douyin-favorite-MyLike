import { afterEach, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../../src/main/storage/database'
import { parseFavoriteFolders, parseFavoritesPage, parseResponse } from '../../src/main/douyin/parse'
import type { Work, FavoritesTask } from '../../src/shared/contracts'

const roots: string[] = [],
  stores: Store[] = []
const work = (id: string): Work => ({
  id,
  title: `作品 ${id}`,
  author: '作者',
  publishedAt: 1700000000,
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
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'mylike-favorites-test-'))
  roots.push(root)
  const file = join(root, 'mylike.sqlite')
  const store = new Store(file)
  stores.push(store)
  for (const id of ['a', 'b']) {
    store.call('createAccount', { id, name: id.toUpperCase() })
    store.call('bindAccount', {
      accountId: id,
      remoteId: `remote-${id}`,
      nickname: '抖音' + id,
      avatarUrl: null
    })
  }
  return { root, file, store }
}
function save(
  store: Store,
  task: FavoritesTask,
  data: {
    items?: Work[]
    folders?: { id: string; title: string; remoteCount: number }[]
    cursor?: string
    hasMore?: boolean
  }
) {
  return store.call('favoritesSave', {
    accountId: task.accountId,
    taskId: task.id,
    remoteId: `remote-${task.accountId}`,
    stage: task.stage,
    folderId: task.folderId,
    requestCursor: task.cursor,
    cursor: data.cursor ?? '0',
    hasMore: data.hasMore ?? false,
    ...data
  })
}
function round(store: Store, id = 'run') {
  let task = store.call('favoritesStart', { accountId: 'a', id })
  task = save(store, task, { items: [work('1'), work('2')] })
  task = save(store, task, {
    folders: [
      { id: '9007199254740993999', title: '旅行', remoteCount: 1 },
      { id: '8', title: '音乐', remoteCount: 1 }
    ]
  })
  task = save(store, task, { items: [work('1')] })
  return save(store, task, { items: [work('2')] })
}
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.call('close', undefined)
    } catch {}
  }
  for (const root of roots.splice(0)) {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()))
    expect(basename(root)).toMatch(/^mylike-favorites-test-/)
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

it('stores favorites and folder scopes independently of likes and other accounts, with fixed playback sources', () => {
  const { store } = setup()
  store.call('savePage', {
    accountId: 'a',
    remoteId: 'remote-a',
    items: [work('1'), work('3')],
    cursor: '0',
    hasMore: false
  })
  round(store)
  expect(store.call('query', query).items.map((w) => w.id)).toEqual(['3', '1'])
  expect(store.call('query', { ...query, source: 'favorites' }).items.map((w) => w.id)).toEqual(['2', '1'])
  expect(
    store
      .call('query', { ...query, source: 'favorites', folderId: '9007199254740993999' })
      .items.map((w) => w.id)
  ).toEqual(['1'])
  expect(store.call('query', { ...query, accountId: 'b', source: 'favorites' }).total).toBe(0)
  expect(store.call('libraryOverview', { accountId: 'a' }).total).toBe(3)
  expect(store.call('favoriteFolders', { accountId: 'a' })).toEqual(
    expect.arrayContaining([{ id: '8', title: '音乐', remoteCount: 1, localCount: 1 }])
  )
  const queue = store.call('queueCreate', {
    accountId: 'a',
    source: { type: 'filter', filter: { ...query, source: 'favorites', folderId: '8' } },
    mode: 'sequence'
  })
  expect(queue).toMatchObject({ source: 'favorites', total: 1, work: { id: '2' } })
  store.call('deleteLocal', { accountId: 'a', workIds: ['1'] })
  expect(store.call('query', { ...query, source: 'favorites' }).total).toBe(2)
  expect(store.call('queueState', { accountId: 'a' })?.work.id).toBe('2')
})
it('commits new folder membership only when its pagination reaches a credible end', () => {
  const { store } = setup()
  round(store)
  let task = store.call('favoritesStart', { accountId: 'a', id: 'next' })
  task = save(store, task, { items: [work('1'), work('2')] })
  task = save(store, task, {
    folders: [{ id: '9007199254740993999', title: '改名后的旅行', remoteCount: 2 }]
  })
  task = save(store, task, { items: [work('2')], cursor: '9007199254740993998', hasMore: true })
  expect(store.call('query', { ...query, source: 'favorites', folderId: task.folderId }).total).toBe(2)
  expect(() => save(store, task, { items: [], cursor: '9', hasMore: true })).toThrow(/异常空页/)
  expect(store.call('favoritesTask', { accountId: 'a' })?.cursor).toBe('9007199254740993998')
  task = save(store, task, { items: [] })
  expect(task.status).toBe('completed')
  expect(
    store
      .call('query', { ...query, source: 'favorites', folderId: '9007199254740993999' })
      .items.map((w) => w.id)
  ).toEqual(['2'])
  expect(store.call('favoriteFolders', { accountId: 'a' })).toHaveLength(1)
})
it('counts publication years once per account work across likes and favorites, including unknown dates', () => {
  const { store, file } = setup()
  for (const accountId of ['a', 'b'])
    store.call('savePage', {
      accountId,
      remoteId: `remote-${accountId}`,
      items: [work('1'), work('3')],
      cursor: '0',
      hasMore: false
    })
  round(store)
  store.call('savePage', {
    accountId: 'b',
    remoteId: 'remote-b',
    items: [work('4')],
    cursor: '0',
    hasMore: false
  })
  const db = new DatabaseSync(file)
  try {
    db.prepare('UPDATE works SET publishedAt=? WHERE id=?').run(1579090000, '1')
    db.prepare('UPDATE works SET publishedAt=0 WHERE id=?').run('2')
  } finally {
    db.close()
  }
  const overview = store.call('libraryOverview', { accountId: 'a' })
  expect(overview).toMatchObject({ total: 3, likes: 2, favorites: 2, overlap: 1, folders: 2 })
  expect(overview.years).toEqual([
    { year: 2023, count: 1 },
    { year: 2020, count: 1 },
    { year: null, count: 1 }
  ])
  expect(overview.years.reduce((sum, item) => sum + item.count, 0)).toBe(overview.total)
  expect(store.call('libraryOverview', { accountId: 'b' }).years).toEqual([
    { year: 2023, count: 2 },
    { year: 2020, count: 1 }
  ])
})
it('keeps a saved work and its folder after a confirmed unlike removes the like', () => {
  const { store } = setup()
  store.call('savePage', {
    accountId: 'a',
    remoteId: 'remote-a',
    items: [work('1')],
    cursor: '0',
    hasMore: false
  })
  round(store)
  store.call('unlikeCreate', { accountId: 'a', id: 'unlike', mode: 'single', workIds: ['1'] })
  const scope = { accountId: 'a', taskId: 'unlike', workId: '1' }
  store.call('unlikeReserve', scope)
  store.call('unlikeFinish', { ...scope, status: 'success', reason: null, errorCode: null })
  expect(store.call('query', query).total).toBe(0)
  expect(
    store.call('query', { ...query, source: 'favorites', folderId: '9007199254740993999' }).items
  ).toMatchObject([{ id: '1' }])
})
it('upgrades a v5 library and playback queue without losing data, keeping a consistent pre-upgrade backup', () => {
  const { store, file, root } = setup()
  store.call('savePage', {
    accountId: 'a',
    remoteId: 'remote-a',
    items: [work('1')],
    cursor: '9007199254740993998',
    hasMore: true
  })
  const queue = store.call('queueCreate', {
    accountId: 'a',
    source: { type: 'filter', filter: query },
    mode: 'sequence'
  })
  store.call('close', undefined)
  const old = new DatabaseSync(file)
  try {
    old.exec(
      'DROP TABLE saved_cursors;DROP TABLE saved_jobs;DROP TABLE saved_tasks;DROP TABLE saved_members;DROP TABLE saved_folders;DROP TABLE saved_items;ALTER TABLE playback_queues DROP COLUMN source;PRAGMA user_version=5;'
    )
  } finally {
    old.close()
  }
  const upgraded = new Store(file)
  stores.push(upgraded)
  expect(upgraded.call('query', query).items).toMatchObject([{ id: '1' }])
  expect(upgraded.call('checkpoint', { accountId: 'a' })?.cursor).toBe('9007199254740993998')
  expect(upgraded.call('queueState', { accountId: 'a' })).toMatchObject({
    queueId: queue.queueId,
    source: 'likes',
    total: 1
  })
  expect(upgraded.call('query', { ...query, source: 'favorites' }).total).toBe(0)
  const backups = readdirSync(join(root, 'backups'))
  expect(backups).toHaveLength(1)
  expect(backups[0]).toMatch(/^before-v6-/)
  const backup = new DatabaseSync(join(root, 'backups', backups[0]!))
  try {
    expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(5)
    expect(backup.prepare('SELECT workId FROM account_items WHERE accountId=?').all('a')).toEqual([
      { workId: '1' }
    ])
    expect(backup.prepare('PRAGMA quick_check').get()?.quick_check).toBe('ok')
  } finally {
    backup.close()
  }
})
it('preserves exact folder cursors across restart and rejects stale or foreign task writes', () => {
  const { store, file } = setup()
  let task = store.call('favoritesStart', { accountId: 'a', id: 'run' })
  task = save(store, task, { items: [] })
  task = save(store, task, { folders: [{ id: '8', title: '音乐', remoteCount: 2 }] })
  task = save(store, task, { items: [work('1')], cursor: '9007199254740993998', hasMore: true })
  store.call('close', undefined)
  const reopened = new Store(file)
  stores.push(reopened)
  expect(reopened.call('favoritesTask', { accountId: 'a' })).toMatchObject({
    status: 'paused',
    stage: 'folder',
    folderId: '8',
    cursor: '9007199254740993998'
  })
  expect(() => save(reopened, task, { items: [work('2')] })).toThrow(/已变化/)
  task = reopened.call('favoritesUpdate', {
    accountId: 'a',
    taskId: task.id,
    status: 'running',
    reason: null
  })
  expect(() => save(reopened, task, { items: [work('2')], cursor: '0', hasMore: true })).toThrow(/游标重复/)
  expect(() =>
    reopened.call('favoritesUpdate', { accountId: 'b', taskId: task.id, status: 'running', reason: null })
  ).toThrow(/已变化/)
  task = save(reopened, task, { items: [work('2')] })
  expect(task.status).toBe('completed')
  expect(reopened.call('query', { ...query, source: 'favorites', folderId: '8' }).total).toBe(2)
})
it('does not clear old folder membership when an unexpectedly empty folder contradicts its count', () => {
  const { store } = setup()
  round(store)
  let task = store.call('favoritesStart', { accountId: 'a', id: 'next' })
  task = save(store, task, { items: [] })
  task = save(store, task, { folders: [{ id: '9007199254740993999', title: '旅行', remoteCount: 1 }] })
  expect(() => save(store, task, { items: [] })).toThrow(/仍标有作品/)
  expect(store.call('query', { ...query, source: 'favorites', folderId: task.folderId }).total).toBe(1)
})
it('removes an account from current data and all backup versions without losing another account or shared works', () => {
  const { store, root, file } = setup()
  round(store)
  store.call('savePage', {
    accountId: 'b',
    remoteId: 'remote-b',
    items: [work('2'), work('4')],
    cursor: '0',
    hasMore: false
  })
  store.call('backup', { reason: 'manual' })
  const legacy = store.call('backup', { reason: 'manual' })
  const old = new DatabaseSync(join(root, 'backups', legacy.fileName))
  try {
    old.exec(
      'DROP TABLE saved_cursors;DROP TABLE saved_jobs;DROP TABLE saved_tasks;DROP TABLE saved_members;DROP TABLE saved_folders;DROP TABLE saved_items;ALTER TABLE playback_queues DROP COLUMN source;PRAGMA user_version=5;'
    )
  } finally {
    old.close()
  }
  store.call('removeAccount', { accountId: 'a' })
  expect(store.call('accounts', undefined).map((a) => a.id)).toEqual(['b'])
  expect(store.call('query', { ...query, accountId: 'b' }).total).toBe(2)
  expect(store.call('favoriteFolders', { accountId: 'a' })).toHaveLength(0)
  for (const path of [file, ...readdirSync(join(root, 'backups')).map((n) => join(root, 'backups', n))]) {
    const db = new DatabaseSync(path)
    try {
      expect(db.prepare('SELECT id FROM accounts ORDER BY id').all()).toEqual([{ id: 'b' }])
      expect(db.prepare('SELECT id FROM works ORDER BY id').all()).toEqual([{ id: '2' }, { id: '4' }])
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='saved_tasks'").get())
        expect(db.prepare('SELECT count(*) AS n FROM saved_tasks').get()?.n).toBe(0)
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0)
    } finally {
      db.close()
    }
  }
})
it('preserves current account records when a historical backup cannot be redacted', () => {
  const { store, root } = setup()
  round(store)
  store.call('backup', { reason: 'manual' })
  writeFileSync(join(root, 'backups', 'broken.sqlite'), 'broken')
  expect(() => store.call('removeAccount', { accountId: 'a' })).toThrow(/历史备份/)
  expect(store.call('accounts', undefined)).toHaveLength(2)
  expect(store.call('query', { ...query, source: 'favorites' }).total).toBe(2)
})
it('parses collection and folder pagination without rounding long IDs or accepting ambiguous empty pages', () => {
  const folders = parseFavoriteFolders(
    parseResponse(
      '{"status_code":0,"collects_list":[{"collects_id":9007199254740993999,"collects_name":"旅行","aweme_count":2}],"cursor":9007199254740993998,"has_more":1}',
      200
    )
  )
  expect(folders).toMatchObject({
    cursor: '9007199254740993998',
    folders: [{ id: '9007199254740993999', title: '旅行', remoteCount: 2 }]
  })
  expect(parseFavoritesPage({ aweme_list: [], cursor: '0', has_more: '0' })).toMatchObject({
    items: [],
    hasMore: false
  })
  expect(() => parseFavoriteFolders({ collects_list: [], cursor: '0', has_more: 1 })).toThrow(/异常空页/)
  expect(() => parseFavoriteFolders({ collects_list: [], cursor: '0' })).toThrow(/可信/)
})
