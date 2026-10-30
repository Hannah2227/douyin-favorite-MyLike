import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../../src/main/storage/database'
import type { FavoritesTask, Work } from '../../src/shared/contracts'

const roots: string[] = [],
  stores: Store[] = []
const work = (id: string): Work => ({
  id,
  title: id,
  author: 'A',
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
  const root = mkdtempSync(join(tmpdir(), 'mylike-compatible-')),
    file = join(root, 'db.sqlite'),
    store = new Store(file)
  roots.push(root)
  stores.push(store)
  for (const id of ['a', 'b']) {
    store.call('createAccount', { id, name: id })
    store.call('bindAccount', { accountId: id, remoteId: `remote-${id}`, nickname: id, avatarUrl: null })
  }
  store.call('savePage', {
    accountId: 'a',
    remoteId: 'remote-a',
    items: [work('1'), work('2')],
    cursor: '0',
    hasMore: false
  })
  return { root, file, store }
}
function save(store: Store, task: FavoritesTask, items: Work[], more = false, cursor = '0', skipped = false) {
  return store.call('favoritesSave', {
    accountId: task.accountId,
    remoteId: 'remote-a',
    taskId: task.id,
    mode: task.mode,
    stage: task.stage,
    folderId: task.folderId,
    requestCursor: task.cursor,
    cursor,
    hasMore: more,
    items,
    ...(skipped ? { skipped: [{ position: 2 }], received: items.length + 1 } : {})
  })
}
function folder(store: Store) {
  let task = store.call('favoritesStart', { accountId: 'a', id: 'sync' })
  task = save(store, task, [work('1'), work('2')])
  return store.call('favoritesSave', {
    accountId: 'a',
    remoteId: 'remote-a',
    taskId: task.id,
    stage: task.stage,
    folderId: null,
    requestCursor: '0',
    cursor: '0',
    hasMore: false,
    folders: [{ id: '8', title: 'Folder', remoteCount: 2 }]
  })
}
function open(file: string) {
  const store = new Store(file)
  stores.push(store)
  return store
}
function inspect<T>(file: string, action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file)
  try {
    return action(db)
  } finally {
    db.close()
  }
}
afterEach(() => {
  for (const store of stores.splice(0))
    try {
      store.call('close', undefined)
    } catch {}
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('mylike-compatible-'))
      throw Error('Unsafe cleanup')
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})

it('keeps the exact v7 core columns and uses only legacy task statuses even for partial completion', () => {
  const { store, file } = setup()
  const task = save(store, folder(store), [work('1')], false, '0', true)
  expect(task.status).toBe('partial')
  inspect(file, (db) => {
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(7)
    expect(
      db
        .prepare('PRAGMA table_info(saved_tasks)')
        .all()
        .map((r) => r.name)
    ).toEqual([
      'accountId',
      'id',
      'stage',
      'folderId',
      'cursor',
      'status',
      'pages',
      'received',
      'added',
      'reason',
      'errorCode',
      'updatedAt'
    ])
    expect(
      db
        .prepare('PRAGMA table_info(saved_jobs)')
        .all()
        .map((r) => r.name)
    ).toEqual(['taskId', 'folderId', 'position', 'cursor', 'completed'])
    expect(db.prepare('SELECT status,stage,folderId,cursor FROM saved_tasks').get()).toEqual({
      status: 'paused',
      stage: 'folder',
      folderId: '8',
      cursor: '0'
    })
    expect(db.prepare('SELECT DISTINCT seenRun FROM saved_members').all()).toEqual([{ seenRun: task.id }])
  })
})
it('reconciles an old writer advancing a folder without deleting members already visited by either version', () => {
  const { store, file } = setup()
  let task = save(store, folder(store), [work('1')], true, '5')
  store.call('close', undefined)
  inspect(file, (db) => {
    db.exec('PRAGMA foreign_keys=ON;BEGIN IMMEDIATE')
    db.prepare('INSERT INTO saved_members VALUES(?,?,?,?)').run('a', '8', '2', task.id)
    db.prepare(
      "UPDATE saved_tasks SET cursor='9',pages=pages+1,updatedAt=updatedAt+1,status='paused' WHERE id=?"
    ).run(task.id)
    db.prepare("UPDATE saved_jobs SET cursor='9' WHERE taskId=?").run(task.id)
    db.exec('COMMIT')
  })
  const current = open(file)
  task = current.call('favoritesUpdate', { accountId: 'a', taskId: task.id, status: 'running', reason: null })
  expect(task.cursor).toBe('9')
  task = save(current, task, [work('3')])
  expect(task.status).toBe('completed')
  expect(
    current
      .call('query', { ...query, folderId: '8' })
      .items.map((w) => w.id)
      .sort()
  ).toEqual(['1', '2', '3'])
})
it('recognizes a legacy manual folder addition while preserving clean-retry pruning', () => {
  const { store, file } = setup()
  let task = save(store, folder(store), [work('1')], false, '0', true)
  store.call('close', undefined)
  inspect(file, (db) => db.prepare('INSERT INTO saved_members VALUES(?,?,?,?)').run('a', '8', '2', task.id))
  const current = open(file)
  task = current.call('favoritesUpdate', { accountId: 'a', taskId: task.id, status: 'running', reason: null })
  task = save(current, task, [work('3')])
  expect(task.status).toBe('completed')
  expect(
    current
      .call('query', { ...query, folderId: '8' })
      .items.map((w) => w.id)
      .sort()
  ).toEqual(['2', '3'])
})
it('allows the legacy deletion order to cascade all new states without touching the other account', () => {
  const { store, file } = setup()
  save(store, folder(store), [work('1')], false, '0', true)
  save(
    store,
    store.call('favoritesStart', { accountId: 'a', id: 'head-a', mode: 'update' }),
    [work('3')],
    true,
    '9'
  )
  store.call('favoritesStart', { accountId: 'b', id: 'head-b', mode: 'update' })
  store.call('close', undefined)
  inspect(file, (db) => {
    db.exec('PRAGMA foreign_keys=ON;BEGIN IMMEDIATE')
    for (const table of [
      'unlike_tasks',
      'saved_tasks',
      'collection_tasks',
      'checkpoints',
      'playback_queues',
      'saved_members',
      'saved_items',
      'saved_folders',
      'account_items'
    ])
      db.prepare(`DELETE FROM ${table} WHERE accountId=?`).run('a')
    db.prepare('DELETE FROM accounts WHERE id=?').run('a')
    db.exec('COMMIT')
    for (const table of ['saved_task_meta', 'saved_job_meta', 'saved_scan_members', 'saved_update_cursors'])
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0)
    expect(db.prepare('SELECT accountId FROM saved_updates').all()).toEqual([{ accountId: 'b' }])
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0)
  })
})
it('reopens v7 data without rewriting or creating historical backups', () => {
  const { store, file, root } = setup()
  save(store, folder(store), [work('1')], false, '0', true)
  store.call('backup', { reason: 'manual' })
  store.call('close', undefined)
  const backups = join(root, 'backups')
  const before = readdirSync(backups).map((name) => ({ name, bytes: readFileSync(join(backups, name)) }))
  expect(before).toHaveLength(1)
  const current = open(file)
  expect(current.call('favoritesTask', { accountId: 'a' })?.status).toBe('partial')
  expect(current.call('query', query).total).toBe(2)
  expect(readdirSync(backups)).toEqual(before.map(({ name }) => name))
  for (const backup of before) expect(readFileSync(join(backups, backup.name))).toEqual(backup.bytes)
})
