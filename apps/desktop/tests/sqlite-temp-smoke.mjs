import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const script = fileURLToPath(import.meta.url)
const args = process.argv.slice(2)
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)

async function probe(file, workerFile, rows) {
  const worker = new Worker(workerFile, { workerData: { file } })
  const pending = new Map()
  let sequence = 0,
    readyResolve,
    readyReject
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  worker.on('message', (message) => {
    if ('ready' in message) {
      message.ready ? readyResolve() : readyReject(Error(message.error))
      return
    }
    const next = pending.get(message.id)
    if (!next) return
    pending.delete(message.id)
    message.ok ? next.resolve(message.data) : next.reject(Error(message.error.message))
  })
  const failed = (error) => {
    readyReject(error)
    for (const next of pending.values()) next.reject(error)
    pending.clear()
  }
  worker.on('error', failed)
  worker.on('exit', (code) => {
    if (pending.size) failed(Error('Worker exited: ' + code))
  })
  const call = (method, input) =>
    new Promise((resolve, reject) => {
      const id = ++sequence
      pending.set(id, { resolve, reject })
      worker.postMessage({ id, method, input })
    })
  let peakRss = process.memoryUsage().rss
  const sample = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
  }, 25)
  try {
    await ready
    for (const id of ['a', 'b']) {
      await call('createAccount', { id, name: id })
      await call('bindAccount', { accountId: id, remoteId: 'synthetic-' + id, nickname: id, avatarUrl: null })
    }
    for (let start = 0; start < rows; start += 2000) {
      const items = Array.from({ length: Math.min(2000, rows - start) }, (_, offset) => {
        const i = start + offset
        return {
          id: String(7381234567890000000n + BigInt(i)),
          title: (i % 1000 === 0 ? 'marker ' : '') + 'synthetic ' + i,
          author: 'synthetic author',
          publishedAt: Date.UTC(2020 + (i % 6), 5, 1) / 1000 + i,
          coverUrl: null,
          mediaType: i % 2 ? 'video' : 'gallery',
          isLive: i % 10 === 0
        }
      })
      await call('savePage', {
        accountId: 'a',
        remoteId: 'synthetic-a',
        items,
        cursor: 'checkpoint-' + start,
        hasMore: true
      })
    }
    // Populate overlapping favorites and another account without calling any platform.
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(file)
    try {
      // Fixture setup is separate from the production worker under test.
      db.exec('PRAGMA temp_store=MEMORY')
      db.exec(
        "PRAGMA foreign_keys=ON; BEGIN; INSERT INTO saved_items SELECT accountId,workId,firstSeen FROM account_items WHERE CAST(substr(workId,-1) AS INTEGER)%2=0; INSERT INTO account_items SELECT 'b',workId,firstSeen,platformSeen FROM account_items WHERE accountId='a' AND CAST(substr(workId,-3) AS INTEGER)=0; INSERT INTO saved_folders VALUES('a','folder','Synthetic folder',0,'test'); INSERT INTO saved_members SELECT accountId,'folder',workId,'test' FROM saved_items WHERE accountId='a'; COMMIT;"
      )
    } finally {
      db.close()
    }
    const filter = {
      accountId: 'a',
      search: '',
      mediaType: 'all',
      year: null,
      month: null,
      sort: 'published',
      source: 'likes'
    }
    const results = {}
    for (const [name, input] of [
      ['likes-first', {}],
      ['likes-deep', { offset: rows - 60 }],
      ['likes-search', { search: 'marker' }],
      ['likes-year', { year: 2024 }],
      ['favorites', { source: 'favorites' }],
      ['folder', { source: 'favorites', folderId: 'folder' }],
      ['all', { source: 'all' }],
      ['other-account', { accountId: 'b', source: 'all' }]
    ]) {
      const page = await call('query', { ...filter, offset: 0, limit: 60, ...input })
      assert.equal(page.yearsUnavailable, undefined, name + ' must read its years too')
      assert(page.items.length <= 60)
      results[name] = page
    }
    assert.equal(results['likes-first'].total, rows)
    assert.equal(results.all.total, rows)
    assert.equal(results.favorites.total, rows / 2)
    assert.equal(results.folder.total, rows / 2)
    assert.equal(results['other-account'].total, Math.ceil(rows / 1000))
    assert.equal(new Set(results['likes-deep'].items.map((item) => item.id)).size, 60)
    assert.deepEqual(results['likes-first'].years, [2025, 2024, 2023, 2022, 2021, 2020])
    results.overview = await call('libraryOverview', { accountId: 'a' })
    assert.equal(results.overview.total, rows)
    assert.equal(results.overview.overlap, rows / 2)
    results.selection = await call('matchingIds', filter)
    assert.equal(results.selection.length, 1000)
    const queue = await call('queueCreate', {
      accountId: 'a',
      source: { type: 'filter', filter: { ...filter, source: 'all' } },
      mode: 'sequence'
    })
    assert.equal(queue.total, rows)
    results.queue = { total: queue.total, first: queue.work.id }
    assert.deepEqual(await call('runtimeEvents', { accountId: 'a' }), [])
    await call('close', undefined)
    const check = new DatabaseSync(file, { readOnly: true })
    try {
      check.exec('PRAGMA temp_store=MEMORY')
      assert.equal(check.prepare('PRAGMA user_version').get().user_version, 7)
      assert.equal(check.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
      assert.equal(check.prepare('PRAGMA quick_check').get().quick_check, 'ok')
    } finally {
      check.close()
    }
    return { results, peakRssMB: Math.round(peakRss / 1048576) }
  } finally {
    clearInterval(sample)
    await worker.terminate()
  }
}

if (args[0] === '--child') {
  const result = await probe(args[1], args[2], Number(args[3]))
  console.log(JSON.stringify(result))
} else {
  const worker = resolve(option('--worker', 'out/main/database-worker.cjs'))
  const rows = Number(option('--rows', '100000'))
  assert(Number.isSafeInteger(rows) && rows >= 1000 && rows <= 100000 && rows % 2 === 0)
  const root = mkdtempSync(join(tmpdir(), 'mylike-sqlite-smoke-'))
  try {
    const good = join(root, 'working-temp')
    mkdirSync(good)
    const runs = []
    for (const [name, temp] of [
      ['normal', good],
      ['missing-temp', join(root, 'missing-temp')]
    ]) {
      const run = spawnSync(
        require('electron'),
        [script, '--child', join(root, name + '.sqlite'), worker, String(rows)],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TEMP: temp, TMP: temp },
          encoding: 'utf8',
          windowsHide: true,
          timeout: 120000,
          maxBuffer: 4 * 1024 * 1024
        }
      )
      if (run.status !== 0) throw Error(name + ' failed: ' + (run.stderr || run.stdout || run.error?.message))
      runs.push(JSON.parse(run.stdout.trim()))
    }
    assert.deepEqual(
      runs[1].results,
      runs[0].results,
      'Missing system temp directory must not change query or queue results'
    )
    console.log(
      JSON.stringify({
        passed: true,
        rows,
        worker,
        checks: Object.keys(runs[0].results),
        peakRssMB: runs.map((run) => run.peakRssMB)
      })
    )
  } finally {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('mylike-sqlite-smoke-'))
      throw Error('Unsafe cleanup')
    rmSync(root, { recursive: true, force: true })
  }
}
