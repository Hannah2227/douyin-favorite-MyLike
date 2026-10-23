import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../../src/main/storage/database'
import { UnlikeService } from '../../src/main/unlike'
import { encodeTransfer } from '../../src/main/storage/transfer-format'
import { AppError } from '../../src/main/errors'
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
    { request, show: async () => {} },
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
it('checks imported membership before any write and preserves an unliked imported record', async () => {
  const { store, folder } = setup(),
    input = join(folder, 'import.json')
  writeFileSync(input, encodeTransfer([{ ...work('3'), collectedAt: Date.now() }], 'other'))
  const preview = store.call('prepareImport', { accountId: 'a', file: input })
  store.call('commitImport', { accountId: 'a', token: preview.token })
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
      },
      show: async () => {}
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
