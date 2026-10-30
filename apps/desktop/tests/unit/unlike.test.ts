import { dropFavoriteExtensions } from '../helpers/legacy-schema'
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../../src/main/storage/database'
import { UnlikeService } from '../../src/main/unlike'
import { AppError } from '../../src/main/errors'
import { parseResponse } from '../../src/main/douyin/parse'
import type { Work } from '../../src/shared/contracts'
import type { Database } from '../../src/main/storage/client'
const folders: string[] = [],
  stores: Store[] = [],
  services: UnlikeService[] = []
const work = (id: string): Work => ({
  id,
  title: `title-${id}`,
  author: 'A',
  publishedAt: 1700000000,
  coverUrl: null,
  mediaType: 'video',
  isLive: false
})
const scope = { accountId: 'a', taskId: 'task' }
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
  const folder = mkdtempSync(join(tmpdir(), 'mylike-unlike-test-'))
  folders.push(folder)
  const file = join(folder, 'db.sqlite'),
    store = new Store(file)
  stores.push(store)
  for (const id of ['a', 'b']) {
    store.call('createAccount', { id, name: id })
    store.call('bindAccount', { accountId: id, remoteId: `remote-${id}`, nickname: id, avatarUrl: null })
    store.call('savePage', {
      accountId: id,
      remoteId: `remote-${id}`,
      items: [work('1'), work('2')],
      cursor: '0',
      hasMore: false
    })
  }
  return { folder, file, store }
}
function create(store: Store) {
  return store.call('unlikeCreate', { accountId: 'a', id: 'task', mode: 'batch', workIds: ['1', '2'] })
}
function reserve(store: Store) {
  store.call('unlikeReserve', { ...scope, workId: '1' })
}
const finish = (store: Store, status: 'success' | 'unknown') =>
  store.call('unlikeFinish', { ...scope, workId: '1', status, reason: null, errorCode: null })
function service(store: Store, request: (...args: any[]) => Promise<any>) {
  const db = { call: async (method: any, input: any) => store.call(method, input) } as Database
  const value = new UnlikeService(
    db,
    { request },
    async (_id, action) => action(() => {}),
    async () => store.call('accounts', undefined)[0]!,
    () => {},
    0
  )
  services.push(value)
  return value
}
async function settled(value: UnlikeService) {
  for (let i = 0; i < 300 && value.running; i++) await new Promise((r) => setTimeout(r, 2))
  expect(value.running).toBe(false)
}
afterEach(async () => {
  for (const value of services.splice(0)) await value.stop()
  for (const store of stores.splice(0))
    try {
      store.call('close', undefined)
    } catch {
      /* reopened */
    }
  for (const folder of folders.splice(0)) {
    if (dirname(resolve(folder)) !== resolve(tmpdir()) || !basename(folder).startsWith('mylike-unlike-test-'))
      throw new Error('Unsafe cleanup')
    rmSync(folder, { recursive: true, force: true })
  }
})
it('commits success with local removal atomically and retains another account plus queue references', () => {
  const { store, file } = setup()
  store.call('queueCreate', {
    accountId: 'a',
    source: { type: 'ids', ids: ['1'], sort: 'published' },
    mode: 'sequence'
  })
  create(store)
  reserve(store)
  const raw = new DatabaseSync(file)
  raw.exec(
    "CREATE TRIGGER fail_remove BEFORE DELETE ON account_items BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END;"
  )
  expect(() => finish(store, 'success')).toThrow(/fixture disk failure/)
  expect(store.call('unlikeTask', scope)?.inflight).toBe(1)
  expect(store.call('query', query).total).toBe(2)
  raw.exec('DROP TRIGGER fail_remove')
  raw.close()
  expect(finish(store, 'success').success).toBe(1)
  expect(store.call('query', query).total).toBe(1)
  expect(store.call('query', { ...query, accountId: 'b' }).total).toBe(2)
  expect(store.call('queueState', { accountId: 'a' })?.work.id).toBe('1')
  expect(() => finish(store, 'unknown')).toThrow(/不能覆盖/)
})
it('recovers an interrupted write as unknown, blocks new writes across history, and scopes readonly resolution', () => {
  const { store, file } = setup()
  create(store)
  reserve(store)
  store.call('close', undefined)
  const reopened = new Store(file)
  stores.push(reopened)
  expect(reopened.call('unlikeTask', scope)).toMatchObject({ status: 'paused', unknown: 1, pending: 1 })
  expect(reopened.call('query', query).total).toBe(2)
  expect(() =>
    reopened.call('unlikeCreate', { accountId: 'a', id: 'new', mode: 'single', workIds: ['1'] })
  ).toThrow(/结果未知/)
  expect(() =>
    reopened.call('unlikeResolve', { ...scope, accountId: 'b', workId: '1', liked: false })
  ).toThrow(/账号已变化/)
  reopened.call('unlikeResolve', { ...scope, workId: '1', liked: true })
  expect(reopened.call('query', query).total).toBe(2)
  expect(
    reopened.call('unlikeCreate', { accountId: 'a', id: 'new', mode: 'single', workIds: ['1'] }).pending
  ).toBe(1)
})
it('waits for an inflight success when stopped, and sends no following write', async () => {
  const { store } = setup()
  let sent = 0,
    complete!: () => void
  const value = service(store, async (_account, operation) => {
    expect(operation).toBe('unlike')
    sent++
    await new Promise<void>((r) => {
      complete = r
    })
    return { status_code: 0 }
  })
  const task = await value.start('a', ['1', '2'], 'batch')
  for (let i = 0; i < 100 && !sent; i++) await new Promise((r) => setTimeout(r, 1))
  const stop = value.stop()
  expect(value.running).toBe(true)
  complete()
  await stop
  expect(sent).toBe(1)
  expect(store.call('unlikeTask', { accountId: 'a', taskId: task.id })).toMatchObject({
    status: 'stopped',
    success: 1,
    pending: 1,
    unknown: 0
  })
})
it('does not retry an uncertain write; explicit resume only sends pending items', async () => {
  const { store } = setup()
  const sent: string[] = []
  const value = service(store, async (_account, _operation, parameters) => {
    sent.push(parameters.aweme_id)
    if (parameters.aweme_id === '1') throw new AppError('TIMEOUT', 'fixture timeout')
    return { status_code: 0 }
  })
  const task = await value.start('a', ['1', '2'], 'batch')
  await settled(value)
  expect(store.call('unlikeTask', { accountId: 'a' })).toMatchObject({
    status: 'paused',
    unknown: 1,
    pending: 1
  })
  await value.resume('a', task.id)
  await settled(value)
  expect(sent).toEqual(['1', '2'])
  expect(store.call('unlikeTask', { accountId: 'a' })).toMatchObject({
    status: 'completed',
    unknown: 1,
    success: 1
  })
  expect(store.call('query', query).items.map((item) => item.id)).toEqual(['1'])
})
it('checks legacy unverified membership before any write and preserves an unliked local record', async () => {
  const { store, file } = setup()
  store.call('savePage', {
    accountId: 'a',
    remoteId: 'remote-a',
    items: [work('3')],
    cursor: '0',
    hasMore: false
  })
  const raw = new DatabaseSync(file)
  try {
    raw.prepare('UPDATE account_items SET platformSeen=0 WHERE accountId=? AND workId=?').run('a', '3')
  } finally {
    raw.close()
  }
  const operations: string[] = []
  const value = service(store, async (_account, operation) => {
    operations.push(operation)
    return { aweme_detail: { aweme_id: '3', user_digged: 0 } }
  })
  await value.start('a', ['3'], 'single')
  await settled(value)
  expect(operations).toEqual(['detail'])
  expect(store.call('query', query).total).toBe(3)
  expect(store.call('unlikeTask', { accountId: 'a' })).toMatchObject({ failed: 1, success: 0, unknown: 0 })
})
it('pauses on a definite platform rejection without falsely marking success or automatically retrying', async () => {
  const { store } = setup()
  let writes = 0
  const value = service(store, async () => {
    writes++
    throw new AppError('API_REJECTED', 'fixture reject')
  })
  await value.start('a', ['1', '2'], 'batch')
  await settled(value)
  expect(writes).toBe(1)
  expect(store.call('unlikeTask', { accountId: 'a' })).toMatchObject({
    status: 'paused',
    failed: 1,
    unknown: 0,
    pending: 1
  })
  expect(store.call('query', query).total).toBe(2)
})
it('does not send when the current verified identity differs from the fixed task owner', async () => {
  const { store } = setup()
  let writes = 0
  const db = { call: async (method: any, input: any) => store.call(method, input) } as Database
  const value = new UnlikeService(
    db,
    {
      request: async () => {
        writes++
        return {}
      }
    },
    async (_id, action) => action(() => {}),
    async () => ({ ...store.call('accounts', undefined)[0]!, remoteId: 'different-owner' }),
    () => {},
    0
  )
  services.push(value)
  await value.start('a', ['1'], 'single')
  await settled(value)
  expect(writes).toBe(0)
  expect(store.call('unlikeTask', { accountId: 'a' })).toMatchObject({
    status: 'paused',
    errorCode: 'IDENTITY_MISMATCH',
    pending: 1,
    unknown: 0
  })
})
it('keeps unknown results when readonly verification lacks a definite flag, then resolves without issuing POST', async () => {
  const { store } = setup()
  create(store)
  reserve(store)
  finish(store, 'unknown')
  store.call('unlikeUpdate', { ...scope, status: 'paused', reason: null })
  let flag: number | undefined
  const value = service(store, async (_account, operation) => {
    expect(operation).toBe('detail')
    return { aweme_detail: { aweme_id: '1', user_digged: flag } }
  })
  await expect(value.verify('a', 'task', '1')).rejects.toThrow(/明确的当前点赞状态/)
  expect(store.call('unlikeTask', scope)?.unknown).toBe(1)
  flag = 0
  await value.verify('a', 'task', '1')
  expect(store.call('unlikeTask', scope)).toMatchObject({ success: 1, unknown: 0 })
  expect(store.call('query', query).total).toBe(1)
})

function collectFavorites(store: Store) {
  for (const accountId of ['a', 'b']) {
    for (const id of ['1', '2']) {
      for (const folderId of ['10', '20'])
        store.call('favoriteConfirm', {
          accountId,
          remoteId: `remote-${accountId}`,
          work: work(id),
          folder: { id: folderId, title: folderId, remoteCount: 2, localCount: 0 }
        })
    }
  }
}
const favoriteDetail = (id: string, collected = true) => ({
  status_code: 0,
  aweme_detail: {
    aweme_id: id,
    collect_stat: collected ? 1 : 0,
    aweme_type: 68,
    desc: 'fixture',
    create_time: 1700000000,
    author: { nickname: 'A' }
  }
})
it('atomically removes a confirmed collection from all folders, preserving likes, queues and other accounts', () => {
  const { store, file } = setup()
  collectFavorites(store)
  const queue = store.call('queueCreate', {
    accountId: 'a',
    source: { type: 'ids', source: 'favorites', ids: ['1'], sort: 'published' },
    mode: 'sequence'
  })
  expect(queue.source).toBe('favorites')
  store.call('unlikeCreate', { ...scope, id: 'task', mode: 'single', source: 'favorites', workIds: ['1'] })
  reserve(store)
  const raw = new DatabaseSync(file)
  raw.exec(
    "CREATE TRIGGER fail_remove BEFORE DELETE ON saved_items BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END;"
  )
  expect(() => finish(store, 'success')).toThrow(/fixture disk failure/)
  expect(store.call('unlikeTask', scope)?.inflight).toBe(1)
  expect(store.call('favoriteFolders', { accountId: 'a' }).map((folder) => folder.localCount)).toEqual([2, 2])
  raw.exec('DROP TRIGGER fail_remove')
  raw.close()
  expect(finish(store, 'success')).toMatchObject({ source: 'favorites', success: 1 })
  expect(store.call('query', { ...query, source: 'favorites' }).total).toBe(1)
  expect(
    store.call('favoriteFolders', { accountId: 'a' }).map((folder) => [folder.localCount, folder.remoteCount])
  ).toEqual([
    [1, 1],
    [1, 1]
  ])
  expect(store.call('query', query).total).toBe(2)
  expect(store.call('query', { ...query, accountId: 'b', source: 'favorites' }).total).toBe(2)
  expect(store.call('queueState', { accountId: 'a' })).toMatchObject({
    queueId: queue.queueId,
    work: { id: '1' }
  })
})
it('reads collection state and type before cancelling, syncing already-uncollected items without a POST', async () => {
  const { store } = setup()
  collectFavorites(store)
  const operations: string[] = []
  const value = service(store, async (_account, operation, parameters) => {
    operations.push(`${operation}:${parameters.aweme_id}`)
    if (operation === 'detail') return favoriteDetail(parameters.aweme_id, parameters.aweme_id === '1')
    expect(parameters.aweme_type).toBe('68')
    return { status_code: 0 }
  })
  await value.start('a', ['1', '2'], 'batch', 'favorites')
  await settled(value)
  expect(operations).toEqual(['detail:1', 'favoriteRemove:1', 'detail:2'])
  expect(store.call('unlikeTask', { accountId: 'a' })).toMatchObject({
    source: 'favorites',
    success: 2,
    unknown: 0,
    status: 'completed'
  })
  expect(store.call('query', { ...query, source: 'favorites' }).total).toBe(0)
  expect(store.call('query', query).total).toBe(2)
})
it('skips an explicitly unavailable favorite immediately and continues without removing local data', async () => {
  const { store } = setup()
  collectFavorites(store)
  const reads: string[] = [],
    writes: string[] = []
  const value = service(store, async (_account, operation, parameters) => {
    if (operation === 'detail') {
      reads.push(parameters.aweme_id)
      return parameters.aweme_id === '1'
        ? { status_code: 0, aweme_detail: null, filter_detail: { aweme_id: '1', filter_reason: 'core_dep' } }
        : favoriteDetail(parameters.aweme_id)
    }
    writes.push(parameters.aweme_id)
    return { status_code: 0 }
  })
  const task = await value.start('a', ['1', '2'], 'batch', 'favorites')
  await settled(value)
  expect(reads).toEqual(['1', '2'])
  expect(writes).toEqual(['2'])
  expect(store.call('unlikeTask', { accountId: 'a' })).toMatchObject({
    status: 'completed',
    failed: 1,
    success: 1,
    pending: 0,
    unknown: 0
  })
  expect(store.call('query', { ...query, source: 'favorites' }).items.map((w) => w.id)).toEqual(['1'])
  expect(
    store.call('unlikeItems', { accountId: 'a', taskId: task.id, offset: 0, limit: 50, issuesOnly: true })
  ).toMatchObject({ total: 1, items: [{ workId: '1', errorCode: 'ITEM_SKIPPED', status: 'failed' }] })
  await expect(value.resume('a', task.id)).rejects.toThrow(/没有未发送/)
})
it('does not misclassify account rejection as an unavailable favorite or skip the rest of a batch', async () => {
  const { store } = setup()
  collectFavorites(store)
  let calls = 0
  const value = service(store, async () => {
    calls++
    throw new AppError('AUTH_REQUIRED', '登录失效')
  })
  await value.start('a', ['1', '2'], 'batch', 'favorites')
  await settled(value)
  expect(calls).toBe(1)
  expect(store.call('unlikeTask', { accountId: 'a' })).toMatchObject({
    status: 'paused',
    pending: 2,
    failed: 0,
    errorCode: 'AUTH_REQUIRED'
  })
  expect(store.call('query', { ...query, source: 'favorites' }).total).toBe(2)
})
it('pauses on the first unexplained empty detail without silently skipping an entire account', async () => {
  const { store } = setup()
  collectFavorites(store)
  store.call('favoriteConfirm', { accountId: 'a', remoteId: 'remote-a', work: work('3') })
  let calls = 0
  const value = service(store, async () => {
    calls++
    return { status_code: 0, aweme_detail: null }
  })
  await value.start('a', ['1', '2', '3'], 'batch', 'favorites')
  await settled(value)
  expect(calls).toBe(1)
  expect(store.call('unlikeTask', { accountId: 'a' })).toMatchObject({
    status: 'paused',
    pending: 3,
    failed: 0,
    errorCode: 'UPSTREAM_RISK_CONTROL'
  })
  expect(store.call('query', { ...query, source: 'favorites' }).total).toBe(3)
})
it('continues through consecutive known unavailable works without treating them as account failures', async () => {
  const { store } = setup()
  collectFavorites(store)
  for (const id of ['3', '4'])
    store.call('favoriteConfirm', { accountId: 'a', remoteId: 'remote-a', work: work(id) })
  const calls: string[] = []
  const value = service(store, async (_account, operation, parameters) => {
    calls.push(`${operation}:${parameters.aweme_id}`)
    return {
      status_code: 0,
      aweme_detail: null,
      filter_detail: { aweme_id: parameters.aweme_id, filter_reason: 'core_dep' }
    }
  })
  await value.start('a', ['1', '2', '3', '4'], 'batch', 'favorites')
  await settled(value)
  expect(calls).toEqual(['detail:1', 'detail:2', 'detail:3', 'detail:4'])
  expect(store.call('unlikeTask', { accountId: 'a' })).toMatchObject({
    status: 'completed',
    failed: 4,
    pending: 0,
    unknown: 0,
    success: 0
  })
  expect(store.call('query', { ...query, source: 'favorites' }).total).toBe(4)
})
it('skips a definite business rejection of uncollect without repeating the POST or removing its local record', async () => {
  const { store } = setup()
  collectFavorites(store)
  const writes: string[] = []
  const value = service(store, async (_account, operation, parameters) => {
    if (operation === 'detail') return favoriteDetail(parameters.aweme_id)
    writes.push(parameters.aweme_id)
    return parseResponse(JSON.stringify({ status_code: parameters.aweme_id === '1' ? 2053 : 0 }), 200, {
      operation,
      workId: parameters.aweme_id
    })
  })
  await value.start('a', ['1', '2'], 'batch', 'favorites')
  await settled(value)
  expect(writes).toEqual(['1', '2'])
  expect(store.call('unlikeTask', { accountId: 'a' })).toMatchObject({
    status: 'completed',
    failed: 1,
    success: 1,
    pending: 0,
    unknown: 0
  })
  expect(store.call('query', { ...query, source: 'favorites' }).items.map((w) => w.id)).toEqual(['1'])
})
it('keeps an uncertain uncollect, prevents conflicting collect writes, and only resumes unsent items', async () => {
  const { store } = setup()
  collectFavorites(store)
  const writes: string[] = []
  const value = service(store, async (_account, operation, parameters) => {
    if (operation === 'detail') return favoriteDetail(parameters.aweme_id)
    writes.push(parameters.aweme_id)
    if (parameters.aweme_id === '1') throw new AppError('TIMEOUT', 'fixture')
    return { status_code: 0 }
  })
  const task = await value.start('a', ['1', '2'], 'batch', 'favorites')
  await settled(value)
  expect(store.call('unlikeTask', { accountId: 'a' })).toMatchObject({
    unknown: 1,
    pending: 1,
    status: 'paused'
  })
  expect(store.call('query', { ...query, source: 'favorites' }).total).toBe(2)
  expect(() => store.call('favoriteWriteGuard', { accountId: 'a', workId: '1' })).toThrow(/重新核验/)
  expect(() =>
    store.call('unlikeCreate', {
      accountId: 'a',
      id: 'conflict',
      mode: 'single',
      source: 'favorites',
      workIds: ['1']
    })
  ).toThrow(/结果未知/)
  await value.resume('a', task.id)
  await settled(value)
  expect(writes).toEqual(['1', '2'])
  expect(store.call('unlikeTask', { accountId: 'a' })).toMatchObject({ success: 1, unknown: 1, pending: 0 })
  // The independent like operation must not inherit the collection's unknown result.
  expect(
    store.call('unlikeCreate', { accountId: 'a', id: 'independent-like', mode: 'single', workIds: ['1'] })
      .source
  ).toBe('likes')
})
it('waits for a sent uncollect when stopped and preserves its success without sending the next item', async () => {
  const { store } = setup()
  collectFavorites(store)
  let writes = 0,
    release!: () => void
  const value = service(store, async (_account, operation, parameters) => {
    if (operation === 'detail') return favoriteDetail(parameters.aweme_id)
    writes++
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return { status_code: 0 }
  })
  await value.start('a', ['1', '2'], 'batch', 'favorites')
  for (let i = 0; i < 100 && !writes; i++) await new Promise((r) => setTimeout(r, 1))
  const stop = value.stop()
  expect(value.running).toBe(true)
  release()
  await stop
  expect(writes).toBe(1)
  expect(store.call('unlikeTask', { accountId: 'a' })).toMatchObject({
    success: 1,
    unknown: 0,
    pending: 1,
    status: 'stopped'
  })
})
it('retains collection source across restart and resolves unknown removal using only detail reads', async () => {
  const { store, file } = setup()
  collectFavorites(store)
  store.call('unlikeCreate', {
    ...scope,
    id: 'task',
    mode: 'batch',
    source: 'favorites',
    workIds: ['1', '2']
  })
  reserve(store)
  store.call('close', undefined)
  const reopened = new Store(file)
  stores.push(reopened)
  expect(reopened.call('unlikeTask', scope)).toMatchObject({
    source: 'favorites',
    status: 'paused',
    unknown: 1,
    pending: 1
  })
  const value = service(reopened, async (_account, operation, parameters) => {
    expect(operation).toBe('detail')
    return favoriteDetail(parameters.aweme_id, false)
  })
  await value.verify('a', 'task', '1')
  expect(reopened.call('unlikeTask', scope)).toMatchObject({ success: 1, unknown: 0 })
  expect(reopened.call('query', { ...query, source: 'favorites' }).total).toBe(1)
  expect(reopened.call('query', query).total).toBe(2)
  expect(reopened.call('favoriteWriteGuard', { accountId: 'a', workId: '1' })).toBeNull()
})
it('migrates a v6 library preserving prior unlike history, with a consistent v6 backup', () => {
  const { store, file, folder } = setup()
  collectFavorites(store)
  create(store)
  store.call('close', undefined)
  const old = new DatabaseSync(file)
  dropFavoriteExtensions(old)
  old.exec('ALTER TABLE unlike_tasks DROP COLUMN source; PRAGMA user_version=6;')
  old.close()
  const reopened = new Store(file)
  stores.push(reopened)
  expect(reopened.call('unlikeTask', scope)).toMatchObject({ source: 'likes', pending: 2, status: 'paused' })
  expect(reopened.call('query', { ...query, source: 'favorites' }).total).toBe(2)
  const backups = readdirSync(join(folder, 'backups'))
  expect(backups).toHaveLength(1)
  expect(backups[0]).toMatch(/^before-v7-/)
  const backup = new DatabaseSync(join(folder, 'backups', backups[0]!))
  expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(6)
  expect(backup.prepare('PRAGMA quick_check').get()?.quick_check).toBe('ok')
  backup.close()
})

it.each(['paused', 'stopped'] as const)(
  'clears stale failure after readonly confirmation without resuming a %s task',
  (status) => {
    const { store } = setup()
    create(store)
    reserve(store)
    finish(store, 'unknown')
    store.call('unlikeUpdate', { ...scope, status, errorCode: 'TIMEOUT', reason: '请求结果未知' })
    const task = store.call('unlikeResolve', { ...scope, workId: '1', liked: false })
    expect(task).toMatchObject({ status, errorCode: null, unknown: 0, pending: 1, success: 1 })
    expect(store.call('query', query).total).toBe(1)
  }
)

it('finishes a checked task with unsuccessful items without retaining its old uncertainty error', () => {
  const { store } = setup()
  store.call('unlikeCreate', { accountId: 'a', id: 'task', mode: 'single', workIds: ['1'] })
  reserve(store)
  finish(store, 'unknown')
  store.call('unlikeUpdate', { ...scope, status: 'completed', errorCode: 'TIMEOUT', reason: '请求结果未知' })
  expect(store.call('unlikeResolve', { ...scope, workId: '1', liked: true })).toMatchObject({
    status: 'completed',
    errorCode: null,
    unknown: 0,
    pending: 0,
    failed: 1,
    success: 0
  })
  expect(store.call('query', query).total).toBe(2)
})

it('rolls back readonly confirmation and local removal if saving the task summary fails', () => {
  const { store, file } = setup()
  create(store)
  reserve(store)
  finish(store, 'unknown')
  store.call('unlikeUpdate', { ...scope, status: 'paused', errorCode: 'TIMEOUT', reason: '请求结果未知' })
  const db = new DatabaseSync(file)
  try {
    db.exec(
      "CREATE TRIGGER fail_resolution_summary BEFORE UPDATE ON unlike_tasks BEGIN SELECT RAISE(ABORT,'fixture summary failure'); END"
    )
    expect(() => store.call('unlikeResolve', { ...scope, workId: '1', liked: false })).toThrow(
      /fixture summary failure/
    )
    expect(store.call('unlikeTask', scope)).toMatchObject({
      unknown: 1,
      errorCode: 'TIMEOUT',
      pending: 1,
      success: 0
    })
    expect(store.call('query', query).total).toBe(2)
  } finally {
    db.close()
  }
})
