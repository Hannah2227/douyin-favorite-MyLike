import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

// Use database workers extracted from real release/test packages, so the old
// application's SQL, validation and account/backup deletion are actually run.
const [legacyWorker, currentWorker, output = 'dist/compatibility-test/roundtrip.json'] = process.argv.slice(2)
if (!legacyWorker || !currentWorker)
  throw Error('Usage: node tests/compatibility/roundtrip.mjs <v2.0.2-worker> <current-worker> [report]')
const root = mkdtempSync(join(tmpdir(), 'mylike-version-compat-')),
  clients = new Set(),
  checks = []
class Client {
  next = 0
  pending = new Map()
  constructor(file, worker) {
    this.worker = new Worker(resolve(worker), { workerData: { file } })
    this.ready = new Promise((resolve, reject) => {
      this.worker.on('message', (message) => {
        if ('ready' in message) {
          message.ready ? resolve() : reject(Error(message.error))
          return
        }
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        message.ok
          ? pending.resolve(message.data)
          : pending.reject(Error(`${message.error.code}: ${message.error.message}`))
      })
      this.worker.on('error', (error) => {
        reject(error)
        for (const item of this.pending.values()) item.reject(error)
        this.pending.clear()
      })
    })
    clients.add(this)
  }
  async call(method, input) {
    await this.ready
    const id = ++this.next
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ id, method, input })
    })
  }
  async close() {
    try {
      await this.call('close')
    } finally {
      await this.worker.terminate()
      clients.delete(this)
    }
  }
}
const work = (id) => ({
  id,
  title: `fixture ${id}`,
  author: 'Fixture',
  publishedAt: 1700000000 + Number(id),
  coverUrl: null,
  mediaType: 'video',
  isLive: false
})
const query = {
  accountId: 'a',
  source: 'favorites',
  search: '',
  mediaType: 'all',
  year: null,
  month: null,
  sort: 'published',
  offset: 0,
  limit: 60
}
async function seed(client) {
  for (const id of ['a', 'b']) {
    await client.call('createAccount', { id, name: id })
    await client.call('bindAccount', {
      accountId: id,
      remoteId: `remote-${id}`,
      nickname: id,
      avatarUrl: null
    })
  }
  await client.call('savePage', {
    accountId: 'a',
    remoteId: 'remote-a',
    items: ['1', '2'].map(work),
    cursor: '0',
    hasMore: false
  })
}
async function save(client, task, ids, more = false, cursor = '0', skipped = false) {
  return client.call('favoritesSave', {
    accountId: 'a',
    remoteId: 'remote-a',
    taskId: task.id,
    stage: task.stage,
    folderId: task.folderId,
    mode: task.mode,
    requestCursor: task.cursor,
    cursor,
    hasMore: more,
    items: ids.map(work),
    ...(skipped ? { skipped: [{ position: 2 }], received: ids.length + 1 } : {})
  })
}
async function folder(client, id, ids) {
  let task = await client.call('favoritesStart', { accountId: 'a', id })
  task = await save(client, task, ids)
  return client.call('favoritesSave', {
    accountId: 'a',
    remoteId: 'remote-a',
    taskId: task.id,
    stage: task.stage,
    folderId: null,
    requestCursor: '0',
    cursor: '0',
    hasMore: false,
    folders: [{ id: '8', title: 'Folder', remoteCount: ids.length }]
  })
}
const control = (client, task, status) =>
  client.call('favoritesUpdate', { accountId: 'a', taskId: task.id, status, reason: null })
const confirm = (client, id) =>
  client.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work: work(id),
    folder: { id: '8', title: 'Folder', remoteCount: 6, localCount: 0 }
  })
async function ids(client) {
  return (await client.call('query', { ...query, folderId: '8' })).items.map((item) => item.id).sort()
}
function versions(file) {
  const backup = join(dirname(file), 'backups'),
    files = [
      file,
      ...readdirSync(backup)
        .filter((name) => name.endsWith('.sqlite'))
        .map((name) => join(backup, name))
    ]
  for (const path of files) {
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7)
      assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok')
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    } finally {
      db.close()
    }
  }
  return files
}
function purged(file) {
  for (const path of versions(file)) {
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM accounts WHERE id=?').get('a').n, 0)
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='saved_updates'").get())
        assert.equal(db.prepare('SELECT count(*) AS n FROM saved_updates WHERE accountId=?').get('a').n, 0)
    } finally {
      db.close()
    }
  }
}
let success = false
try {
  mkdirSync(join(root, 'v7'))
  const file = join(root, 'v7', 'db.sqlite')
  let client = new Client(file, legacyWorker)
  await seed(client)
  let task = await save(client, await folder(client, 'legacy-initial', ['1', '2']), ['1'], true, '5')
  await control(client, task, 'paused')
  const queue = await client.call('queueCreate', {
    accountId: 'a',
    source: { type: 'ids', source: 'favorites', ids: ['1', '2'], sort: 'published' },
    mode: 'sequence'
  })
  await client.call('backup', { reason: 'manual' })
  await client.call('appendRuntimeEvent', {
    accountId: 'a',
    event: {
      kind: 'request',
      operation: 'favorites',
      message: 'Fixture status-only response',
      code: 'UPSTREAM_RISK_CONTROL',
      responseType: 'risk-control',
      rule: 'payload.bare_envelope',
      platformCode: '0'
    }
  })
  await client.close()

  client = new Client(file, currentWorker)
  task = await client.call('favoritesTask', { accountId: 'a' })
  assert.equal(task.cursor, '5')
  task = await control(client, task, 'running')
  await save(client, task, ['2'])
  assert.deepEqual(await ids(client), ['1', '2'])
  let head = await client.call('favoritesStart', { accountId: 'a', id: 'head-a', mode: 'update' })
  head = await save(client, head, ['3'], true, '9')
  await client.call('favoritesUpdate', {
    accountId: 'a',
    taskId: head.id,
    mode: 'update',
    status: 'paused',
    reason: null
  })
  await client.call('favoritesStart', { accountId: 'b', id: 'head-b', mode: 'update' })
  await confirm(client, '4')
  const write = await client.call('unlikeCreate', {
    accountId: 'a',
    id: 'unknown-a',
    mode: 'single',
    source: 'favorites',
    workIds: ['2']
  })
  await client.call('unlikeReserve', { accountId: 'a', taskId: write.id, workId: '2' })
  await client.call('unlikeFinish', {
    accountId: 'a',
    taskId: write.id,
    workId: '2',
    status: 'unknown',
    reason: 'Fixture interrupted write',
    errorCode: 'TIMEOUT'
  })
  await client.call('unlikeUpdate', { accountId: 'a', taskId: write.id, status: 'paused', reason: 'Fixture' })
  await client.call('backup', { reason: 'manual' })
  await client.close()
  checks.push('v2.0.2 → new: committed folder cursor and members preserved')

  client = new Client(file, legacyWorker)
  assert.ok(
    (await client.call('runtimeEvents', { accountId: 'a' })).some(
      (event) => event.code === 'UPSTREAM_RISK_CONTROL'
    )
  )
  assert.equal((await client.call('query', query)).total, 4)
  assert.equal((await client.call('queueState', { accountId: 'a' })).queueId, queue.queueId)
  assert.equal((await client.call('unlikeTask', { accountId: 'a' })).unknown, 1)
  await confirm(client, '5')
  task = await save(
    client,
    await folder(client, 'legacy-second', ['1', '2', '3', '4', '5']),
    ['1', '2'],
    true,
    '7'
  )
  await control(client, task, 'paused')
  await client.call('deleteLocal', { accountId: 'a', workIds: ['1'] })
  await client.call('queueMove', { accountId: 'a', queueId: queue.queueId, target: 'next' })
  await client.call('backup', { reason: 'manual' })
  await client.close()
  client = new Client(file, currentWorker)
  task = await client.call('favoritesTask', { accountId: 'a' })
  assert.equal(task.cursor, '7')
  task = await control(client, task, 'running')
  await save(client, task, ['3', '4', '5'])
  assert.deepEqual(await ids(client), ['1', '2', '3', '4', '5'])
  assert.equal((await client.call('query', { ...query, source: 'likes' })).total, 1)
  assert.equal((await client.call('queueState', { accountId: 'a' })).index, 1)
  assert.equal((await client.call('unlikeTask', { accountId: 'a' })).unknown, 1)
  assert.equal((await client.call('favoritesTask', { accountId: 'a', mode: 'update' })).cursor, '9')
  checks.push(
    'new → v2.0.2 → new: read/write, likes deletion, queue, unknown writes and independent update preserved'
  )

  task = await save(
    client,
    await folder(client, 'new-partial', ['1', '2', '3', '4', '5']),
    ['1'],
    false,
    '0',
    true
  )
  assert.equal(task.status, 'partial')
  await confirm(client, '6')
  await client.call('backup', { reason: 'manual' })
  await client.close()
  client = new Client(file, legacyWorker)
  task = await client.call('favoritesTask', { accountId: 'a' })
  assert.equal(task.status, 'paused')
  assert.equal(task.folderId, '8')
  task = await control(client, task, 'running')
  await save(client, task, ['1', '2', '3'])
  assert.deepEqual(await ids(client), ['1', '2', '3', '4', '5', '6'])
  await client.close()
  client = new Client(file, currentWorker)
  assert.equal((await client.call('favoritesTask', { accountId: 'a' })).status, 'completed')
  assert.deepEqual(await ids(client), ['1', '2', '3', '4', '5', '6'])
  await client.close()
  checks.push('partial/new scan markers remain safe when v2.0.2 resumes the task')
  client = new Client(file, legacyWorker)
  await client.call('removeAccount', { accountId: 'a' })
  assert.deepEqual(
    (await client.call('accounts')).map((a) => a.id),
    ['b']
  )
  await client.close()
  purged(file)
  checks.push('v2.0.2 account deletion cleans new states and every historical backup')

  mkdirSync(dirname(resolve(output)), { recursive: true })
  writeFileSync(
    resolve(output),
    JSON.stringify(
      {
        passed: checks.length,
        checks,
        realLegacyWorker: resolve(legacyWorker)
      },
      null,
      2
    )
  )
  console.log(JSON.stringify({ passed: checks.length, checks }))
  success = true
} finally {
  for (const client of clients)
    try {
      await client.close()
    } catch {
      await client.worker.terminate()
    }
  if (success) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('mylike-version-compat-'))
      throw Error('Unsafe cleanup')
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } else console.log('Controlled compatibility fixture retained at ' + root)
}
