import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({
  app: { getPath: () => '/fixture', getAppMetrics: () => [] },
  shell: { openExternal: vi.fn() },
  clipboard: { writeText: vi.fn() }
}))
import { Application } from '../../src/main/application'
import { AppError } from '../../src/main/errors'
import { playbackPreferencesSchema } from '../../src/shared/contracts'
import { appPreferencesSchema } from '../../src/shared/preferences'
import type { Database } from '../../src/main/storage/client'
import type { DouyinEngine } from '../../src/main/douyin/engine'

const like = {
  accountId: 'a',
  id: 'likes-task',
  mode: 'update',
  phase: 'backfill',
  status: 'paused',
  cursor: '4',
  backfillCursor: null,
  pages: 3,
  received: 30,
  added: 30,
  reason: null,
  errorCode: null,
  updatedAt: 1
}
const favorite = {
  accountId: 'a',
  id: 'favorites-task',
  stage: 'folder',
  folderId: '8',
  cursor: '9',
  status: 'paused',
  pages: 3,
  received: 30,
  added: 30,
  reason: null,
  errorCode: null,
  foldersDone: 1,
  foldersTotal: 2,
  updatedAt: 1
}
function fixture(blocked: string) {
  const call = vi.fn(async (method: string, input: any) => {
    switch (method) {
      case 'accounts':
        return [
          {
            id: 'a',
            name: 'A',
            remoteId: 'remote-a',
            nickname: 'A',
            avatarUrl: null,
            lastVerifiedAt: 1,
            createdAt: 1
          }
        ]
      case 'setting':
        return input.key === 'activeAccount' ? 'a' : 'dark'
      case 'bindAccount':
        return { id: 'a', remoteId: 'remote-a', nickname: 'A', name: 'A' }
      case 'collection':
        return like
      case 'favoritesTask':
        return input.mode === 'update' ? null : favorite
      case 'updateCollection':
        return { ...like, status: input.status }
      case 'playbackPreferences':
        return playbackPreferencesSchema.parse({})
      case 'appPreferences':
        return appPreferencesSchema.parse({})
      default:
        return null
    }
  })
  const engine = {
    setObserver: vi.fn(),
    setAttentionHandler: vi.fn(),
    allowAttention: vi.fn(),
    snapshot: vi.fn(() => ({ status: 'stopped', accountId: null })),
    recovery: vi.fn(() => []),
    recoveryTarget: vi.fn(() => null),
    assertAvailable: vi.fn((_accountId: string, operation: string) => {
      if (operation === blocked)
        throw new AppError('RATE_LIMITED', '请稍后重试。', undefined, Date.now() + 60000)
    }),
    show: vi.fn(async () => {}),
    request: vi.fn(),
    release: vi.fn(),
    cancel: vi.fn(),
    hide: vi.fn(),
    setInteraction: vi.fn(),
    requireAttention: vi.fn(),
    pageState: vi.fn(async () => ({ ready: true, captcha: false }))
  }
  const application = new Application(
    { call } as unknown as Database,
    engine as unknown as DouyinEngine,
    () => {}
  )
  const internal = application as any
  const pauseLikes = vi.spyOn(internal.collection, 'pause')
  const pauseFavorites = vi.spyOn(internal.favorites, 'pause')
  return { application, internal, call, engine, pauseLikes, pauseFavorites }
}

it.each([
  ['collectionStart', { accountId: 'a', mode: 'update' }, 'likes'],
  ['collectionControl', { accountId: 'a', taskId: 'likes-task', action: 'resume' }, 'likes'],
  ['collectPage', { accountId: 'a', continue: true }, 'likes'],
  ['favoritesStart', { accountId: 'a' }, 'folderItems'],
  ['favoritesControl', { accountId: 'a', taskId: 'favorites-task', action: 'resume' }, 'folderItems'],
  ['favoritesProbe', { accountId: 'a' }, 'folderItems']
] as const)(
  'checks %s before changing a task or issuing an identity request',
  async (command, input, blocked) => {
    const { application, call, engine, pauseLikes, pauseFavorites } = fixture(blocked)
    await expect(application.execute(command, input)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAt: expect.any(Number)
    })
    expect(engine.request).not.toHaveBeenCalled()
    expect(pauseLikes).not.toHaveBeenCalled()
    expect(pauseFavorites).not.toHaveBeenCalled()
    expect(
      call.mock.calls.some(([method]) =>
        ['startCollection', 'updateCollection', 'favoritesStart', 'favoritesUpdate', 'savePage'].includes(
          method
        )
      )
    ).toBe(false)
  }
)

it('does not pause healthy collection when an unavailable cancel endpoint rejects admission', async () => {
  const { application, engine, pauseLikes, pauseFavorites, call } = fixture('favoriteRemove')
  await expect(
    application.execute('unlikeStart', { accountId: 'a', source: 'favorites', mode: 'batch', workIds: ['1'] })
  ).rejects.toMatchObject({ code: 'RATE_LIMITED' })
  expect(pauseLikes).not.toHaveBeenCalled()
  expect(pauseFavorites).not.toHaveBeenCalled()
  expect(engine.request).not.toHaveBeenCalled()
  expect(call.mock.calls.some(([method]) => method === 'unlikeCreate')).toBe(false)
})

it('allows an independent head update when only one folder endpoint is waiting', async () => {
  const { application, internal, engine } = fixture('folderItems')
  const start = vi
    .spyOn(internal.favorites, 'start')
    .mockResolvedValue({ ...favorite, id: 'head', stage: 'all', mode: 'update' })
  await expect(
    application.execute('favoritesStart', { accountId: 'a', mode: 'update' })
  ).resolves.toMatchObject({ id: 'head' })
  expect(start).toHaveBeenCalledWith('a', 'update')
  expect(engine.assertAvailable.mock.calls.map(([, operation]) => operation)).toEqual(['self', 'favorites'])
})

it('checks the original failed operation before a manual login check sends any request', async () => {
  const { application, engine } = fixture('favorites')
  engine.recoveryTarget.mockReturnValue({ operation: 'favorites', parameters: { cursor: '0' } } as any)
  await expect(application.execute('probe', { accountId: 'a' })).rejects.toMatchObject({
    code: 'RATE_LIMITED'
  })
  expect(engine.request).not.toHaveBeenCalled()
})

it('opens a page during a business wait without manufacturing a verification requirement', async () => {
  const { application, internal, engine } = fixture('favorites')
  engine.recoveryTarget.mockReturnValue({ operation: 'favorites', parameters: { cursor: '0' } } as any)
  engine.recovery.mockReturnValue([
    { accountId: 'a', operation: 'favorites', code: 'RATE_LIMITED', retryAt: Date.now() + 60000 }
  ] as any)
  const open = vi.spyOn(internal.authentication, 'open')
  await expect(application.execute('login', { accountId: 'a' })).resolves.toBeNull()
  expect(engine.show).toHaveBeenCalledExactlyOnceWith('a')
  expect(open).not.toHaveBeenCalled()
  expect(engine.setInteraction).not.toHaveBeenCalled()
  expect(engine.request).not.toHaveBeenCalled()
})

it('allows stopping a paused task even while its remote operation is waiting', async () => {
  const { application, engine, call } = fixture('likes')
  await expect(
    application.execute('collectionControl', { accountId: 'a', taskId: 'likes-task', action: 'stop' })
  ).resolves.toMatchObject({ status: 'stopped' })
  expect(engine.assertAvailable).not.toHaveBeenCalled()
  expect(call.mock.calls.some(([method]) => method === 'updateCollection')).toBe(true)
})

it('keeps a read-only result check available when only the cancel endpoint is waiting', async () => {
  const { application, internal, engine } = fixture('favoriteRemove')
  const verify = vi.spyOn(internal.unlike, 'verify').mockResolvedValue({ unknown: 0 })
  await expect(
    application.execute('unlikeVerify', { accountId: 'a', taskId: 'write', workId: '1' })
  ).resolves.toMatchObject({ unknown: 0 })
  expect(verify).toHaveBeenCalledWith('a', 'write', '1')
  expect(engine.assertAvailable.mock.calls.map(([, operation]) => operation)).toEqual(['self', 'detail'])
})

it('unlocks recovery actions only after identity and the original read target both succeed', async () => {
  const { application, engine } = fixture('none')
  engine.recoveryTarget.mockReturnValue({ operation: 'favorites', parameters: { cursor: '0' } } as any)
  engine.request.mockImplementation(async (_id: string, operation: string) =>
    operation === 'self'
      ? { user: { sec_uid: 'remote-a', nickname: 'A' } }
      : { status_code: 0, aweme_list: [], has_more: 0, cursor: '0' }
  )
  await application.execute('probe', { accountId: 'a' })
  expect((await application.snapshot()).accessChecks).toEqual([
    { accountId: 'a', operation: 'self', at: expect.any(Number) },
    { accountId: 'a', operation: 'favorites', at: expect.any(Number) }
  ])
  const handler = engine.setAttentionHandler.mock.calls[0]![0] as any
  handler({
    type: 'required',
    accountId: 'a',
    kind: 'verification',
    target: { operation: 'favorites', parameters: {} }
  })
  expect((await application.snapshot()).accessChecks).toEqual([])
  ;(application as any).authentication.stop()
})

it('does not unlock a task when identity succeeds but its original read still fails', async () => {
  const { application, engine } = fixture('none')
  engine.recoveryTarget.mockReturnValue({ operation: 'favorites', parameters: { cursor: '0' } } as any)
  engine.request.mockImplementation(async (_id: string, operation: string) => {
    if (operation === 'self') return { user: { sec_uid: 'remote-a', nickname: 'A' } }
    throw new AppError('INVALID_RESPONSE', 'test')
  })
  await expect(application.execute('probe', { accountId: 'a' })).rejects.toMatchObject({
    code: 'INVALID_RESPONSE'
  })
  expect((await application.snapshot()).accessChecks).toEqual([])
})

it('does not publish successful access checks after cancellation during account binding', async () => {
  const { application, internal, engine, call } = fixture('none')
  engine.request.mockResolvedValue({ user: { sec_uid: 'remote-a', nickname: 'A' } })
  await expect(
    internal.verifyAccess('a', null, () => {
      if (call.mock.calls.some(([method]) => method === 'bindAccount'))
        throw new AppError('CANCELLED', 'test')
    })
  ).rejects.toMatchObject({ code: 'CANCELLED' })
  expect((await application.snapshot()).accessChecks).toEqual([])
})

it.each([false, true])('chooses verification only from actual captcha evidence (%s)', async (captcha) => {
  const { application, internal, engine } = fixture('none')
  const target = { operation: 'favorites', parameters: { cursor: '0' } }
  engine.recoveryTarget.mockReturnValue(target as any)
  engine.pageState.mockResolvedValue({ ready: true, captcha })
  const open = vi.spyOn(internal.authentication, 'open').mockResolvedValue(undefined)
  await application.execute('login', { accountId: 'a' })
  expect(open).toHaveBeenCalledExactlyOnceWith('a', captcha ? 'verification' : 'login', target)
})

it('keeps an existing real verification interaction when reopening its account', async () => {
  const { application, internal, engine } = fixture('none')
  vi.spyOn(internal.authentication, 'snapshot').mockReturnValue({
    accountId: 'a',
    kind: 'verification',
    status: 'waiting',
    message: 'test'
  })
  const open = vi.spyOn(internal.authentication, 'open').mockResolvedValue(undefined)
  await application.execute('login', { accountId: 'a' })
  expect(open).toHaveBeenCalledExactlyOnceWith('a', 'verification', null)
  expect(engine.pageState).not.toHaveBeenCalled()
})

it('does not open an old account when the page-state check is cancelled', async () => {
  const { application, internal, engine } = fixture('none')
  engine.pageState.mockImplementation(async () => {
    internal.epoch++
    return { ready: true, captcha: false }
  })
  const open = vi.spyOn(internal.authentication, 'open').mockResolvedValue(undefined)
  await expect(application.execute('login', { accountId: 'a' })).rejects.toMatchObject({ code: 'CANCELLED' })
  expect(open).not.toHaveBeenCalled()
})

function healthyRequests(engine: ReturnType<typeof fixture>['engine']) {
  engine.request.mockImplementation(async (_id: string, op: string) =>
    op === 'self'
      ? { user: { sec_uid: 'remote-a', nickname: 'A' } }
      : op === 'folders'
        ? { status_code: 0, collects_list: [], has_more: 0, cursor: '0' }
        : { status_code: 0, aweme_list: [], has_more: 0, cursor: '0' }
  )
}
it('checks identity, likes, favorites, folders and the blocked folder without saving content or advancing tasks', async () => {
  const { application, engine, call } = fixture('none')
  healthyRequests(engine)
  const before = await application.snapshot()
  const result = (await application.execute('checkHealth', { accountId: 'a' })) as any
  expect(result).toMatchObject({ status: 'normal', checking: false })
  expect(engine.request.mock.calls.map((c) => c[1])).toEqual([
    'self',
    'likes',
    'favorites',
    'folders',
    'folderItems'
  ])
  const after = await application.snapshot()
  expect(after.collection).toEqual(before.collection)
  expect(after.favorites).toEqual(before.favorites)
  expect(
    call.mock.calls.some(([m]) =>
      ['savePage', 'favoritesSave', 'saveCollectionPage', 'unlikeFinish', 'updateCollection'].includes(m)
    )
  ).toBe(false)
})
it('keeps healthy likes independent of a restricted favorite request and does not issue the blocked request', async () => {
  const { application, engine } = fixture('favorites')
  healthyRequests(engine)
  const result = (await application.execute('checkHealth', { accountId: 'a' })) as any
  expect(result.status).toBe('abnormal')
  expect(result.entries.find((e: any) => e.operation === 'likes').status).toBe('normal')
  expect(engine.request.mock.calls.some((c) => c[1] === 'favorites')).toBe(false)
})
it('classifies an empty advancing read as uncertain instead of healthy and escalates three actual checks', async () => {
  const { application, engine } = fixture('none')
  healthyRequests(engine)
  const normal = engine.request.getMockImplementation()!
  engine.request.mockImplementation(async (...args: any[]) =>
    args[1] === 'likes'
      ? { status_code: 0, aweme_list: [], has_more: 1, max_cursor: '9' }
      : (normal as any)(...args)
  )
  for (let i = 1; i <= 3; i++) {
    const result = (await application.execute('checkHealth', { accountId: 'a' })) as any
    expect(result.entries.find((e: any) => e.operation === 'likes')).toMatchObject({
      failures: i,
      status: i === 3 ? 'abnormal' : 'uncertain'
    })
  }
})
it('refuses to alter the direction of a stored head while another task owns the engine', async () => {
  const { application, internal, call } = fixture('none')
  const original = call.getMockImplementation()!
  call.mockImplementation(async (m: any, i: any): Promise<any> =>
    m === 'collection'
      ? { ...like, mode: 'incremental', phase: 'head', backfillCursor: '999' }
      : original(m, i)
  )
  vi.spyOn(internal.favorites, 'running', 'get').mockReturnValue(true)
  await expect(
    application.execute('collectionAction', { accountId: 'a', source: 'likes', action: 'down' })
  ).rejects.toMatchObject({ code: 'BUSY' })
  expect(call.mock.calls.some(([m]) => m === 'updateCollection')).toBe(false)
})

it('reports local binding failure as uncertain instead of showing healthy or opening a login loop', async () => {
  const { application, engine, call } = fixture('none')
  healthyRequests(engine)
  const normal = call.getMockImplementation()!
  call.mockImplementation(async (m: any, i: any): Promise<any> => {
    if (m === 'bindAccount') throw new AppError('STORAGE_ERROR', 'fixture')
    return normal(m, i)
  })
  const result = (await application.execute('checkHealth', { accountId: 'a' })) as any
  expect(result).toMatchObject({ status: 'uncertain', checking: false })
  expect(result.entries.find((e: any) => e.operation === 'self')).toMatchObject({
    code: 'STORAGE_ERROR',
    failures: 1
  })
  expect(engine.requireAttention).not.toHaveBeenCalled()
})

it('coalesces simultaneous status checks into one read-only round', async () => {
  const { application, engine } = fixture('none')
  healthyRequests(engine)
  const [a, b] = await Promise.all([
    application.execute('checkHealth', { accountId: 'a' }),
    application.execute('checkHealth', { accountId: 'a' })
  ])
  expect(a).toMatchObject({ status: 'normal', checking: false })
  expect(b).toMatchObject({ status: 'normal', checking: false })
  expect(engine.request.mock.calls.map((c) => c[1])).toEqual([
    'self',
    'likes',
    'favorites',
    'folders',
    'folderItems'
  ])
})
