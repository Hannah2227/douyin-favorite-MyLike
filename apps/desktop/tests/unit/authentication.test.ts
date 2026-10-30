import { afterEach, expect, it, vi } from 'vitest'
import { Authentication } from '../../src/main/authentication'
import { AppError } from '../../src/main/errors'
import { retryableRead, rebuildReadPage, PageProgress } from '../../src/main/read-recovery'

const sessions: Authentication[] = []
function fixture() {
  vi.useFakeTimers()
  const engine = {
    show: vi.fn(async () => {}),
    hide: vi.fn(),
    setInteraction: vi.fn(),
    cancelRecovery: vi.fn(),
    pageState: vi.fn(async () => ({ ready: true, captcha: false }))
  }
  const probe = vi.fn(async (_id: string, _target: unknown, check: () => void) => {
    check()
  })
  const report = vi.fn()
  const auth = new Authentication(
    engine,
    (_id, action) => action(() => {}),
    probe,
    () => {},
    report
  )
  sessions.push(auth)
  return { auth, engine, probe, report }
}
afterEach(() => {
  for (const auth of sessions.splice(0)) auth.stop()
  vi.useRealTimers()
})

it('hides login only after the scoped identity probe succeeds', async () => {
  const { auth, engine, probe } = fixture()
  await auth.open('a', 'login')
  expect(engine.hide).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(299)
  expect(probe).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(probe).toHaveBeenCalledWith('a', null, expect.any(Function), 'login')
  expect(engine.hide).toHaveBeenCalledExactlyOnceWith('a')
  expect(auth.snapshot()).toBeNull()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(probe).toHaveBeenCalledTimes(1)
})
it('continues bounded detection after an initial navigation failure and closes after recovery', async () => {
  const { auth, engine, probe, report } = fixture()
  engine.show.mockRejectedValueOnce(new AppError('BROWSER_NOT_READY', 'initial navigation failed'))
  await expect(auth.open('a', 'login')).rejects.toThrow('initial navigation failed')
  expect(report).toHaveBeenCalledWith(
    'a',
    expect.objectContaining({ kind: 'auth', code: 'BROWSER_NOT_READY' })
  )
  engine.pageState.mockResolvedValue({ ready: false, captcha: false })
  await vi.advanceTimersByTimeAsync(500)
  expect(probe).not.toHaveBeenCalled()
  engine.pageState.mockResolvedValue({ ready: true, captcha: false })
  await vi.advanceTimersByTimeAsync(500)
  expect(engine.hide).toHaveBeenCalledExactlyOnceWith('a')
  expect(engine.show).toHaveBeenCalledTimes(1)
})

it('does not issue probes or close the window while a visible captcha remains', async () => {
  const { auth, engine, probe } = fixture()
  engine.pageState.mockResolvedValue({ ready: true, captcha: true })
  await auth.open('a', 'verification', { operation: 'likes', parameters: { max_cursor: '123' } })
  await vi.advanceTimersByTimeAsync(7000)
  expect(probe).not.toHaveBeenCalled()
  expect(engine.hide).not.toHaveBeenCalled()
  engine.pageState.mockResolvedValue({ ready: true, captcha: false })
  await vi.advanceTimersByTimeAsync(500)
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
  await vi.advanceTimersByTimeAsync(30_000)
  expect(probe).toHaveBeenCalledTimes(1)
  expect(engine.hide).not.toHaveBeenCalled()
  probe.mockImplementation(async (_id, _target, check) => {
    check()
  })
  await vi.advanceTimersByTimeAsync(300)
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
  expect(auth.snapshot()).toMatchObject({
    status: 'failed',
    code: 'IDENTITY_MISMATCH',
    message: '登录的抖音账号与当前账号不一致，请切回原账号。'
  })
  expect(engine.hide).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(630_000)
  const count = probe.mock.calls.length
  expect(count).toBeLessThanOrEqual(21)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(probe).toHaveBeenCalledTimes(count)
})

it.each(['AUTH_REQUIRED', 'LOGIN_PENDING'])(
  'polls login every two seconds after %s without the business-API cooldown',
  async (code) => {
    const { auth, engine, probe } = fixture()
    probe.mockRejectedValueOnce(new AppError(code, 'not logged in'))
    await auth.open('a', 'login')
    await vi.advanceTimersByTimeAsync(300)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(engine.hide).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1999)
    expect(probe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(engine.hide).toHaveBeenCalledExactlyOnceWith('a')
  }
)

it('does not overlap slow probes or close before their identity result arrives', async () => {
  const { auth, engine, probe } = fixture()
  let finish!: () => void
  probe.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
  })
  await auth.open('a', 'login')
  await vi.advanceTimersByTimeAsync(10_000)
  expect(probe).toHaveBeenCalledTimes(1)
  expect(engine.hide).not.toHaveBeenCalled()
  finish()
  await vi.advanceTimersByTimeAsync(1)
  expect(engine.hide).toHaveBeenCalledExactlyOnceWith('a')
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
it('wakes login checks on changed credentials, discards the old probe and never treats the hint as identity proof', async () => {
  const { auth, engine, probe } = fixture()
  let reject!: (error: Error) => void
  probe.mockImplementationOnce(async () => {
    await new Promise<void>((_resolve, fail) => {
      reject = fail
    })
  })
  engine.cancelRecovery.mockImplementation(() => reject(new AppError('CANCELLED', 'old probe')))
  await auth.open('a', 'login')
  await vi.advanceTimersByTimeAsync(300)
  auth.handle({ type: 'changed', accountId: 'b' })
  expect(engine.cancelRecovery).not.toHaveBeenCalled()
  auth.handle({ type: 'changed', accountId: 'a' })
  expect(engine.hide).not.toHaveBeenCalled()
  expect(engine.cancelRecovery).toHaveBeenCalledExactlyOnceWith('a')
  await vi.advanceTimersByTimeAsync(600)
  expect(probe).toHaveBeenCalledTimes(2)
  expect(engine.hide).toHaveBeenCalledExactlyOnceWith('a')
})
it('does not let changed-cookie hints bypass an explicit rate-limit cooldown', async () => {
  const { auth, engine, probe } = fixture()
  probe.mockRejectedValueOnce(new AppError('RATE_LIMITED', 'limited'))
  await auth.open('a', 'login')
  await vi.advanceTimersByTimeAsync(300)
  auth.handle({ type: 'changed', accountId: 'a' })
  await vi.advanceTimersByTimeAsync(29_000)
  expect(probe).toHaveBeenCalledTimes(1)
  expect(engine.cancelRecovery).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1000)
  expect(engine.hide).toHaveBeenCalledExactlyOnceWith('a')
})
it('scopes replay detection to the collection phase or folder and permits an actual terminal page', () => {
  const progress = new PageProgress()
  progress.check('all', ['1', '2'], true)
  progress.check('all', ['2', '1'], true)
  progress.check('folder:8', ['1', '2'], true)
  progress.check('folder:8', ['2', '1'], true)
  progress.check('folder:8', ['1', '2'], false)
  expect(() => progress.check('folder:9', ['1', '2'], true)).not.toThrow()
})

it('does not let reopening the same login window bypass a shared wait supplied by the engine', async () => {
  const { auth, engine, probe } = fixture()
  const retryAt = Date.now() + 60_000
  probe.mockRejectedValueOnce(new AppError('UPSTREAM_RISK_CONTROL', 'limited', 'envelope.risk_code', retryAt))
  await auth.open('a', 'verification', { operation: 'favorites', parameters: { cursor: '0' } })
  await vi.advanceTimersByTimeAsync(300)
  expect(auth.snapshot()).toMatchObject({ status: 'waiting', code: 'UPSTREAM_RISK_CONTROL', retryAt })
  await auth.open('a', 'verification')
  auth.handle({ type: 'changed', accountId: 'a' })
  await vi.advanceTimersByTimeAsync(59_699)
  expect(probe).toHaveBeenCalledTimes(1)
  expect(engine.hide).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(probe).toHaveBeenCalledTimes(2)
  expect(engine.hide).toHaveBeenCalledExactlyOnceWith('a')
})

it.each(['INVALID_RESPONSE', 'EMPTY_RESPONSE', 'EMPTY_PAGE', 'NO_AVAILABLE_ITEMS'])(
  'does not ask for a challenge or claim login succeeded when %s prevents confirmation',
  async (code) => {
    const { auth, engine, probe } = fixture()
    probe.mockRejectedValue(new AppError(code, 'fixture technical response'))
    await auth.open('a', 'verification', { operation: 'favorites', parameters: { cursor: '0' } })
    await vi.advanceTimersByTimeAsync(300)
    expect(auth.snapshot()).toMatchObject({
      code,
      message: '抖音暂时没有返回可用内容，请稍后再试；已同步的内容会保留。'
    })
    expect(auth.snapshot()!.message).not.toMatch(/完成.*验证|已登录|fixture/)
    expect(engine.hide).not.toHaveBeenCalled()
  }
)

it('keeps an unclassified failed verification neutral and requests login only on explicit authentication evidence', async () => {
  const { auth, probe } = fixture()
  probe.mockRejectedValueOnce(new AppError('INTERNAL_ERROR', 'fixture internal failure'))
  probe.mockRejectedValueOnce(new AppError('AUTH_REQUIRED', 'fixture expired login'))
  await auth.open('a', 'verification', { operation: 'favorites', parameters: { cursor: '0' } })
  await vi.advanceTimersByTimeAsync(300)
  expect(auth.snapshot()?.message).toBe('暂时无法完成检查，请稍后重试；已同步的内容会保留。')
  await vi.advanceTimersByTimeAsync(3000)
  expect(auth.snapshot()?.message).toBe('请在抖音窗口完成登录，完成后窗口会自动收起。')
})
