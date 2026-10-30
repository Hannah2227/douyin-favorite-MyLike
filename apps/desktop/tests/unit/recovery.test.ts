import { afterEach, expect, it, vi } from 'vitest'
import { RecoveryGate, readRecovery } from '../../src/main/recovery'
import { AppError, publicError } from '../../src/main/errors'
import { DouyinEngine } from '../../src/main/douyin/engine'

vi.mock('electron', () => ({ BrowserWindow: class {}, session: {} }))
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('blocks early attempts per account and operation without extending the local waiting time', () => {
  let now = 1000
  const gate = new RecoveryGate(() => now)
  const state = gate.failure('a', 'favorites', 'RATE_LIMITED')!
  expect(state).toEqual({ accountId: 'a', operation: 'favorites', code: 'RATE_LIMITED', retryAt: 61_000 })
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      gate.assertReady('a', 'favorites')
      throw Error('expected refusal')
    } catch (error) {
      expect(publicError(error)).toMatchObject({ code: 'RATE_LIMITED', retryAt: 61_000 })
    }
  }
  expect(gate.snapshot('a')).toEqual([state])
  expect(gate.snapshot('b')).toEqual([])
  expect(() => gate.assertReady('a', 'detail')).not.toThrow()
  expect(() => gate.assertReady('b', 'favorites')).not.toThrow()
  const copy = gate.snapshot('a')
  copy[0]!.retryAt = 0
  expect(gate.snapshot('a')[0]!.retryAt).toBe(61_000)
  now = 61_000
  expect(gate.snapshot('a')).toEqual([])
  expect(() => gate.assertReady('a', 'favorites')).not.toThrow()
})

it('increases waiting only after a new real refusal and resets only on success of the same operation', () => {
  let now = 10_000
  const gate = new RecoveryGate(() => now)
  for (const duration of [60_000, 120_000, 240_000, 480_000, 600_000, 600_000]) {
    const state = gate.failure('a', 'likes', 'UPSTREAM_RISK_CONTROL')!
    expect(state.retryAt - now).toBe(duration)
    gate.success('a', 'self')
    gate.success('b', 'likes')
    expect(() => gate.assertReady('a', 'likes')).toThrow(AppError)
    now = state.retryAt
  }
  gate.success('a', 'likes')
  expect(gate.failure('a', 'likes', 'RATE_LIMITED')!.retryAt - now).toBe(60_000)
})

it('does not penalize an account for network, content, authentication or schema failures', () => {
  const gate = new RecoveryGate(() => 1000)
  for (const code of [
    'NETWORK_ERROR',
    'TIMEOUT',
    'CONTENT_UNAVAILABLE',
    'UPSTREAM_CHANGED',
    'INVALID_RESPONSE',
    'AUTH_REQUIRED',
    'VERIFICATION_REQUIRED',
    'CANCELLED',
    'ITEM_SKIPPED'
  ])
    expect(gate.failure('a', 'favorites', code)).toBeNull()
  expect(gate.snapshot('a')).toEqual([])
})

it('rejects an early Engine request before loading a window or observing a new upstream failure', async () => {
  vi.useFakeTimers()
  const engine = new DouyinEngine(
    () => {},
    () => null
  )
  const ensure = vi
    .spyOn(engine, 'ensure')
    .mockRejectedValue(new AppError('RATE_LIMITED', 'fixture rate limit', 'http.rate_limit'))
  const observer = vi.fn()
  engine.setObserver(observer)
  await expect(engine.request('a', 'likes')).rejects.toMatchObject({
    code: 'RATE_LIMITED',
    retryAt: Date.now() + 60_000
  })
  const state = engine.recovery('a')
  for (let attempt = 0; attempt < 5; attempt++)
    await expect(engine.request('a', 'likes')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAt: state[0]!.retryAt
    })
  expect(ensure).toHaveBeenCalledTimes(1)
  expect(observer).toHaveBeenCalledTimes(1)
  engine.release()
  expect(engine.recovery('a')).toEqual(state)
  expect(() => engine.assertAvailable('a', 'detail')).not.toThrow()
})

it('keeps public diagnostic fields optional and preserves the existing rule argument', () => {
  const error = new AppError('RATE_LIMITED', 'later', 'http.rate_limit', 60_000)
  expect(error.rule).toBe('http.rate_limit')
  expect(publicError(error)).toEqual({ code: 'RATE_LIMITED', message: 'later', retryAt: 60_000 })
  expect(publicError(new AppError('TIMEOUT', 'timeout'))).toEqual({ code: 'TIMEOUT', message: 'timeout' })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(JSON.stringify(publicError(new Error('https://private.example/?cookie=SECRET')))).not.toMatch(
    /SECRET|private.example/
  )
})

it('keeps likes retry budgets and allows one light favorites retry without stacking page and network budgets', () => {
  const base = { source: 'likes' as const, retries: 0, baseDelay: 3000, visible: false }
  expect(readRecovery({ ...base, code: 'NETWORK_ERROR' })).toMatchObject({ delay: 3000, rebuild: false })
  expect(readRecovery({ ...base, code: 'NETWORK_ERROR', retries: 1 })).toMatchObject({ delay: 9000 })
  expect(readRecovery({ ...base, code: 'NETWORK_ERROR', retries: 2 })).toBeNull()
  expect(readRecovery({ ...base, code: 'EMPTY_RESPONSE' })).toMatchObject({
    delay: 15000,
    activity: 'cooling'
  })
  expect(readRecovery({ ...base, code: 'EMPTY_RESPONSE', retries: 1 })).toMatchObject({ delay: 45000 })
  expect(readRecovery({ ...base, source: 'favorites', code: 'TIMEOUT' })).toMatchObject({
    delay: 3000,
    rebuild: false
  })
  expect(readRecovery({ ...base, source: 'favorites', code: 'BROWSER_NOT_READY' })).toMatchObject({
    rebuild: true
  })
  expect(readRecovery({ ...base, source: 'favorites', code: 'PAGE_CHANGED', visible: true })).toMatchObject({
    rebuild: false
  })
  expect(readRecovery({ ...base, source: 'favorites', code: 'BROWSER_NOT_READY', retries: 1 })).toBeNull()
  expect(readRecovery({ ...base, source: 'favorites', code: 'NETWORK_ERROR', retries: 1 })).toBeNull()
  for (const source of ['likes', 'favorites'] as const)
    for (const code of [
      'RATE_LIMITED',
      'UPSTREAM_RISK_CONTROL',
      'UPSTREAM_CHANGED',
      'AUTH_REQUIRED',
      'VERIFICATION_REQUIRED',
      'IDENTITY_MISMATCH',
      'CONTENT_UNAVAILABLE',
      'UNRESOLVED_WRITE',
      'CANCELLED'
    ])
      expect(readRecovery({ ...base, source, code })).toBeNull()
})

it('prefers a visible challenge over a rate reply without imposing a request wait', async () => {
  const engine = new DouyinEngine(
    () => {},
    () => null
  )
  vi.spyOn(engine, 'ensure').mockRejectedValue(new AppError('RATE_LIMITED', 'rate fixture'))
  vi.spyOn(engine, 'pageState').mockResolvedValue({ ready: true, captcha: true })
  const attention = vi.fn()
  engine.setAttentionHandler(attention)
  await expect(engine.request('a', 'favorites')).rejects.toMatchObject({ code: 'VERIFICATION_REQUIRED' })
  expect(engine.recovery('a')).toEqual([])
  expect(attention).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'a', kind: 'verification' }))
  engine.release()
})
