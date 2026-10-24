import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../../src/main/storage/database'
import { responseSummary } from '../../src/main/douyin/response-summary'
import { EndConfirmation, readRetryDelay } from '../../src/main/read-recovery'

const roots: string[] = [],
  stores: Store[] = []
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'mylike-runtime-')),
    file = join(root, 'db.sqlite'),
    store = new Store(file)
  roots.push(root)
  stores.push(store)
  for (const id of ['a', 'b']) store.call('createAccount', { id, name: id })
  return { store, root, file }
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) {
    try {
      store.call('close', undefined)
    } catch {
      /* reopened */
    }
  }
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('mylike-runtime-'))
      throw Error('Unsafe test cleanup')
    rmSync(root, { recursive: true, force: true })
  }
})

it('drops routine reads and controls, hides old noise, and retains only committed ends and exceptions', () => {
  const { store, file } = setup()
  const normal = [
    { kind: 'auth' as const, message: '开始登录检测。' },
    { kind: 'request' as const, operation: 'self', responseType: 'identity', message: '接口已返回' },
    { kind: 'request' as const, operation: 'likes', responseType: 'list', message: '接口已返回' },
    { kind: 'request' as const, operation: 'likes', responseType: 'terminal-list', message: '待确认末页' },
    { kind: 'task' as const, message: '喜欢采集已开始' },
    { kind: 'task' as const, message: '喜欢采集本轮正常完成：本页均已收录，本轮新增检查结束。' },
    { kind: 'auth' as const, code: 'CANCELLED', message: '用户关窗' }
  ]
  for (const event of normal) store.call('appendRuntimeEvent', { accountId: 'a', event })
  store.call('startCollection', { accountId: 'a', id: 'task', mode: 'update' })
  store.call('updateCollection', { accountId: 'a', taskId: 'task', status: 'paused', reason: '手动暂停' })
  expect(store.call('runtimeEvents', { accountId: 'a' })).toEqual([])
  const db = new DatabaseSync(file)
  expect(db.prepare('SELECT value FROM settings WHERE key=?').get('runtime:a')).toBeUndefined()
  db.prepare('INSERT INTO settings VALUES(?,?)').run(
    'runtime:a',
    JSON.stringify([
      ...normal.map((event) => ({ ...event, id: randomUUID(), time: Date.now() })),
      {
        kind: 'task',
        message: '喜欢采集本轮正常完成：平台已返回列表末尾。',
        id: randomUUID(),
        time: Date.now()
      }
    ])
  )
  db.close()
  expect(store.call('runtimeEvents', { accountId: 'a' })).toEqual([
    expect.objectContaining({ message: expect.stringContaining('平台已返回列表末尾') })
  ])
})

it('suppresses identical exceptions for thirty seconds while keeping distinct errors and each confirmed end', () => {
  const { store } = setup()
  const event = { kind: 'request' as const, message: '读取超时', code: 'TIMEOUT', operation: 'self' }
  for (let n = 0; n < 20; n++) store.call('appendRuntimeEvent', { accountId: 'a', event })
  const first = store.call('runtimeEvents', { accountId: 'a' })
  expect(first).toHaveLength(1)
  vi.spyOn(Date, 'now').mockReturnValue(first[0]!.time + 30_001)
  store.call('appendRuntimeEvent', { accountId: 'a', event })
  store.call('appendRuntimeEvent', { accountId: 'a', event: { ...event, code: 'NETWORK_ERROR' } })
  for (let n = 0; n < 2; n++)
    store.call('appendRuntimeEvent', {
      accountId: 'a',
      event: { kind: 'task', code: 'END_CONFIRMED', message: '收藏夹作品已确认触底。' }
    })
  expect(store.call('runtimeEvents', { accountId: 'a' })).toHaveLength(5)
})

it('records task outcomes durably and scopes them to the owning account', () => {
  const { store, file } = setup()
  store.call('startCollection', { accountId: 'a', id: 'task', mode: 'update' })
  store.call('updateCollection', {
    accountId: 'a',
    taskId: 'task',
    status: 'paused',
    reason: '网络超时，保留断点。',
    errorCode: 'TIMEOUT'
  })
  expect(store.call('runtimeEvents', { accountId: 'a' })).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'task', code: 'TIMEOUT', message: expect.stringContaining('网络超时') })
    ])
  )
  expect(store.call('runtimeEvents', { accountId: 'b' })).toEqual([])
  store.call('close', undefined)
  const reopened = new Store(file)
  stores.push(reopened)
  expect(reopened.call('runtimeEvents', { accountId: 'a' })).toHaveLength(1)
  reopened.call('updateCollection', { accountId: 'a', taskId: 'task', status: 'running', reason: null })
  reopened.call('bindAccount', { accountId: 'a', remoteId: 'remote-a', nickname: 'A', avatarUrl: null })
  reopened.call('saveCollectionPage', {
    accountId: 'a',
    taskId: 'task',
    remoteId: 'remote-a',
    requestCursor: '0',
    cursor: '0',
    items: [],
    hasMore: false
  })
  expect(reopened.call('runtimeEvents', { accountId: 'a' }).at(-1)).toMatchObject({
    code: 'END_CONFIRMED',
    message: expect.stringContaining('确认触底')
  })
})

it('keeps task events when the bounded request history fills and purges all copies on account deletion', () => {
  const { store, root, file } = setup()
  store.call('appendRuntimeEvent', {
    accountId: 'a',
    event: { kind: 'task', message: '早期中断原因', code: 'EMPTY_PAGE' }
  })
  store.call('appendRuntimeEvent', {
    accountId: 'b',
    event: { kind: 'auth', message: '其他账号异常', code: 'TIMEOUT' }
  })
  for (let n = 0; n < 170; n++)
    store.call('appendRuntimeEvent', {
      accountId: 'a',
      event: {
        kind: 'request',
        message: `异常响应 ${n}`,
        operation: 'likes',
        responseType: 'http-error',
        code: 'RATE_LIMITED',
        status: 429,
        count: 18,
        durationMs: 10
      }
    })
  const events = store.call('runtimeEvents', { accountId: 'a' })
  expect(events.filter((e) => e.kind === 'request')).toHaveLength(150)
  expect(events.some((e) => e.message === '早期中断原因')).toBe(true)
  store.call('bindAccount', { accountId: 'a', remoteId: 'remote-a', nickname: 'A', avatarUrl: null })
  store.call('startCollection', { accountId: 'a', id: 'terminal', mode: 'update' })
  store.call('saveCollectionPage', {
    accountId: 'a',
    taskId: 'terminal',
    remoteId: 'remote-a',
    requestCursor: '0',
    cursor: '0',
    items: [],
    hasMore: false
  })
  store.call('backup', { reason: 'manual' })
  store.call('removeAccount', { accountId: 'a' })
  expect(() =>
    store.call('appendRuntimeEvent', { accountId: 'a', event: { kind: 'task', message: '迟到事件' } })
  ).toThrow(/不存在/)
  for (const path of [
    file,
    ...readdirSync(join(root, 'backups')).map((name) => join(root, 'backups', name))
  ]) {
    const db = new DatabaseSync(path, { readOnly: true })
    expect(db.prepare('SELECT value FROM settings WHERE key=?').get('runtime:a')).toBeUndefined()
    expect(db.prepare('SELECT value FROM settings WHERE key=?').get('collectionTail:a')).toBeUndefined()
    expect(db.prepare('SELECT value FROM settings WHERE key=?').get('runtime:b')).toBeDefined()
    db.close()
  }
})

it('records crash recovery and reports damaged event storage instead of inventing empty history', () => {
  const { store, file } = setup()
  store.call('startCollection', { accountId: 'a', id: 'task', mode: 'update' })
  store.call('close', undefined)
  const reopened = new Store(file)
  stores.push(reopened)
  expect(reopened.call('runtimeEvents', { accountId: 'a' }).at(-1)).toMatchObject({ code: 'INTERRUPTED' })
  const db = new DatabaseSync(file)
  db.prepare('UPDATE settings SET value=? WHERE key=?').run('broken', 'runtime:a')
  db.close()
  expect(() => reopened.call('runtimeEvents', { accountId: 'a' })).toThrow(/读取失败/)
})

it('classifies responses without retaining credentials, identifiers or platform text', () => {
  const cases = [
    ['', 200, 'empty-body'],
    ['{}', 200, 'empty-body'],
    ['broken', 200, 'invalid-json'],
    ['<html>secret-token</html>', 200, 'html'],
    ['{}', 429, 'http-error'],
    ['{"status_code":7,"status_msg":"secret-token"}', 200, 'api-error'],
    ['{"aweme_list":[],"has_more":1}', 200, 'empty-list'],
    ['{"aweme_list":[],"has_more":0}', 200, 'terminal-list'],
    ['{"aweme_list":[{"aweme_id":7381234567890123456,"desc":"secret-token"}],"has_more":1}', 200, 'list']
  ] as const
  for (const [body, status, type] of cases) {
    const result = responseSummary(body, status)
    expect(result.responseType).toBe(type)
    expect(JSON.stringify(result)).not.toMatch(/secret-token|7381234567890123456/)
  }
})

it('confirms matching terminal pages, resets on new data, and bounds inconsistent end markers', () => {
  const end = new EndConfirmation()
  expect(end.check('a:1', [], false)).toBe(false)
  expect(end.check('a:1', ['1'], true)).toBe(true)
  expect(end.check('a:2', ['2'], false)).toBe(false)
  expect(end.check('a:2', ['2'], false)).toBe(true)
  end.reset()
  expect(end.check('b:1', ['1'], false)).toBe(false)
  expect(end.check('b:1', ['2'], false)).toBe(false)
  expect(() => end.check('b:1', ['3'], false)).toThrow(/反复变化/)
  expect(readRetryDelay('EMPTY_PAGE', 0, 3000)).toBe(15000)
  expect(readRetryDelay('EMPTY_RESPONSE', 1, 3000)).toBe(45000)
  expect(readRetryDelay('NETWORK_ERROR', 1, 3000)).toBe(9000)
})
