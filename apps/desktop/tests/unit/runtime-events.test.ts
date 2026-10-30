import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../../src/main/storage/database'
import { responseSummary } from '../../src/main/douyin/response-summary'
import { EndConfirmation, readRetryDelay } from '../../src/main/read-recovery'
import { testTimeout } from '../helpers/test-timeout'

const roots: string[] = [],
  stores: Store[] = []
it('labels collection terminal responses with absent arrays without weakening unrelated or ambiguous responses', () => {
  for (const operation of ['favorites', 'folders', 'folderItems']) {
    for (const data of [
      { status_code: 0, has_more: 0 },
      { status_code: 0, has_more: false, aweme_list: null }
    ])
      expect(responseSummary(JSON.stringify(data), 200, operation)).toMatchObject({
        responseType: 'terminal-list',
        count: 0
      })
  }
  expect(responseSummary('{"status_code":0,"has_more":0}', 200, 'detail')).toEqual({ responseType: 'json' })
  expect(responseSummary('{"status_code":0,"has_more":1}', 200, 'folderItems')).toMatchObject({
    responseType: 'json'
  })
  expect(responseSummary('{"has_more":0}', 200, 'favorites')).toMatchObject({ responseType: 'json' })
})
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
    { kind: 'auth' as const, code: 'CANCELLED', message: '用户关窗' },
    { kind: 'task' as const, code: 'EMPTY_PAGE_PROBE', message: '正在探查下一页' },
    { kind: 'task' as const, code: 'INVALID_ITEMS', message: '跳过一条作品' },
    { kind: 'request' as const, operation: 'likes', responseType: 'empty-list', message: '空页候选' },
    { kind: 'auth' as const, code: 'VERIFICATION_REQUIRED', message: '正在等待用户验证' },
    { kind: 'task' as const, code: 'TIMEOUT', message: '喜欢采集暂缓 3 秒后重试同一断点（1/2）：超时' },
    { kind: 'task' as const, operation: 'folderItems', code: 'END_CONFIRMED', message: '一个空夹结束' }
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

it('merges the same failure for five minutes while keeping distinct errors and whole-task ends', () => {
  const { store } = setup()
  const event = { kind: 'request' as const, message: '读取超时', code: 'TIMEOUT', operation: 'self' }
  for (let n = 0; n < 20; n++) store.call('appendRuntimeEvent', { accountId: 'a', event })
  const first = store.call('runtimeEvents', { accountId: 'a' })
  expect(first).toHaveLength(1)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(first[0]!.time + 30_001)
  store.call('appendRuntimeEvent', { accountId: 'a', event })
  expect(store.call('runtimeEvents', { accountId: 'a' })).toHaveLength(1)
  clock.mockReturnValue(first[0]!.time + 300_001)
  store.call('appendRuntimeEvent', { accountId: 'a', event })
  store.call('appendRuntimeEvent', { accountId: 'a', event: { ...event, code: 'NETWORK_ERROR' } })
  for (let n = 0; n < 2; n++)
    store.call('appendRuntimeEvent', {
      accountId: 'a',
      event: { kind: 'task', code: 'END_CONFIRMED', message: '收藏同步已确认触底。' }
    })
  expect(store.call('runtimeEvents', { accountId: 'a' })).toHaveLength(5)
})

it('persists distinct classification rules and numeric platform codes without merging different failure causes', () => {
  const { store, file } = setup()
  const event = {
    kind: 'request' as const,
    operation: 'favorites',
    message: '接口请求未正常结束',
    code: 'UPSTREAM_RISK_CONTROL',
    responseType: 'risk-control'
  }
  for (let i = 0; i < 5; i++)
    store.call('appendRuntimeEvent', {
      accountId: 'a',
      event: { ...event, rule: 'payload.bare_envelope', platformCode: '0' }
    })
  for (const platformCode of ['8', '10000'])
    store.call('appendRuntimeEvent', {
      accountId: 'a',
      event: { ...event, rule: 'envelope.risk_code', platformCode }
    })
  expect(store.call('runtimeEvents', { accountId: 'a' })).toHaveLength(3)
  expect(store.call('runtimeEvents', { accountId: 'b' })).toEqual([])
  store.call('close', undefined)
  const reopened = new Store(file)
  stores.push(reopened)
  expect(reopened.call('runtimeEvents', { accountId: 'a' }).map((e) => [e.rule, e.platformCode])).toEqual([
    ['payload.bare_envelope', '0'],
    ['envelope.risk_code', '8'],
    ['envelope.risk_code', '10000']
  ])
})

it('keeps only allowlisted classification metadata and never stores arbitrary status messages or identifiers', () => {
  const first = responseSummary(
    JSON.stringify({ status_code: 0, extra: { cookie: 'SECRET', logid: 'PRIVATE' } }),
    200,
    'favorites'
  )
  expect(first).toMatchObject({
    responseType: 'risk-control',
    rule: 'payload.bare_envelope',
    platformCode: '0'
  })
  const second = responseSummary(
    JSON.stringify({ status_code: 8, status_msg: 'SECRET', cookie: 'PRIVATE' }),
    200,
    'favorites'
  )
  expect(second).toMatchObject({
    responseType: 'risk-control',
    rule: 'envelope.risk_code',
    platformCode: '8'
  })
  const oversized = responseSummary('{"status_code":"7381234567890123456"}', 200, 'favorites')
  expect(oversized.platformCode).toBeUndefined()
  expect(JSON.stringify([first, second, oversized])).not.toMatch(/SECRET|PRIVATE|7381234567890123456/)
  const { store } = setup()
  expect(() =>
    store.call('appendRuntimeEvent', {
      accountId: 'a',
      event: { kind: 'request', message: 'bad rule', code: 'TIMEOUT', rule: 'SECRET' as any }
    })
  ).toThrow()
  expect(store.call('runtimeEvents', { accountId: 'a' })).toEqual([])
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

it(
  'keeps task events when the bounded request history fills and purges all copies on account deletion',
  () => {
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
          durationMs: 10,
          platformCode: String(n)
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
  },
  testTimeout(15000)
)

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

it('combines a request failure and its task outcome without losing diagnostic evidence', () => {
  const { store, file } = setup()
  const event = {
    kind: 'request' as const,
    operation: 'favorites',
    message: '接口暂时限流',
    code: 'RATE_LIMITED',
    status: 429,
    rule: 'http.rate_limit' as const,
    responseType: 'http-error',
    durationMs: 100,
    count: 20
  }
  store.call('appendRuntimeEvent', { accountId: 'a', event })
  const first = store.call('runtimeEvents', { accountId: 'a' })[0]!
  store.call('appendRuntimeEvent', {
    accountId: 'a',
    event: {
      kind: 'task',
      operation: 'favorites',
      code: 'RATE_LIMITED',
      message: '收藏同步异常中断：接口暂时限流'
    }
  })
  const events = store.call('runtimeEvents', { accountId: 'a' })
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({
    id: first.id,
    time: first.time,
    kind: 'task',
    operation: 'favorites',
    code: 'RATE_LIMITED',
    status: 429,
    rule: 'http.rate_limit',
    responseType: 'http-error',
    message: '收藏同步异常中断：接口暂时限流'
  })
  expect(events[0]).not.toHaveProperty('durationMs')
  expect(events[0]).not.toHaveProperty('count')
  const db = new DatabaseSync(file)
  try {
    const before = db.prepare('SELECT value FROM settings WHERE key=?').get('runtime:a')!.value
    store.call('appendRuntimeEvent', { accountId: 'a', event })
    expect(db.prepare('SELECT value FROM settings WHERE key=?').get('runtime:a')!.value).toBe(before)
  } finally {
    db.close()
  }
})

it('keeps different folder failures and interrupted tasks independently identifiable', () => {
  const { store } = setup()
  for (const folder of ['8', '9'])
    store.call('appendRuntimeEvent', {
      accountId: 'a',
      event: {
        kind: 'task',
        operation: 'folderItems',
        code: 'FOLDER_DEFERRED',
        message: '收藏夹 ' + folder + ' 暂缓同步：接口结构变化'
      }
    })
  for (const label of ['喜欢采集', '取消收藏'])
    store.call('appendRuntimeEvent', {
      accountId: 'a',
      event: { kind: 'task', code: 'INTERRUPTED', message: label + '因应用中断而暂停' }
    })
  expect(store.call('runtimeEvents', { accountId: 'a' })).toHaveLength(4)
})

it('compacts older repeated failures on read while preserving account scope and raw storage', () => {
  const { store, file } = setup()
  const events = [
    {
      id: randomUUID(),
      time: 1000,
      kind: 'request',
      operation: 'likes',
      code: 'TIMEOUT',
      message: '接口请求未正常结束',
      durationMs: 10
    },
    {
      id: randomUUID(),
      time: 2000,
      kind: 'task',
      operation: 'likes',
      code: 'TIMEOUT',
      message: '喜欢采集异常中断：网络超时'
    },
    { id: randomUUID(), time: 3000, kind: 'task', code: 'EMPTY_PAGE_PROBE', message: '空页探查' }
  ]
  const db = new DatabaseSync(file)
  try {
    db.prepare('INSERT INTO settings VALUES(?,?)').run('runtime:a', JSON.stringify(events))
    expect(store.call('runtimeEvents', { accountId: 'a' })).toEqual([
      expect.objectContaining({ kind: 'task', code: 'TIMEOUT', message: '喜欢采集异常中断：网络超时' })
    ])
    expect(store.call('runtimeEvents', { accountId: 'b' })).toEqual([])
    expect(db.prepare('SELECT value FROM settings WHERE key=?').get('runtime:a')!.value).toBe(
      JSON.stringify(events)
    )
  } finally {
    db.close()
  }
})

it('keeps different native crash reasons while combining each crash with its task interruption', () => {
  const { store } = setup()
  for (const reason of ['crashed，退出码 1', 'oom，退出码 2']) {
    const message = '抖音页面进程意外停止（' + reason + '），已保存进度保留；请重新打开窗口。'
    store.call('appendRuntimeEvent', {
      accountId: 'a',
      event: { kind: 'engine', code: 'BROWSER_CRASHED', rule: 'page.crashed', message }
    })
    store.call('appendRuntimeEvent', {
      accountId: 'a',
      event: {
        kind: 'task',
        operation: 'likes',
        code: 'BROWSER_CRASHED',
        message: '喜欢采集异常中断：' + message
      }
    })
  }
  const events = store.call('runtimeEvents', { accountId: 'a' })
  expect(events).toHaveLength(2)
  expect(events.map((e) => e.message)).toEqual([
    expect.stringContaining('crashed，退出码 1'),
    expect.stringContaining('oom，退出码 2')
  ])
})
