import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../../src/main/storage/database'
import { FavoritesService } from '../../src/main/favorites'
import { RecoveryGate } from '../../src/main/recovery'
import { parseFavoritesPage } from '../../src/main/douyin/parse'
import { responseSummary } from '../../src/main/douyin/response-summary'
import { AppError } from '../../src/main/errors'
import type { Database } from '../../src/main/storage/client'
import type { FavoritesTask, Work } from '../../src/shared/contracts'
import type { FavoritesPage } from '../../src/main/storage/favorites'
import { dropFavoriteExtensions } from '../helpers/legacy-schema'

const roots: string[] = [],
  stores: Store[] = [],
  services: FavoritesService[] = []
const work = (id: string): Work => ({
  id,
  title: `作品 ${id}`,
  author: '作者',
  publishedAt: 1,
  coverUrl: null,
  mediaType: 'video',
  isLive: false
})
const query = {
  accountId: 'a',
  source: 'favorites' as const,
  search: '',
  mediaType: 'all' as const,
  year: null,
  month: null,
  sort: 'published' as const,
  offset: 0,
  limit: 60
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'mylike-favorite-recovery-'))
  roots.push(root)
  const file = join(root, 'db.sqlite'),
    store = new Store(file)
  stores.push(store)
  for (const id of ['a', 'b']) {
    store.call('createAccount', { id, name: id })
    store.call('bindAccount', { accountId: id, remoteId: `remote-${id}`, nickname: id, avatarUrl: null })
  }
  return { store, file, root }
}
function save(store: Store, task: FavoritesTask, page: Partial<FavoritesPage> = {}) {
  return store.call('favoritesSave', {
    accountId: task.accountId,
    taskId: task.id,
    remoteId: `remote-${task.accountId}`,
    mode: task.mode,
    stage: task.stage,
    folderId: task.folderId,
    requestCursor: task.cursor,
    cursor: '0',
    hasMore: false,
    items: [],
    ...page
  })
}
function folders(store: Store, id = 'sync', count = 2) {
  let task = store.call('favoritesStart', { accountId: 'a', id })
  task = save(store, task)
  return save(store, task, {
    folders: Array.from({ length: count }, (_, i) => ({
      id: String(i + 8),
      title: `夹 ${i + 8}`,
      remoteCount: 1
    }))
  })
}
function service(
  store: Store,
  request: (...args: any[]) => Promise<any>,
  timing: { retry?: number } = {},
  changed: (committed?: boolean) => void = () => {}
) {
  const instance = new FavoritesService(
    { call: async (method: any, input: any) => store.call(method, input) } as Pick<Database, 'call'>,
    { request, cancel: () => {}, release: () => {}, snapshot: () => ({ status: 'hidden' }) } as any,
    async (_id, action) => action(() => {}),
    async (id) => store.call('accounts', undefined).find((a) => a.id === id)!,
    changed,
    { interval: 0, retry: 0, pagesPerSegment: 100, segmentMs: 100000, cooldown: 0, ...timing }
  )
  services.push(instance)
  return instance
}
async function settled(instance: FavoritesService) {
  for (let i = 0; i < 500 && instance.running; i++) await new Promise((r) => setTimeout(r, 2))
  expect(instance.running).toBe(false)
}
afterEach(async () => {
  for (const instance of services.splice(0)) await instance.pause()
  for (const store of stores.splice(0))
    try {
      store.call('close', undefined)
    } catch {}
  for (const root of roots.splice(0)) {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith('mylike-favorite-recovery-')
    )
      throw Error('Unsafe cleanup')
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})

it('isolates malformed works without accepting a malformed list or weakening likes', () => {
  const page = parseFavoritesPage({
    status_code: 0,
    has_more: 1,
    cursor: '9',
    aweme_list: [{ aweme_id: '1' }, null, { aweme_id: 'broken' }, { aweme_id: '2' }]
  })
  expect(page.items.map((w) => w.id)).toEqual(['1', '2'])
  expect(page).toMatchObject({
    received: 4,
    skipped: [{ position: 2 }, { position: 3 }],
    cursor: '9',
    hasMore: true
  })
  expect(() => parseFavoritesPage({ status_code: 0, has_more: 1, cursor: '9' })).toThrow(/缺少有效/)
  expect(() => parseFavoritesPage({ status_code: 0, has_more: 0, aweme_list: {} })).toThrow(/缺少有效/)
  expect(() =>
    parseFavoritesPage({ has_more: 1, cursor: '0', aweme_list: [] }, { allowEmpty: true })
  ).toThrow(/游标/)
})
it('records response shape without storing response fields or credential contents', () => {
  const result = responseSummary(
    JSON.stringify({ status_code: 0, has_more: 1, aweme_list: 'SECRET', cookie: 'TOKEN', cursor: 'PRIVATE' }),
    200,
    'favorites'
  )
  expect(result.shape).toBe('aweme_list=string；has_more=1；status_code=0')
  expect(JSON.stringify(result)).not.toMatch(/SECRET|TOKEN|PRIVATE/)
})
it('defers one broken folder, continues the next and preserves old memberships until a clean retry', () => {
  const { store } = setup()
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work: work('1'),
    folder: { id: '8', title: '夹 8', remoteCount: 1, localCount: 0 }
  })
  let task = folders(store)
  task = save(store, task, { items: [work('2')], skipped: [{ position: 2 }], received: 2 })
  expect(task).toMatchObject({ folderId: '9', status: 'running', foldersDone: 0, foldersDeferred: 1 })
  expect(store.call('query', { ...query, folderId: '8' }).total).toBe(2)
  task = save(store, task, { items: [work('3')] })
  expect(task).toMatchObject({
    status: 'partial',
    foldersDone: 1,
    foldersDeferred: 1,
    issues: [{ folderId: '8' }]
  })
  task = store.call('favoritesUpdate', { accountId: 'a', taskId: task.id, status: 'running', reason: null })
  expect(task.folderId).toBe('8')
  task = save(store, task, { items: [work('3')] })
  expect(task.status).toBe('completed')
  expect(store.call('query', { ...query, folderId: '8' }).items.map((w) => w.id)).toEqual(['3'])
  expect(store.call('query', { ...query, folderId: '9' }).total).toBe(1)
})
it('preserves a failed folder checkpoint and rejects stale defer requests', () => {
  const { store } = setup()
  let task = folders(store)
  task = save(store, task, { items: [work('1')], cursor: '5', hasMore: true })
  const first = task
  task = store.call('favoritesDefer', {
    accountId: 'a',
    taskId: task.id,
    folderId: '8',
    requestCursor: '5',
    reason: '空页',
    errorCode: 'EMPTY_PAGE'
  })
  expect(task.folderId).toBe('9')
  expect(() =>
    store.call('favoritesDefer', {
      accountId: 'b',
      taskId: first.id,
      folderId: '8',
      requestCursor: '5',
      reason: 'stale',
      errorCode: 'EMPTY_PAGE'
    })
  ).toThrow(/已变化/)
  expect(store.call('query', { ...query, folderId: '8' }).total).toBe(1)
})
it('preserves explicit folder additions across partial retries and keeps a finished partial task resumable after stop', () => {
  const { store } = setup()
  let task = folders(store, 'sync', 1)
  task = save(store, task, { items: [work('1')], skipped: [{ position: 2 }], received: 2 })
  expect(task.status).toBe('partial')
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work: work('2'),
    folder: { id: '8', title: '夹 8', remoteCount: 2, localCount: 1 }
  })
  task = store.call('favoritesUpdate', { accountId: 'a', taskId: task.id, status: 'stopped', reason: '停止' })
  expect(task.status).toBe('partial')
  task = store.call('favoritesUpdate', { accountId: 'a', taskId: task.id, status: 'running', reason: null })
  task = save(store, task, { items: [work('3')] })
  expect(task.status).toBe('completed')
  expect(store.call('query', { ...query, folderId: '8' }).items.map((w) => w.id)).toEqual(['3', '2'])
})
it('does not record a confirmed end for a folder containing skipped entries from an earlier page', () => {
  const { store } = setup()
  let task = folders(store, 'sync', 2)
  task = save(store, task, {
    items: [work('1')],
    skipped: [{ position: 2 }],
    received: 2,
    cursor: '5',
    hasMore: true
  })
  save(store, task, { items: [work('2')] })
  const events = store.call('runtimeEvents', { accountId: 'a' })
  expect(events.filter((e) => e.code === 'END_CONFIRMED' && e.operation === 'folderItems')).toHaveLength(0)
})
it('only commits bounded empty traversal with content and preserves old folder classifications', () => {
  const { store } = setup()
  let task = folders(store, 'sync', 1)
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work: work('1'),
    folder: { id: '8', title: '夹 8', remoteCount: 1, localCount: 0 }
  })
  expect(() =>
    save(store, task, {
      requestCursor: '5',
      checkpointCursor: '0',
      traversedCursors: ['0', '4'],
      items: [work('2')]
    })
  ).toThrow(/范围无效/)
  expect(store.call('favoritesTask', { accountId: 'a' })?.cursor).toBe('0')
  task = save(store, task, {
    requestCursor: '5',
    checkpointCursor: '0',
    traversedCursors: ['0', '5'],
    items: [work('2')],
    incomplete: true
  })
  expect(task.status).toBe('partial')
  expect(store.call('query', { ...query, folderId: '8' }).total).toBe(2)
})
it('updates new favorites independently of a paused folder checkpoint and stops on an already-known page', () => {
  const { store } = setup()
  const sync = folders(store, 'sync', 1)
  store.call('favoritesUpdate', { accountId: 'a', taskId: sync.id, status: 'paused', reason: '保持断点' })
  store.call('favoriteConfirm', { accountId: 'a', remoteId: 'remote-a', work: work('1') })
  let task = store.call('favoritesStart', { accountId: 'a', id: 'update', mode: 'update' })
  task = save(store, task, { items: [work('2'), work('1')], cursor: '5', hasMore: true })
  expect(task).toMatchObject({ mode: 'update', status: 'running', added: 1 })
  task = save(store, task, { items: [work('1')], cursor: '6', hasMore: true })
  expect(task).toMatchObject({ status: 'completed', added: 1 })
  expect(store.call('favoritesTask', { accountId: 'a' })).toMatchObject({
    id: sync.id,
    status: 'paused',
    folderId: '8',
    cursor: '0'
  })
  expect(store.call('query', query).total).toBe(2)
  expect(store.call('favoriteFolders', { accountId: 'a' })).toHaveLength(1)
})
it('preserves independent update checkpoints across restart and removes them from historical backups on account deletion', () => {
  const { store, file, root } = setup()
  let task = store.call('favoritesStart', { accountId: 'a', id: 'update', mode: 'update' })
  task = save(store, task, { items: [work('1')], cursor: '9', hasMore: true })
  store.call('backup', { reason: 'manual' })
  store.call('close', undefined)
  const reopened = new Store(file)
  stores.push(reopened)
  expect(reopened.call('favoritesTask', { accountId: 'a', mode: 'update' })).toMatchObject({
    cursor: '9',
    status: 'paused'
  })
  reopened.call('removeAccount', { accountId: 'a' })
  for (const f of [file, ...readdirSync(join(root, 'backups')).map((f) => join(root, 'backups', f))]) {
    const db = new DatabaseSync(f, { readOnly: true })
    expect(db.prepare('SELECT count(*) AS n FROM saved_updates').get()?.n).toBe(0)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0)
    db.close()
  }
})
it('keeps the v7 core layout and preserves current folder progress without an incompatible version bump', () => {
  const { store, file, root } = setup()
  let task = folders(store, 'sync', 1)
  task = save(store, task, { items: [work('1')], cursor: '5', hasMore: true })
  store.call('close', undefined)
  const old = new DatabaseSync(file)
  dropFavoriteExtensions(old)
  old.close()
  const reopened = new Store(file)
  stores.push(reopened)
  expect(reopened.call('favoritesTask', { accountId: 'a' })).toMatchObject({
    cursor: '5',
    folderId: '8',
    status: 'paused'
  })
  expect(reopened.call('query', { ...query, folderId: '8' }).items.map((w) => w.id)).toEqual(['1'])
  expect(readdirSync(root).includes('backups')).toBe(false)
  const db = new DatabaseSync(file, { readOnly: true })
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(7)
  expect(
    db
      .prepare('PRAGMA table_info(saved_tasks)')
      .all()
      .map((row) => row.name)
  ).not.toContain('incomplete')
  expect(
    db
      .prepare('PRAGMA table_info(saved_jobs)')
      .all()
      .map((row) => row.name)
  ).not.toContain('scanId')
  expect(db.prepare('PRAGMA quick_check').get()?.quick_check).toBe('ok')
  db.close()
})
it('continues good folders after a contradictory empty folder, without reporting full success', async () => {
  const { store } = setup()
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work: work('2'),
    folder: { id: '8', title: '夹 8', remoteCount: 1, localCount: 0 }
  })
  folders(store, 'sync', 2)
  store.call('favoritesUpdate', { accountId: 'a', taskId: 'sync', status: 'paused', reason: null })
  const calls: string[] = []
  const instance = service(store, async (_id, _operation, params) => {
    calls.push(params.collects_id)
    return {
      status_code: 0,
      has_more: 0,
      cursor: '0',
      aweme_list: params.collects_id === '8' ? [] : [{ aweme_id: '1' }]
    }
  })
  await instance.start('a')
  await settled(instance)
  expect(calls).toContain('9')
  expect(store.call('favoritesTask', { accountId: 'a' })).toMatchObject({
    status: 'partial',
    foldersDone: 1,
    foldersDeferred: 1
  })
  expect(store.call('query', { ...query, folderId: '8' }).items.map((w) => w.id)).toEqual(['2'])
})
it('accepts a confirmed empty folder despite a stale remote count when no local members would be discarded', () => {
  const { store } = setup()
  const task = save(store, folders(store, 'sync', 1))
  expect(task).toMatchObject({ status: 'completed', foldersDone: 1, foldersDeferred: 0 })
  expect(store.call('favoriteFolders', { accountId: 'a' })).toMatchObject([
    { id: '8', remoteCount: 1, localCount: 0 }
  ])
})
it('stops for systemic auth failures instead of skipping more folders', async () => {
  const { store } = setup()
  folders(store, 'sync', 4)
  store.call('favoritesUpdate', { accountId: 'a', taskId: 'sync', status: 'paused', reason: null })
  let calls = 0
  const instance = service(store, async () => {
    calls++
    throw new AppError('RATE_LIMITED', '限流')
  })
  await instance.start('a')
  await settled(instance)
  expect(calls).toBe(1)
  expect(store.call('favoritesTask', { accountId: 'a' })).toMatchObject({
    status: 'paused',
    folderId: '8',
    foldersDeferred: 0,
    errorCode: 'RATE_LIMITED'
  })
})
it('bounds consecutive malformed folder failures and readonly diagnostics never change progress', async () => {
  const { store } = setup()
  folders(store, 'sync', 4)
  store.call('favoritesUpdate', { accountId: 'a', taskId: 'sync', status: 'paused', reason: null })
  const instance = service(store, async () => ({ status_code: 0, has_more: 1, cursor: '8' }))
  const before = store.call('favoritesTask', { accountId: 'a' })
  await expect(instance.probe('a')).rejects.toThrow(/缺少有效/)
  expect(store.call('favoritesTask', { accountId: 'a' })).toEqual(before)
  await instance.start('a')
  await settled(instance)
  expect(store.call('favoritesTask', { accountId: 'a' })).toMatchObject({
    status: 'paused',
    folderId: '10',
    foldersDeferred: 2,
    errorCode: 'UPSTREAM_CHANGED'
  })
})
it('retries a temporary network failure only once and does not repeat schema or risk failures', async () => {
  for (const errorCode of ['NETWORK_ERROR', 'TIMEOUT', 'UPSTREAM_CHANGED', 'UPSTREAM_RISK_CONTROL']) {
    const { store } = setup()
    let calls = 0
    const instance = service(store, async (_account, _operation, params) => {
      expect(params.count).toBe('20')
      expect(params.version_code).toBeUndefined()
      calls++
      throw new AppError(errorCode, 'fixture failure')
    })
    await instance.start('a')
    await settled(instance)
    expect(calls).toBe(['NETWORK_ERROR', 'TIMEOUT'].includes(errorCode) ? 2 : 1)
    expect(store.call('favoritesTask', { accountId: 'a' })).toMatchObject({
      status: 'paused',
      cursor: '0',
      pages: 0,
      errorCode
    })
  }
})
it('allows one SDK page recovery but bounds persistent page failures', async () => {
  const { store } = setup()
  let calls = 0
  const instance = service(store, async () => {
    calls++
    throw new AppError('BROWSER_NOT_READY', 'page not ready')
  })
  await instance.start('a')
  await settled(instance)
  expect(calls).toBe(2)
  expect(store.call('favoritesTask', { accountId: 'a' })).toMatchObject({
    status: 'paused',
    cursor: '0',
    pages: 0,
    errorCode: 'BROWSER_NOT_READY'
  })
})
it('rechecks a stable empty page before traversing and commits the resulting content atomically', async () => {
  const { store } = setup()
  const cursors: string[] = []
  const instance = service(store, async (_id, operation, params) => {
    if (operation === 'folders') return { status_code: 0, has_more: 0, collects_list: [] }
    cursors.push(params.cursor)
    return params.cursor === '0'
      ? { status_code: 0, has_more: 1, cursor: '5', aweme_list: [] }
      : { status_code: 0, has_more: 0, cursor: '0', aweme_list: [{ aweme_id: '1' }] }
  })
  await instance.start('a')
  await settled(instance)
  expect(cursors).toEqual(['0', '0', '5', '5'])
  expect(store.call('query', query).total).toBe(1)
  expect(store.call('favoritesTask', { accountId: 'a' })?.status).toBe('partial')
})

it('allows a user pause to cancel a light network retry immediately without moving the checkpoint', async () => {
  const { store } = setup()
  let calls = 0
  const instance = service(
    store,
    async () => {
      calls++
      throw new AppError('NETWORK_ERROR', 'fixture network failure')
    },
    { retry: 60_000 }
  )
  const task = await instance.start('a')
  await expect.poll(() => calls).toBe(1)
  await new Promise((resolve) => setTimeout(resolve, 10))
  await instance.control('a', task.id, 'pause')
  expect(instance.running).toBe(false)
  expect(calls).toBe(1)
  expect(store.call('favoritesTask', { accountId: 'a' })).toMatchObject({
    status: 'paused',
    cursor: '0',
    pages: 0
  })
})

it('checks the deferred-folder wait before restarting a partial task or changing its persisted state', async () => {
  const { store } = setup()
  const partial = save(store, folders(store, 'sync', 1), {
    items: [work('1')],
    skipped: [{ position: 2 }],
    received: 2
  })
  expect(partial).toMatchObject({ status: 'partial', incomplete: 0, foldersDeferred: 1 })
  const gate = new RecoveryGate()
  gate.failure('a', 'folderItems', 'RATE_LIMITED')
  let calls = 0
  const instance = new FavoritesService(
    { call: async (method: any, input: any) => store.call(method, input) } as Pick<Database, 'call'>,
    {
      assertAvailable: (accountId: string, operation: string) => gate.assertReady(accountId, operation),
      request: async () => {
        calls++
        return {}
      },
      cancel: () => {},
      release: () => {},
      snapshot: () => ({ status: 'ready' })
    } as any,
    async (_id, action) => action(() => {}),
    async () => store.call('accounts', undefined)[0]!,
    () => {},
    { interval: 0, retry: 0, pagesPerSegment: 100, segmentMs: 100000, cooldown: 0 }
  )
  services.push(instance)
  await expect(instance.start('a')).rejects.toMatchObject({ code: 'RATE_LIMITED' })
  await expect(instance.control('a', partial.id, 'resume')).rejects.toMatchObject({ code: 'RATE_LIMITED' })
  expect(calls).toBe(0)
  expect(instance.running).toBe(false)
  expect(store.call('favoritesTask', { accountId: 'a' })).toEqual(partial)
})

it('announces committed folder pages after restart so readers see every restored member', async () => {
  const { store, file } = setup()
  let task = folders(store)
  task = save(store, task, { items: [work('1')], cursor: '5', hasMore: true })
  store.call('favoritesUpdate', { accountId: 'a', taskId: task.id, status: 'paused', reason: '暂停' })
  store.call('close', undefined)
  const reopened = new Store(file)
  stores.push(reopened)
  const snapshots: { id: string; localCount: number }[][] = []
  let reads = 0
  const instance = service(
    reopened,
    async (_account, operation, parameters) => {
      expect(operation).toBe('folderItems')
      reads++
      return {
        status_code: 0,
        has_more: 0,
        cursor: '0',
        aweme_list: [{ aweme_id: parameters.collects_id === '8' ? '2' : '3' }]
      }
    },
    {},
    (committed) => {
      if (committed) snapshots.push(reopened.call('favoriteFolders', { accountId: 'a' }))
    }
  )
  await instance.start('a')
  await settled(instance)
  expect(reads).toBe(4) // Two reads confirm each folder's final page; only committed pages notify.
  expect(snapshots).toHaveLength(2)
  expect(snapshots[0]).toEqual([
    expect.objectContaining({ id: '8', localCount: 2 }),
    expect.objectContaining({ id: '9', localCount: 0 })
  ])
  expect(snapshots[1]).toEqual([
    expect.objectContaining({ id: '8', localCount: 2 }),
    expect.objectContaining({ id: '9', localCount: 1 })
  ])
  expect(reopened.call('favoritesTask', { accountId: 'a' })?.status).toBe('completed')
})

it('does not announce a committed page when the folder transaction rolls back', async () => {
  const { store, file } = setup()
  const before = folders(store)
  const raw = new DatabaseSync(file)
  try {
    raw.exec(
      "CREATE TRIGGER reject_favorite_member BEFORE INSERT ON saved_members BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END"
    )
  } finally {
    raw.close()
  }
  const notifications: (boolean | undefined)[] = []
  const instance = service(
    store,
    async () => ({
      status_code: 0,
      has_more: 0,
      cursor: '0',
      aweme_list: [{ aweme_id: '1' }]
    }),
    {},
    (committed) => notifications.push(committed)
  )
  await instance.start('a')
  await settled(instance)
  expect(notifications).not.toContain(true)
  expect(store.call('favoritesTask', { accountId: 'a' })).toMatchObject({
    status: 'paused',
    folderId: '8',
    cursor: before.cursor,
    pages: before.pages
  })
  expect(store.call('query', query).total).toBe(0)
  expect(store.call('favoriteFolders', { accountId: 'a' }).map((folder) => folder.localCount)).toEqual([0, 0])
})
