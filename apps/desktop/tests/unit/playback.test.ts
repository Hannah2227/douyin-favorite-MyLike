import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../../src/main/storage/database'
import type { QueueState, Work } from '../../src/shared/contracts'

const directories: string[] = [],
  stores: Store[] = []
const filter = { search: '', mediaType: 'all' as const, year: null, month: null, sort: 'published' as const }
const item = (n: number): Work => ({
  id: String(n),
  title: `作品${n}`,
  author: 'A',
  publishedAt: 1700000000 + n,
  coverUrl: null,
  mediaType: 'video',
  isLive: false
})
function setup(count = 10) {
  const folder = mkdtempSync(join(tmpdir(), 'mylike-queue-test-'))
  directories.push(folder)
  const file = join(folder, 'db.sqlite'),
    store = new Store(file)
  stores.push(store)
  store.call('createAccount', { id: 'a', name: 'A' })
  store.call('bindAccount', { accountId: 'a', remoteId: 'remote-a', nickname: 'A', avatarUrl: null })
  store.call('savePage', {
    accountId: 'a',
    remoteId: 'remote-a',
    items: Array.from({ length: count }, (_, i) => item(i + 1)),
    cursor: '0',
    hasMore: false
  })
  return { store, file, folder }
}
const scope = (queue: QueueState) => ({
  accountId: queue.accountId,
  queueId: queue.queueId,
  revision: queue.revision
})
const create = (store: Store) =>
  store.call('queueCreate', { accountId: 'a', source: { type: 'filter', filter }, mode: 'sequence' })
afterEach(() => {
  for (const store of stores.splice(0))
    try {
      store.call('close', undefined)
    } catch {
      /* explicitly reopened */
    }
  for (const folder of directories.splice(0)) {
    if (dirname(resolve(folder)) !== resolve(tmpdir()) || !basename(folder).startsWith('mylike-queue-test-'))
      throw new Error('Unsafe temporary cleanup')
    rmSync(folder, { recursive: true, force: true })
  }
})
describe('persistent playback queues', () => {
  it('keeps a fixed ordered scope as collection and local deletion change the library', () => {
    const { store } = setup(),
      queue = create(store)
    expect(queue).toMatchObject({ total: 10, index: 0, work: { id: '10' }, next: { id: '9' } })
    store.call('savePage', {
      accountId: 'a',
      remoteId: 'remote-a',
      items: [item(11)],
      cursor: '0',
      hasMore: false
    })
    store.call('deleteLocal', { accountId: 'a', workIds: ['9'] })
    expect(
      store
        .call('queueItems', { accountId: 'a', queueId: queue.queueId, offset: 0, limit: 50 })
        .items.map((row) => row.work.id)
    ).toEqual(['10', '9', '8', '7', '6', '5', '4', '3', '2', '1'])
    expect(store.call('queueMove', { accountId: 'a', queueId: queue.queueId, target: 'next' }).work.id).toBe(
      '9'
    )
    expect(store.call('query', { ...filter, accountId: 'a', offset: 0, limit: 60 }).total).toBe(10)
  })
  it('shuffles the full scope without duplicates and keeps the clicked item first', () => {
    const { store } = setup(100)
    const queue = store.call('queueCreate', {
      accountId: 'a',
      source: { type: 'filter', filter },
      mode: 'shuffle',
      startWorkId: '42'
    })
    const ids = store
      .call('queueItems', { accountId: 'a', queueId: queue.queueId, offset: 0, limit: 100 })
      .items.map((row) => row.work.id)
    expect(queue.work.id).toBe('42')
    expect(ids[0]).toBe('42')
    expect(new Set(ids)).toEqual(new Set(Array.from({ length: 100 }, (_, i) => String(i + 1))))
    expect(queue.total).toBe(100)
  })
  it('orders selected IDs and refuses a foreign or empty scope without replacing the old queue', () => {
    const { store } = setup(),
      previous = create(store)
    store.call('createAccount', { id: 'b', name: 'B' })
    expect(() =>
      store.call('queueCreate', {
        accountId: 'b',
        source: { type: 'ids', ids: ['1'], sort: 'published' },
        mode: 'sequence'
      })
    ).toThrow(/不在当前账号/)
    expect(() =>
      store.call('queueCreate', {
        accountId: 'a',
        source: { type: 'filter', filter: { ...filter, search: 'no such work' } },
        mode: 'sequence'
      })
    ).toThrow(/没有可播放/)
    expect(store.call('queueState', { accountId: 'a' })?.queueId).toBe(previous.queueId)
    const selected = store.call('queueCreate', {
      accountId: 'a',
      source: { type: 'ids', ids: ['2', '8', '2', '4'], sort: 'published' },
      mode: 'sequence'
    })
    expect(selected).toMatchObject({ total: 3, work: { id: '8' } })
    expect(() =>
      store.call('queueProgress', {
        ...scope(previous),
        sequence: 1,
        position: { seconds: 88, slide: 0, musicSeconds: 0 }
      })
    ).toThrow(/队列已变化/)
    expect(store.call('queueState', { accountId: 'b' })).toBeNull()
  })
  it('rejects old positions after a move and does not regress on an out-of-order progress update', () => {
    const { store } = setup(),
      queue = create(store)
    store.call('queueProgress', {
      ...scope(queue),
      sequence: 2,
      position: { seconds: 12.5, slide: 0, musicSeconds: 0 }
    })
    const ignored = store.call('queueProgress', {
      ...scope(queue),
      sequence: 1,
      position: { seconds: 2, slide: 0, musicSeconds: 0 }
    })
    expect(ignored.position.seconds).toBe(12.5)
    const next = store.call('queueMove', { accountId: 'a', queueId: queue.queueId, target: 'next' })
    expect(next).toMatchObject({ index: 1, revision: 1, position: { seconds: 0 } })
    expect(() =>
      store.call('queueProgress', {
        ...scope(queue),
        sequence: 3,
        position: { seconds: 99, slide: 0, musicSeconds: 0 }
      })
    ).toThrow(/队列已变化/)
    expect(() =>
      store.call('queueEnd', {
        ...scope(queue),
        position: { seconds: 100, slide: 0, musicSeconds: 0 },
        advance: true
      })
    ).toThrow(/队列已变化/)
  })
  it('advances once on natural completion and marks the last item finished so it is not resumable', () => {
    const { store } = setup(2),
      queue = create(store),
      position = { seconds: 11, slide: 0, musicSeconds: 0 }
    const next = store.call('queueEnd', { ...scope(queue), position, advance: true })
    expect(next).toMatchObject({ index: 1, completed: false, work: { id: '1' } })
    expect(() => store.call('queueEnd', { ...scope(queue), position, advance: true })).toThrow(/队列已变化/)
    const end = store.call('queueEnd', { ...scope(next), position, advance: true })
    expect(end.completed).toBe(true)
    expect(() => store.call('queueResume', { accountId: 'a', queueId: end.queueId })).toThrow(/播放完毕/)
    expect(store.call('queueReplay', scope(end))).toMatchObject({
      completed: false,
      index: 1,
      position: { seconds: 0 }
    })
  })
  it('persists queue, gallery position and global preferences across reopening; resuming invalidates old events', () => {
    const { store, file } = setup(),
      queue = create(store)
    store.call('queueProgress', {
      ...scope(queue),
      sequence: 1,
      position: { seconds: 3, slide: 2, musicSeconds: 8 }
    })
    const prefs = store.call('playbackPreferences', {})
    store.call('playbackPreferences', {
      preferences: { ...prefs, volume: 0.3, speed: 1.5, continuous: false }
    })
    store.call('close', undefined)
    const reopened = new Store(file)
    stores.push(reopened)
    expect(reopened.call('queueState', { accountId: 'a' })).toMatchObject({
      queueId: queue.queueId,
      position: { seconds: 3, slide: 2, musicSeconds: 8 }
    })
    expect(reopened.call('playbackPreferences', {})).toMatchObject({
      volume: 0.3,
      speed: 1.5,
      continuous: false
    })
    expect(reopened.call('queueResume', { accountId: 'a', queueId: queue.queueId }).revision).toBe(
      queue.revision + 1
    )
    expect(() =>
      reopened.call('queueProgress', {
        ...scope(queue),
        sequence: 99,
        position: { seconds: 100, slide: 0, musicSeconds: 0 }
      })
    ).toThrow(/队列已变化/)
  })
  it('backs up a real v3 schema before adding queues without losing library records', () => {
    const { store, file, folder } = setup()
    store.call('close', undefined)
    const old = new DatabaseSync(file)
    old.exec(
      'DROP TABLE saved_cursors; DROP TABLE saved_jobs; DROP TABLE saved_tasks; DROP TABLE saved_members; DROP TABLE saved_folders; DROP TABLE saved_items; DROP TABLE unlike_items; DROP TABLE unlike_tasks; DROP TABLE playback_items; DROP TABLE playback_queues; ALTER TABLE accounts DROP COLUMN lastVerifiedAt; ALTER TABLE account_items DROP COLUMN platformSeen; PRAGMA user_version=3;'
    )
    old.close()
    const upgraded = new Store(file)
    stores.push(upgraded)
    expect(upgraded.call('query', { ...filter, accountId: 'a', offset: 0, limit: 60 }).total).toBe(10)
    expect(upgraded.call('queueState', { accountId: 'a' })).toBeNull()
    const backups = readdirSync(join(folder, 'backups'))
    expect(backups).toHaveLength(1)
    const backup = new DatabaseSync(join(folder, 'backups', backups[0]!))
    expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(3)
    backup.close()
  })
})
