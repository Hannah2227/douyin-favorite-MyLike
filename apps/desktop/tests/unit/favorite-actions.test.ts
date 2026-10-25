import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Store } from '../../src/main/storage/database'
import type { Database } from '../../src/main/storage/client'
import type { Operation } from '../../src/main/douyin/page-request'
import { FavoriteActions } from '../../src/main/favorite-actions'
import { AppError } from '../../src/main/errors'

const roots: string[] = [],
  stores: Store[] = []
const work = {
  id: '1234567890123456789',
  title: '喜欢的作品',
  author: '作者',
  publishedAt: 1700000000,
  coverUrl: null,
  mediaType: 'video' as const,
  isLive: false
}
function setup(collected = false) {
  const root = mkdtempSync(join(tmpdir(), 'mylike-favorite-actions-'))
  roots.push(root)
  const store = new Store(join(root, 'db.sqlite'))
  stores.push(store)
  for (const id of ['a', 'b']) {
    store.call('createAccount', { id, name: id })
    store.call('bindAccount', { accountId: id, remoteId: `remote-${id}`, nickname: id, avatarUrl: null })
  }
  store.call('savePage', {
    accountId: 'a',
    remoteId: 'remote-a',
    items: [work, { ...work, id: '2' }],
    cursor: '0',
    hasMore: false
  })
  const queue = store.call('queueCreate', {
    accountId: 'a',
    source: { type: 'ids', ids: [work.id, '2'], sort: 'published' },
    mode: 'sequence',
    startWorkId: work.id
  })
  const scope = { accountId: 'a', queueId: queue.queueId, revision: queue.revision, workId: work.id }
  const platform = {
    collected,
    remoteId: 'remote-a',
    folders: [
      { collects_id_str: '9007199254740993999', collects_name: '旅行', total_number: 12, status: 0 },
      { collects_id_str: '8', collects_name: '音乐', total_number: 0, status: 1 }
    ],
    failure: '' as Operation | '',
    hold: null as (() => Promise<void>) | null,
    afterWrite: null as (() => void) | null,
    confirmedDespiteFailure: false
  }
  const calls: { operation: Operation; parameters: Record<string, string> }[] = []
  const service = new FavoriteActions(
    { call: async (method: any, input: any) => store.call(method, input) } as Database,
    {
      request: async (_account, operation, parameters = {}) => {
        calls.push({ operation, parameters })
        if (operation === 'detail')
          return {
            aweme_detail: {
              aweme_id: work.id,
              desc: work.title,
              collect_stat: platform.collected ? 1 : 0,
              aweme_type: 68,
              images: [{ url_list: [] }]
            }
          }
        if (operation === 'folders') return { collects_list: platform.folders, has_more: 0, cursor: '0' }
        if (operation === platform.failure) {
          if (platform.confirmedDespiteFailure) platform.collected = true
          throw new AppError('TIMEOUT', 'fixture timeout')
        }
        await platform.hold?.()
        if (operation === 'favoriteAdd') platform.collected = true
        platform.afterWrite?.()
        if (operation === 'favoriteFolderCreate') {
          const folder = {
            collects_id_str: '9',
            collects_name: parameters.collects_name!,
            total_number: 0,
            status: parameters.secret === '1' ? 0 : 1
          }
          platform.folders.push(folder)
          return { status_code: 0, collects_info: folder }
        }
        return { status_code: 0 }
      }
    },
    async (_id, action) => action(() => {}),
    async () => ({ ...store.call('accounts', undefined)[0]!, remoteId: platform.remoteId }),
    () => {}
  )
  const writes = () => calls.filter((call) => call.operation.startsWith('favorite'))
  return { store, service, scope, platform, calls, writes }
}
afterEach(() => {
  for (const store of stores.splice(0)) store.call('close', undefined)
  for (const root of roots.splice(0)) {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()))
    expect(basename(root)).toMatch(/^mylike-favorite-actions-/)
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
it('only reads on open, then confirms remote collection and multiple folders locally without touching likes or other accounts', async () => {
  const { service, scope, store, writes } = setup()
  const editor = await service.open(scope)
  expect(editor).toMatchObject({
    collected: false,
    folders: [
      { id: '9007199254740993999', private: true },
      { id: '8', private: false }
    ]
  })
  expect(writes()).toHaveLength(0)
  await expect(service.save('a', editor.token, ['8', '9007199254740993999'])).resolves.toEqual({
    collected: true,
    foldersAdded: 2
  })
  expect(writes().map((call) => call.operation)).toEqual([
    'favoriteAdd',
    'favoriteFolderAdd',
    'favoriteFolderAdd'
  ])
  expect(writes()[0]!.parameters.aweme_type).toBe('68')
  expect(store.call('favoriteStatus', { accountId: 'a', workId: scope.workId }).collected).toBe(true)
  expect(store.call('favoriteStatus', { accountId: 'b', workId: scope.workId }).collected).toBe(false)
  expect(store.call('libraryOverview', { accountId: 'a' })).toMatchObject({
    likes: 2,
    favorites: 1,
    overlap: 1
  })
  expect(store.call('favoriteFolders', { accountId: 'a' }).map((folder) => folder.localCount)).toEqual([1, 1])
  expect(store.call('checkDatabase', {})).toMatchObject({ ok: true })
})

it('blocks a conflicting collect editor until an unknown uncollect has been verified', async () => {
  const { service, scope, store, calls } = setup(true)
  const editor = await service.open(scope)
  store.call('unlikeCreate', {
    accountId: 'a',
    id: 'remove',
    mode: 'single',
    source: 'favorites',
    workIds: [scope.workId]
  })
  store.call('unlikeReserve', { accountId: 'a', taskId: 'remove', workId: scope.workId })
  store.call('unlikeFinish', {
    accountId: 'a',
    taskId: 'remove',
    workId: scope.workId,
    status: 'unknown',
    reason: null,
    errorCode: 'TIMEOUT'
  })
  store.call('unlikeUpdate', { accountId: 'a', taskId: 'remove', status: 'paused', reason: null })
  calls.length = 0
  await expect(service.open(scope)).rejects.toThrow(/重新核验/)
  await expect(service.save('a', editor.token, ['8'])).rejects.toThrow(/重新核验/)
  expect(calls).toHaveLength(0)
  store.call('unlikeResolve', { accountId: 'a', taskId: 'remove', workId: scope.workId, liked: true })
  await expect(service.open(scope)).resolves.toMatchObject({ collected: true })
})
it('supports default-only collection and does not resend collection when a fresh detail already confirms it', async () => {
  const { service, scope, platform, store, writes } = setup()
  let editor = await service.open(scope)
  await service.save('a', editor.token, [])
  expect(writes()).toHaveLength(1)
  platform.collected = true
  editor = await service.open(scope)
  await service.save('a', editor.token, ['8'])
  expect(writes().map((call) => call.operation)).toEqual(['favoriteAdd', 'favoriteFolderAdd'])
  editor = await service.open(scope)
  await service.save('a', editor.token, [])
  expect(store.call('favoriteFolders', { accountId: 'a' })[0]?.localCount).toBe(1)
})
it('keeps a previously confirmed collection when a folder write times out and invalidates the editor instead of retrying', async () => {
  const { service, scope, platform, store, writes } = setup()
  const editor = await service.open(scope)
  platform.failure = 'favoriteFolderAdd'
  await expect(service.save('a', editor.token, ['8'])).rejects.toThrow(/作品已收藏.*未自动重发/)
  expect(writes()).toHaveLength(2)
  expect(store.call('favoriteStatus', { accountId: 'a', workId: scope.workId }).collected).toBe(true)
  expect(store.call('favoriteFolders', { accountId: 'a' })).toHaveLength(0)
  await expect(service.save('a', editor.token, ['8'])).rejects.toMatchObject({ code: 'EDITOR_EXPIRED' })
  expect(writes()).toHaveLength(2)
})
it('uses a fresh read to recover a collection accepted remotely during a lost response without a duplicate collection POST', async () => {
  const { service, scope, platform, store, writes } = setup()
  const editor = await service.open(scope)
  platform.failure = 'favoriteAdd'
  platform.confirmedDespiteFailure = true
  await expect(service.save('a', editor.token, [])).rejects.toThrow(/未自动重发/)
  expect(store.call('favoriteStatus', { accountId: 'a', workId: scope.workId }).collected).toBe(false)
  platform.failure = ''
  const refreshed = await service.open(scope)
  expect(refreshed.collected).toBe(true)
  await service.save('a', refreshed.token, [])
  expect(writes()).toHaveLength(1)
  expect(store.call('favoriteStatus', { accountId: 'a', workId: scope.workId }).collected).toBe(true)
})
it('refuses a changed account identity, switched work and deleted target folder before writing', async () => {
  const { service, scope, platform, store, writes } = setup()
  const editor = await service.open(scope)
  platform.remoteId = 'remote-b'
  await expect(service.save('a', editor.token, [])).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' })
  platform.remoteId = 'remote-a'
  platform.folders = []
  await expect(service.save('a', editor.token, ['8'])).rejects.toMatchObject({ code: 'FOLDER_CHANGED' })
  store.call('queueMove', { accountId: 'a', queueId: scope.queueId, target: 0 })
  await expect(service.save('a', editor.token, [])).rejects.toMatchObject({ code: 'QUEUE_CHANGED' })
  expect(writes()).toHaveLength(0)
})
it('creates a private folder on the platform and locally, and adds the work only when save is requested', async () => {
  const { service, scope, store, writes } = setup()
  const editor = await service.open(scope)
  const folder = await service.createFolder('a', editor.token, '新的收藏夹', true)
  expect(folder).toMatchObject({ id: '9', title: '新的收藏夹', private: true })
  expect(writes()[0]).toMatchObject({
    operation: 'favoriteFolderCreate',
    parameters: { action: '1', secret: '1' }
  })
  expect(store.call('favoriteStatus', { accountId: 'a', workId: scope.workId }).collected).toBe(false)
  expect(store.call('favoriteFolders', { accountId: 'a' })).toMatchObject([{ id: '9', localCount: 0 }])
  await expect(service.createFolder('a', editor.token, '新的收藏夹', true)).rejects.toMatchObject({
    code: 'FOLDER_EXISTS'
  })
  await service.save('a', editor.token, ['9'])
  expect(store.call('favoriteFolders', { accountId: 'a' })).toMatchObject([{ id: '9', localCount: 1 }])
})
it('does not repeat an unconfirmed folder creation and requires the list to be reloaded', async () => {
  const { service, scope, platform, writes } = setup()
  const editor = await service.open(scope)
  platform.failure = 'favoriteFolderCreate'
  await expect(service.createFolder('a', editor.token, '新的收藏夹', false)).rejects.toMatchObject({
    code: 'WRITE_UNCONFIRMED'
  })
  await expect(service.createFolder('a', editor.token, '新的收藏夹', false)).rejects.toMatchObject({
    code: 'EDITOR_EXPIRED'
  })
  expect(writes()).toHaveLength(1)
})
it('waits for an already sent bounded write during shutdown and blocks double submission', async () => {
  const { service, scope, platform, writes } = setup()
  const editor = await service.open(scope)
  let release!: () => void
  platform.hold = () =>
    new Promise<void>((resolve) => {
      release = resolve
    })
  const saving = service.save('a', editor.token, [])
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1))
  expect(() => service.save('a', editor.token, [])).toThrow(/正在保存/)
  let idle = false
  const waiting = service.idle().then(() => {
    idle = true
  })
  await Promise.resolve()
  expect(idle).toBe(false)
  release()
  await saving
  await waiting
  expect(idle).toBe(true)
  expect(writes()).toHaveLength(1)
})
it('stops after the current acknowledged write without sending remaining folders when shutdown starts', async () => {
  const { service, scope, platform, store, writes } = setup()
  const editor = await service.open(scope)
  let release!: () => void
  platform.hold = () =>
    new Promise<void>((resolve) => {
      release = resolve
    })
  const saving = service.save('a', editor.token, ['8'])
  const outcome = expect(saving).rejects.toMatchObject({ code: 'CANCELLED' })
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1))
  const stopping = service.idle(true)
  release()
  await outcome
  await stopping
  expect(writes().map((call) => call.operation)).toEqual(['favoriteAdd'])
  expect(store.call('favoriteStatus', { accountId: 'a', workId: scope.workId }).collected).toBe(true)
})
it('preserves confirmed folder membership if a paused older synchronization later finishes', async () => {
  const { service, scope, store } = setup()
  let task = store.call('favoritesStart', { accountId: 'a', id: 'sync' })
  const save = (items: any[], folders?: any[]) => {
    task = store.call('favoritesSave', {
      accountId: 'a',
      remoteId: 'remote-a',
      taskId: 'sync',
      stage: task.stage,
      folderId: task.folderId,
      requestCursor: task.cursor,
      cursor: '0',
      hasMore: false,
      items,
      folders
    })
  }
  save([])
  save([], [{ id: '8', title: '音乐', remoteCount: 0 }])
  store.call('favoritesUpdate', { accountId: 'a', taskId: 'sync', status: 'paused', reason: null })
  const editor = await service.open(scope)
  await service.save('a', editor.token, ['8'])
  store.call('favoritesUpdate', { accountId: 'a', taskId: 'sync', status: 'running', reason: null })
  save([])
  expect(store.call('favoriteFolders', { accountId: 'a' })).toMatchObject([{ id: '8', localCount: 1 }])
})
