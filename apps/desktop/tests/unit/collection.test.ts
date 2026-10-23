import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../../src/main/storage/database'
import { CollectionService } from '../../src/main/collection'
import { RequestLane } from '../../src/main/request-lane'
import { AppError } from '../../src/main/errors'
import type { CollectionTask, Work } from '../../src/shared/contracts'
import type { Database } from '../../src/main/storage/client'

const folders: string[] = [],
  stores: Store[] = [],
  services: CollectionService[] = []
const work = (id: string): Work => ({
  id,
  title: id,
  author: 'A',
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
  const folder = mkdtempSync(join(tmpdir(), 'mylike-collection-'))
  folders.push(folder)
  const file = join(folder, 'db.sqlite'),
    store = new Store(file)
  stores.push(store)
  store.call('createAccount', { id: 'a', name: 'A' })
  store.call('bindAccount', { accountId: 'a', remoteId: 'remote-a', nickname: 'A', avatarUrl: null })
  return { folder, file, store }
}
function save(store: Store, items: Work[], cursor: string, hasMore = true) {
  return store.call('savePage', { accountId: 'a', remoteId: 'remote-a', items, cursor, hasMore })
}
function start(store: Store, mode: CollectionTask['mode'] = 'full') {
  return store.call('startCollection', { accountId: 'a', id: 'task', mode })
}
function page(store: Store, requestCursor: string, cursor: string, items: Work[], hasMore = true) {
  return store.call('saveCollectionPage', {
    accountId: 'a',
    taskId: 'task',
    remoteId: 'remote-a',
    requestCursor,
    cursor,
    items,
    hasMore
  })
}
afterEach(async () => {
  for (const service of services.splice(0)) await service.pause()
  for (const store of stores.splice(0)) {
    try {
      store.call('close', undefined)
    } catch {
      /* explicitly reopened in test */
    }
  }
  for (const folder of folders.splice(0)) {
    if (dirname(resolve(folder)) !== resolve(tmpdir()) || !basename(folder).startsWith('mylike-collection-'))
      throw new Error('Unsafe test cleanup')
    rmSync(folder, { recursive: true, force: true })
  }
})

describe('durable collection tasks', () => {
  it('checks the head without overwriting a deep checkpoint, then finishes the backfill', () => {
    const { store } = setup()
    save(store, [work('1')], '9007199254740993000')
    start(store, 'update')
    expect(page(store, '0', '10', [work('2')])).toMatchObject({
      phase: 'head',
      pages: 1,
      added: 1,
      cursor: '10'
    })
    expect(store.call('checkpoint', { accountId: 'a' })?.cursor).toBe('9007199254740993000')
    expect(page(store, '10', '20', [work('1')])).toMatchObject({
      phase: 'backfill',
      cursor: '9007199254740993000',
      pages: 2
    })
    expect(page(store, '9007199254740993000', '0', [work('3')], false)).toMatchObject({
      status: 'completed',
      pages: 3,
      added: 2,
      received: 3
    })
    expect(store.call('query', query).total).toBe(3)
    expect(store.call('checkpoint', { accountId: 'a' })).toEqual({ cursor: '0', hasMore: false })
  })
  it('keeps a completed checkpoint during a head-only update and starts an uncollected account in backfill', () => {
    const { store } = setup()
    expect(start(store, 'update').phase).toBe('backfill')
    page(store, '0', '0', [work('1')], false)
    start(store, 'update')
    expect(page(store, '0', '10', [work('1')])).toMatchObject({ status: 'completed', phase: 'head' })
    expect(store.call('checkpoint', { accountId: 'a' })?.hasMore).toBe(false)
  })
  it('rolls back task progress, cursor and rows together; rejects stale or paused page commits', () => {
    const { store } = setup()
    start(store)
    page(store, '0', '10', [work('1')])
    expect(() =>
      page(store, '10', '20', [work('2'), { ...work('3'), title: undefined as unknown as string }])
    ).toThrow()
    expect(store.call('collection', { accountId: 'a' })).toMatchObject({ pages: 1, cursor: '10', added: 1 })
    expect(store.call('query', query).total).toBe(1)
    expect(store.call('checkpoint', { accountId: 'a' })?.cursor).toBe('10')
    expect(() => page(store, '0', '20', [work('2')])).toThrow(/断点已变化/)
    store.call('updateCollection', { accountId: 'a', taskId: 'task', status: 'paused', reason: 'pause' })
    expect(() => page(store, '10', '20', [work('2')])).toThrow(/暂停/)
    expect(() =>
      store.call('updateCollection', { accountId: 'other', taskId: 'task', status: 'running', reason: null })
    ).toThrow(/任务已变化/)
  })
  it('detects cursor cycles across restart and recovers an interrupted task as paused', () => {
    const { store, file } = setup()
    start(store)
    page(store, '0', '10', [work('1')])
    page(store, '10', '20', [work('2')])
    store.call('close', undefined)
    const reopened = new Store(file)
    stores.push(reopened)
    expect(reopened.call('collection', { accountId: 'a' })).toMatchObject({
      status: 'paused',
      errorCode: 'INTERRUPTED',
      pages: 2,
      cursor: '20'
    })
    reopened.call('updateCollection', { accountId: 'a', taskId: 'task', status: 'running', reason: null })
    expect(() => page(reopened, '20', '10', [work('3')])).toThrow(/重复游标/)
    expect(() => page(reopened, '20', '30', [])).toThrow(/异常空页/)
    expect(reopened.call('query', query).total).toBe(2)
  })
  it('backs up the v1 database including WAL before upgrading, preserving account data', () => {
    const { store, file, folder } = setup()
    save(store, [work('1')], '111')
    store.call('close', undefined)
    const old = new DatabaseSync(file)
    old.exec(
      'DROP TABLE saved_cursors; DROP TABLE saved_jobs; DROP TABLE saved_tasks; DROP TABLE saved_members; DROP TABLE saved_folders; DROP TABLE saved_items; DROP TABLE unlike_items; DROP TABLE unlike_tasks; DROP TABLE playback_items; DROP TABLE playback_queues; DROP TABLE collection_cursors; DROP TABLE collection_tasks; DROP INDEX account_items_work; DROP INDEX account_items_collected; ALTER TABLE accounts DROP COLUMN lastVerifiedAt; ALTER TABLE account_items DROP COLUMN platformSeen; PRAGMA user_version=1;'
    )
    old.prepare('UPDATE checkpoints SET cursor=?').run('9007199254740993000')
    const upgraded = new Store(file)
    stores.push(upgraded)
    expect(upgraded.call('query', query).total).toBe(1)
    const backups = readdirSync(join(folder, 'backups'))
    expect(backups).toHaveLength(1)
    const backup = new DatabaseSync(join(folder, 'backups', backups[0]!))
    expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(1)
    expect(backup.prepare('SELECT cursor FROM checkpoints').get()?.cursor).toBe('9007199254740993000')
    backup.close()
    old.close()
  })
})

describe('request scheduling and task control', () => {
  it('runs interactive requests before queued pages without overlapping requests', async () => {
    const lane = new RequestLane(),
      order: string[] = []
    let release!: () => void
    const first = lane.run(true, async () => {
      order.push('page1')
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })
    const next = lane.run(true, async () => {
      order.push('page2')
    })
    const media = lane.run(false, async () => {
      order.push('media')
    })
    release()
    await Promise.all([first, next, media, lane.idle()])
    expect(order).toEqual(['page1', 'media', 'page2'])
    expect(lane.pending).toBe(false)
  })
  function serviceFixture(response: (cursor: string) => Promise<Record<string, unknown>>, overrides = {}) {
    const { store } = setup(),
      cursors: string[] = [],
      lane = new RequestLane()
    let releases = 0,
      cancelled = 0,
      abort: ((error: Error) => void) | null = null
    const engine = {
      request: async (_id: string, _operation: unknown, parameters?: Record<string, string>) => {
        cursors.push(parameters!.max_cursor!)
        const stopped = new Promise<never>((_resolve, reject) => {
          abort = reject
        })
        try {
          return await Promise.race([response(parameters!.max_cursor!), stopped])
        } finally {
          abort = null
        }
      },
      cancel: () => {
        cancelled++
        abort?.(new AppError('CANCELLED', 'cancelled'))
      },
      release: () => {
        releases++
      },
      snapshot: () => ({ status: 'ready' as const, accountId: 'a' }),
      show: async () => {}
    }
    const db = { call: async (method: any, input: any) => store.call(method, input) } as Pick<
      Database,
      'call'
    >
    const service = new CollectionService(
      db,
      engine,
      (_id, operation, background) => lane.run(!!background, () => operation(() => {})),
      async () => store.call('accounts', undefined)[0]!,
      () => {},
      { interval: 1, retry: 1, pagesPerSegment: 2, segmentMs: 60000, cooldown: 1, ...overrides }
    )
    services.push(service)
    return { service, store, cursors, releases: () => releases, cancelled: () => cancelled }
  }
  it('recycles between committed pages and automatically continues to the actual end', async () => {
    const { service, store, cursors, releases } = serviceFixture(async (cursor) => ({
      aweme_list: [{ aweme_id: String(Number(cursor) + 1), desc: 'x' }],
      max_cursor: String(Number(cursor) + 1),
      has_more: Number(cursor) < 2
    }))
    await service.start('a', 'full')
    await expect.poll(() => store.call('collection', { accountId: 'a' })?.status).toBe('completed')
    expect(cursors).toEqual(['0', '1', '2'])
    expect(releases()).toBe(1)
    expect(store.call('query', query).total).toBe(3)
  })
  it('continues an unfinished head scan instead of replacing it with another head scan', async () => {
    const { service, store, cursors } = serviceFixture(async () => ({
      aweme_list: [{ aweme_id: '1' }],
      max_cursor: '20',
      has_more: 1
    }))
    save(store, [work('1')], '0', false)
    start(store, 'update')
    page(store, '0', '10', [work('2')])
    store.call('updateCollection', { accountId: 'a', taskId: 'task', status: 'paused', reason: 'pause' })
    expect(() => start(store, 'update')).toThrow(/未完成任务/)
    expect((await service.start('a', 'update')).id).toBe('task')
    await expect.poll(() => store.call('collection', { accountId: 'a' })?.status).toBe('completed')
    expect(cursors).toEqual(['10'])
    expect(store.call('checkpoint', { accountId: 'a' })?.hasMore).toBe(false)
  })
  it('pauses late responses without committing, can resume, and does not restart a stopped task', async () => {
    let reply!: (value: Record<string, unknown>) => void
    const { service, store, cancelled } = serviceFixture(
      async () =>
        new Promise((resolve) => {
          reply = resolve
        })
    )
    const task = await service.start('a', 'full')
    await expect.poll(() => !!reply).toBe(true)
    const paused = service.control('a', task.id, 'pause')
    reply({ aweme_list: [{ aweme_id: '1' }], max_cursor: '1', has_more: 1 })
    await paused
    expect(cancelled()).toBe(1)
    expect(store.call('query', query).total).toBe(0)
    expect(store.call('collection', { accountId: 'a' })).toMatchObject({
      status: 'paused',
      pages: 0,
      cursor: '0'
    })
    reply = undefined as any
    await service.control('a', task.id, 'resume')
    await expect.poll(() => !!reply).toBe(true)
    reply({ aweme_list: [{ aweme_id: '1' }], max_cursor: '0', has_more: 0 })
    await expect.poll(() => store.call('collection', { accountId: 'a' })?.status).toBe('completed')
    const next = await service.start('a', 'full')
    await service.control('a', next.id, 'stop')
    expect(store.call('collection', { accountId: 'a' })?.status).toBe('stopped')
    expect(service.running).toBe(false)
  })
  it('bounds retries and leaves rate limiting and malformed pages paused at the old cursor', async () => {
    let calls = 0
    const { service, store } = serviceFixture(async () => {
      calls++
      throw new AppError('NETWORK_ERROR', 'network')
    })
    await service.start('a', 'full')
    await expect.poll(() => store.call('collection', { accountId: 'a' })?.status).toBe('paused')
    expect(calls).toBe(3)
    expect(store.call('collection', { accountId: 'a' })).toMatchObject({
      pages: 0,
      cursor: '0',
      errorCode: 'NETWORK_ERROR'
    })
    const limited = serviceFixture(async () => {
      throw new AppError('RATE_LIMITED', 'limited')
    })
    await limited.service.start('a', 'full')
    await expect.poll(() => limited.store.call('collection', { accountId: 'a' })?.status).toBe('paused')
    expect(limited.cursors).toEqual(['0'])
  })
  it('rebuilds a repeatedly unready page once without losing the committed cursor or looping indefinitely', async () => {
    const { service, store, releases, cursors } = serviceFixture(async () => ({
      aweme_list: [],
      has_more: 1,
      max_cursor: '9'
    }))
    await service.start('a', 'full')
    await expect.poll(() => store.call('collection', { accountId: 'a' })?.status).toBe('paused')
    expect(cursors).toEqual(['0', '0', '0'])
    expect(releases()).toBe(1)
    expect(store.call('collection', { accountId: 'a' })).toMatchObject({
      pages: 0,
      cursor: '0',
      errorCode: 'INVALID_RESPONSE'
    })
    expect(store.call('query', query).total).toBe(0)
  })
})
