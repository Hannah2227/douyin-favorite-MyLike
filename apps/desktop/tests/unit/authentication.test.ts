import { afterEach, expect, it, vi } from 'vitest'
import { Authentication } from '../../src/main/authentication'
import { AppError } from '../../src/main/errors'
import { retryableRead, rebuildReadPage } from '../../src/main/read-recovery'

const sessions: Authentication[] = []
function fixture() {
  vi.useFakeTimers()
  const engine = {
    show: vi.fn(async () => {}),
    hide: vi.fn(),
    setInteraction: vi.fn(),
    pageState: vi.fn(async () => ({ ready: true, captcha: false }))
  }
  const probe = vi.fn(async (_id: string, _target: unknown, check: () => void) => {
    check()
  })
  const auth = new Authentication(
    engine,
    (_id, action) => action(() => {}),
    probe,
    () => {}
  )
  sessions.push(auth)
  return { auth, engine, probe }
}
afterEach(() => {
  for (const auth of sessions.splice(0)) auth.stop()
  vi.useRealTimers()
})

it('hides login only after the scoped identity probe succeeds', async () => {
  const { auth, engine, probe } = fixture()
  await auth.open('a', 'login')
  expect(engine.hide).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1200)
  expect(probe).toHaveBeenCalledWith('a', null, expect.any(Function))
  expect(engine.hide).toHaveBeenCalledExactlyOnceWith('a')
  expect(auth.snapshot()).toBeNull()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(probe).toHaveBeenCalledTimes(1)
})

it('does not issue probes or close the window while a visible captcha remains', async () => {
  const { auth, engine, probe } = fixture()
  engine.pageState.mockResolvedValue({ ready: true, captcha: true })
  await auth.open('a', 'verification', { operation: 'likes', parameters: { max_cursor: '123' } })
  await vi.advanceTimersByTimeAsync(7000)
  expect(probe).not.toHaveBeenCalled()
  expect(engine.hide).not.toHaveBeenCalled()
  engine.pageState.mockResolvedValue({ ready: true, captcha: false })
  await vi.advanceTimersByTimeAsync(2000)
  expect(probe.mock.calls[0]?.[1]).toEqual({ operation: 'likes', parameters: { max_cursor: '123' } })
  expect(engine.hide).toHaveBeenCalledTimes(1)
})

it('keeps verification open when the original list is still limited, with bounded probe frequency', async () => {
  const { auth, engine, probe } = fixture()
  probe.mockRejectedValue(new AppError('RATE_LIMITED', 'limited'))
  await auth.open('a', 'verification', {
    operation: 'folderItems',
    parameters: { collects_id: '99', cursor: '8' }
  })
  await vi.advanceTimersByTimeAsync(31_000)
  expect(probe).toHaveBeenCalledTimes(1)
  expect(engine.hide).not.toHaveBeenCalled()
  probe.mockImplementation(async (_id, _target, check) => {
    check()
  })
  await vi.advanceTimersByTimeAsync(1000)
  expect(engine.hide).toHaveBeenCalledExactlyOnceWith('a')
})

it('discards late completion after the user closes the window or changes account', async () => {
  const { auth, engine, probe } = fixture()
  let finish!: () => void
  probe.mockImplementation(async (_id, _target, check) => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    check()
  })
  await auth.open('a', 'login')
  await vi.advanceTimersByTimeAsync(1200)
  auth.handle({ type: 'closed', accountId: 'a' })
  finish()
  await vi.advanceTimersByTimeAsync(10000)
  expect(engine.hide).not.toHaveBeenCalled()
  expect(probe).toHaveBeenCalledTimes(1)
  expect(auth.snapshot()).toBeNull()
})

it('does not finish an outdated self-only probe after upgrading to the blocked interface', async () => {
  const { auth, engine, probe } = fixture()
  let finish!: () => void
  probe.mockImplementationOnce(async (_id, _target, check) => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    check()
  })
  await auth.open('a', 'verification')
  await vi.advanceTimersByTimeAsync(1200)
  auth.handle({
    type: 'required',
    accountId: 'a',
    kind: 'verification',
    target: { operation: 'likes', parameters: { max_cursor: '10' } }
  })
  finish()
  await vi.advanceTimersByTimeAsync(1)
  expect(engine.hide).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(5000)
  expect(probe.mock.calls[1]?.[1]).toEqual({ operation: 'likes', parameters: { max_cursor: '10' } })
  expect(engine.hide).toHaveBeenCalledTimes(1)
  expect(engine.show).toHaveBeenCalledTimes(1)
})

it('leaves mismatched accounts visible and bounds automatic checking to ten minutes', async () => {
  const { auth, engine, probe } = fixture()
  probe.mockRejectedValue(new AppError('IDENTITY_MISMATCH', '账号不一致'))
  await auth.open('a', 'login')
  await vi.advanceTimersByTimeAsync(1200)
  expect(auth.snapshot()).toMatchObject({ status: 'failed', message: '账号不一致' })
  expect(engine.hide).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(630_000)
  const count = probe.mock.calls.length
  expect(count).toBeLessThanOrEqual(21)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(probe).toHaveBeenCalledTimes(count)
})

it('never treats verification, rate limits, account mismatch or business rejection as retryable reads', () => {
  for (const code of [
    'VERIFICATION_REQUIRED',
    'AUTH_REQUIRED',
    'RATE_LIMITED',
    'IDENTITY_MISMATCH',
    'API_REJECTED',
    'PAGINATION_STALLED'
  ])
    expect(retryableRead(code)).toBe(false)
  expect(retryableRead('INVALID_RESPONSE')).toBe(true)
  expect(rebuildReadPage('TIMEOUT', 1, false)).toBe(true)
  expect(rebuildReadPage('TIMEOUT', 0, false)).toBe(false)
  expect(rebuildReadPage('TIMEOUT', 1, true)).toBe(false)
})
