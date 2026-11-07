import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { Store } from '../../src/main/storage/database'
import { sqliteFailure, recoverableYearFailure } from '../../src/main/storage/sqlite-policy'

const roots: string[] = [],
  stores: Store[] = []
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
  for (const store of stores.splice(0)) store.call('close', undefined)
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('mylike-sqlite-policy-'))
      throw Error('Unsafe cleanup')
    rmSync(root, { recursive: true, force: true })
  }
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'mylike-sqlite-policy-'))
  roots.push(root)
  const store = new Store(join(root, 'data.sqlite'))
  stores.push(store)
  for (const id of ['a', 'b']) {
    store.call('createAccount', { id, name: id })
    store.call('bindAccount', { accountId: id, remoteId: 'remote-' + id, nickname: id, avatarUrl: null })
  }
  store.call('savePage', {
    accountId: 'a',
    remoteId: 'remote-a',
    cursor: '55',
    hasMore: true,
    items: [2021, 2024, 2025].map((year) => ({
      id: String(year),
      title: 'year ' + year,
      author: 'author',
      publishedAt: Date.UTC(year, 5, 1) / 1000,
      coverUrl: null,
      mediaType: 'video' as const,
      isLive: false
    }))
  })
  return { store, db: (store as unknown as { db: DatabaseSync }).db }
}
const failure = (errcode: number) =>
  Object.assign(new Error('private C:/secret/path account-cookie=secret'), {
    code: 'ERR_SQLITE_ERROR',
    errcode
  })
it('retains published-year order and account boundaries when year discovery temporarily fails, then recovers', () => {
  const { store, db } = setup()
  expect(store.call('query', query).years).toEqual([2025, 2024, 2021])
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const prepare = db.prepare.bind(db)
  const broken = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    if (sql.startsWith('SELECT DISTINCT')) throw failure(14)
    return prepare(sql)
  })
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = store.call('query', { ...query, year: 2024 })
    expect(result).toMatchObject({ total: 1, years: [2024], yearsUnavailable: true })
    expect(result.items.map((item) => item.id)).toEqual(['2024'])
  }
  const events = store.call('runtimeEvents', { accountId: 'a' })
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({
    code: 'SQLITE_CANTOPEN',
    operation: 'storage',
    responseType: 'sqlite-error'
  })
  expect(events[0]!.shape).toContain('14')
  expect(JSON.stringify(events)).not.toMatch(/secret|private/)
  expect(store.call('runtimeEvents', { accountId: 'b' })).toEqual([])
  expect(store.call('checkpoint', { accountId: 'a' })).toMatchObject({ cursor: '55', hasMore: true })
  broken.mockRestore()
  expect(store.call('query', query)).toMatchObject({ total: 3, years: [2025, 2024, 2021] })
  expect(store.call('query', query).yearsUnavailable).toBeUndefined()
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(7)
  expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal')
})
it('does not hide corrupt data or programming errors as an unavailable year selector', () => {
  const { store, db } = setup()
  const prepare = db.prepare.bind(db)
  for (const error of [failure(11), new Error('unexpected bug')]) {
    const broken = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      if (sql.startsWith('SELECT DISTINCT')) throw error
      return prepare(sql)
    })
    expect(() => store.call('query', query)).toThrow(error)
    broken.mockRestore()
  }
  expect(store.call('query', query).total).toBe(3)
})
it('classifies extended SQLite errors without exposing raw native messages and never classifies unrelated errors', () => {
  expect(sqliteFailure(failure(14 | (1 << 8)))).toMatchObject({
    baseCode: 14,
    sqliteCode: 270,
    code: 'SQLITE_CANTOPEN'
  })
  expect(recoverableYearFailure(failure(10 | (2 << 8)))).toBe(true)
  expect(recoverableYearFailure(failure(11))).toBe(false)
  expect(JSON.stringify(sqliteFailure(failure(14)))).not.toMatch(/private|secret/)
  expect(sqliteFailure(new Error('failed'))).toBeNull()
})
