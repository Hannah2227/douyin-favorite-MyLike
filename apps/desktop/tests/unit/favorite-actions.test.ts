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
const localFolder = (store: Store, id: string, title: string, privateFolder: boolean) =>
  store.call('favoriteLocalFolderCreate', {
    accountId: 'a',
    remoteId: 'remote-a',
    id,
    title,
    private: privateFolder,
    queueWrite: false
  })
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
    folderWorkIds: [work.id, '2'],
    unavailableWorkIds: [] as string[],
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
        if (operation === 'detail') {
          const detailId = parameters.aweme_id ?? work.id
          if (platform.unavailableWorkIds.includes(detailId))
            return {
              status_code: 0,
              aweme_detail: null,
              filter_detail: { aweme_id: detailId, filter_reason: 'core_dep', detail_msg: '' }
            }
          return {
            aweme_detail: {
              aweme_id: work.id,
              desc: work.title,
              collect_stat: platform.collected ? 1 : 0,
              aweme_type: 68,
              images: [{ url_list: [] }]
            }
          }
        }
        if (operation === 'folders') return { collects_list: platform.folders, has_more: 0, cursor: '0' }
        if (operation === 'folderItems')
          return {
            aweme_list: platform.folderWorkIds.map((id) => ({
              aweme_id: id,
              desc: id === work.id ? work.title : '另一件收藏作品',
              author: { nickname: work.author }
            })),
            has_more: 0,
            cursor: '0'
          }
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
it('only reads on open, then syncs remote collection and multiple folders while saving locally', async () => {
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
  expect(store.call('favoriteWriteOps', { accountId: 'a' })).toHaveLength(0)
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
it('sends the default collection once and does not resend it when a fresh detail already confirms it', async () => {
  const { service, scope, platform, store, writes } = setup()
  let editor = await service.open(scope)
  await service.save('a', editor.token, [])
  expect(writes().map((call) => call.operation)).toEqual(['favoriteAdd'])
  expect(store.call('favoriteWriteOps', { accountId: 'a' })).toHaveLength(0)
  platform.collected = true
  editor = await service.open(scope)
  await service.save('a', editor.token, ['8'])
  expect(writes().map((call) => call.operation)).toEqual(['favoriteAdd', 'favoriteFolderAdd'])
  expect(store.call('favoriteWriteOps', { accountId: 'a' })).toHaveLength(0)
  editor = await service.open(scope)
  await service.save('a', editor.token, [])
  expect(store.call('favoriteFolders', { accountId: 'a' })[0]?.localCount).toBe(1)
})
it('retains queued local-folder operations when an explicit writeback fails', async () => {
  const { service, scope, platform, store, writes } = setup()
  store.call('appPreferences', { preferences: { syncFavoritesToCloud: true } })
  const editor = await service.open(scope)
  const folder = localFolder(store, 'local-pending', '待写回', true)
  await service.save('a', editor.token, [folder.id])
  platform.failure = 'favoriteFolderAdd'
  await expect(service.syncToCloud('a', () => {})).rejects.toThrow(/未自动重试/)
  expect(writes().some((call) => call.operation === 'favoriteFolderAdd')).toBe(true)
  expect(store.call('favoriteStatus', { accountId: 'a', workId: scope.workId }).collected).toBe(true)
  expect(store.call('favoriteWriteOps', { accountId: 'a' }).map((operation) => operation.kind)).toEqual([
    'folder-add'
  ])
})
it('does not send a default favorite when the platform already reports it as collected', async () => {
  const { service, scope, platform, store, writes } = setup()
  platform.collected = true
  const editor = await service.open(scope)
  await service.save('a', editor.token, [])
  await service.syncToCloud('a', () => {})
  expect(writes().filter((call) => call.operation === 'favoriteAdd')).toHaveLength(0)
  expect(store.call('favoriteWriteOps', { accountId: 'a' })).toHaveLength(0)
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
it('verifies favorite folders against the live remote list before presenting them', async () => {
  const { service, store } = setup()
  store.call('favoriteRememberFolder', {
    accountId: 'a',
    remoteId: 'remote-a',
    folder: { id: 'stale', title: '已删除的收藏夹', remoteCount: 3, localCount: 0 }
  })

  const folders = await service.refreshFolders('a')

  expect(folders.map(({ id, title }) => ({ id, title }))).toEqual([
    { id: '9007199254740993999', title: '旅行' },
    { id: '8', title: '音乐' }
  ])
})
it('preserves local folder management and hides a deleted cloud-linked folder on remote refresh', async () => {
  const { service, store } = setup()
  const folder = store.call('favoriteLocalFolderCreate', {
    accountId: 'a',
    remoteId: 'remote-a',
    id: 'local-managed',
    title: '原名称',
    private: true,
    queueWrite: false
  })
  store.call('favoriteLinkFolder', {
    accountId: 'a',
    folderId: folder.id,
    remoteId: '8',
    title: folder.title,
    private: true
  })
  store.call('favoriteLocalFolderEdit', {
    accountId: 'a',
    folderId: folder.id,
    title: '本机名称'
  })

  expect(await service.refreshFolders('a')).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: folder.id,
        title: '本机名称',
        managedLocally: true,
        localOnly: false
      })
    ])
  )

  store.call('favoriteLocalFolderDelete', { accountId: 'a', folderId: folder.id })
  expect(await service.refreshFolders('a')).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: folder.id })])
  )
})
it('creates a cloud folder directly from the video view', async () => {
  const { service, scope, store, writes } = setup()
  const editor = await service.open(scope)
  const folder = await service.createFolder('a', editor.token, '新的收藏夹', true)
  expect(folder).toMatchObject({ title: '新的收藏夹', private: true, localOnly: false, remoteId: '9' })
  expect(folder.id).toMatch(/^local-/)
  expect(writes().map((call) => call.operation)).toEqual(['favoriteFolderCreate'])
  expect(store.call('favoriteWriteOps', { accountId: 'a' })).toHaveLength(0)
  expect(store.call('favoriteStatus', { accountId: 'a', workId: scope.workId }).collected).toBe(false)
  expect(store.call('favoriteFolders', { accountId: 'a' })).toMatchObject([
    { id: folder.id, localCount: 0, localOnly: false, remoteId: '9' }
  ])
  await expect(service.createFolder('a', editor.token, '新的收藏夹', true)).rejects.toMatchObject({
    code: 'FOLDER_EXISTS'
  })
  await service.save('a', editor.token, [folder.id])
  expect(writes().map((call) => call.operation)).toEqual([
    'favoriteFolderCreate',
    'favoriteAdd',
    'favoriteFolderAdd'
  ])
  expect(store.call('favoriteFolders', { accountId: 'a' })).toMatchObject([
    { id: folder.id, localCount: 1, localOnly: false }
  ])
})
it('syncs the default favorite immediately and local folder membership only on explicit writeback', async () => {
  const { service, scope, store, platform, writes } = setup()
  store.call('appPreferences', { preferences: { syncFavoritesToCloud: true } })
  const editor = await service.open(scope)
  const folder = localFolder(store, 'local-writeback', '待写回', true)
  await service.save('a', editor.token, [folder.id])

  expect(writes().map((call) => call.operation)).toEqual(['favoriteAdd'])
  await expect(service.syncToCloud('a', () => {})).resolves.toMatchObject({
    synced: 2,
    remaining: 0,
    skipped: 0
  })

  expect(writes().map((call) => call.operation)).toEqual([
    'favoriteAdd',
    'favoriteFolderCreate',
    'favoriteFolderAdd'
  ])
  expect(writes()[2]?.parameters.to_collects_id).toBe('9')
  expect(platform.folders.some((entry) => entry.collects_id_str === '9')).toBe(true)
  expect(store.call('favoriteFolders', { accountId: 'a' })).toMatchObject([
    { id: folder.id, remoteId: '9', localOnly: false, localCount: 1 }
  ])
})
it('writes only selected local folders while retaining unselected folder operations', async () => {
  const { service, scope, store, writes } = setup()
  store.call('appPreferences', { preferences: { syncFavoritesToCloud: true } })
  const editor = await service.open(scope)
  const first = localFolder(store, 'local-甲', '甲', true)
  const second = localFolder(store, 'local-乙', '乙', true)
  await service.save('a', editor.token, [first.id, second.id])
  expect(writes().map((call) => call.operation)).toEqual(['favoriteAdd'])
  const folderPending = (id: string) =>
    store.call('favoriteFolders', { accountId: 'a' }).find((folder) => folder.id === id)?.pendingWrites
  expect(folderPending(first.id)).toBeGreaterThan(0)
  expect(folderPending(second.id)).toBeGreaterThan(0)

  await expect(
    service.syncToCloud('a', () => {}, { folderIds: [first.id], includeDefault: false })
  ).resolves.toMatchObject({ synced: 2, remaining: 2, skipped: 0 })

  expect(folderPending(first.id)).toBe(0)
  expect(folderPending(second.id)).toBeGreaterThan(0)
  expect(writes().map((call) => call.operation)).toEqual([
    'favoriteAdd',
    'favoriteFolderCreate',
    'favoriteFolderAdd'
  ])
  expect(store.call('favoriteWriteOps', { accountId: 'a' }).map((operation) => operation.folderId)).toEqual([
    second.id,
    second.id
  ])
  expect(store.call('favoriteWritePending', { accountId: 'a' })).toBe(2)
})
it('keeps edits created while writeback is disabled local after later enabling it', async () => {
  const { store, writes } = setup()
  const folder = localFolder(store, 'local-仅本地', '仅本地', false)
  store.call('appPreferences', { preferences: { syncFavoritesToCloud: true } })
  expect(store.call('favoriteWriteOps', { accountId: 'a' })).toHaveLength(0)
  expect(store.call('favoriteWritePending', { accountId: 'a' })).toBe(1)
  expect(writes()).toHaveLength(0)
  expect(folder.localOnly).toBe(true)
})
it('stages local folder additions made while writeback was disabled after enabling it', async () => {
  const { service, scope, store, writes } = setup()
  const editor = await service.open(scope)
  const folder = localFolder(store, 'local-仅本地', '仅本地', true)
  await service.save('a', editor.token, [folder.id])

  expect(writes().map((call) => call.operation)).toEqual(['favoriteAdd'])
  expect(store.call('favoriteWriteOps', { accountId: 'a' })).toHaveLength(0)
  expect(store.call('favoriteWritePending', { accountId: 'a' })).toBe(2)

  store.call('appPreferences', { preferences: { syncFavoritesToCloud: true } })
  await expect(service.syncToCloud('a', () => {})).resolves.toMatchObject({
    synced: 2,
    remaining: 0,
    skipped: 0
  })

  expect(writes().map((call) => call.operation)).toEqual([
    'favoriteAdd',
    'favoriteFolderCreate',
    'favoriteFolderAdd'
  ])
  expect(store.call('favoriteWritePending', { accountId: 'a' })).toBe(0)
  expect(store.call('favoriteStatus', { accountId: 'a', workId: scope.workId }).collected).toBe(true)
})
it('writes local-only folders and their contents after an explicit writeback click', async () => {
  const { service, scope, store, writes } = setup(true)
  const editor = await service.open(scope)
  const folder = localFolder(store, 'local-之前仅本地', '之前仅本地', true)
  await service.save('a', editor.token, [folder.id])

  expect(store.call('favoriteWriteOps', { accountId: 'a' })).toHaveLength(0)
  expect(store.call('favoriteWritePending', { accountId: 'a' })).toBe(2)
  await expect(service.syncToCloud('a', () => {})).resolves.toMatchObject({
    synced: 2,
    remaining: 0,
    skipped: 0
  })

  expect(writes().map((call) => call.operation)).toEqual(['favoriteFolderCreate', 'favoriteFolderAdd'])
  expect(store.call('favoriteFolders', { accountId: 'a' })).toMatchObject([
    { id: folder.id, remoteId: '9', localOnly: false, localCount: 1 }
  ])
})
it('renames a cloud-linked folder on both the cloud and locally', async () => {
  const { service, store, writes } = setup()
  const folder = localFolder(store, 'local-rename', '旧名称', true)
  store.call('favoriteLinkFolder', {
    accountId: 'a',
    folderId: folder.id,
    remoteId: '8',
    title: '旧名称',
    private: true
  })

  const updated = await service.renameFolder('a', folder.id, '新名称')

  expect(updated).toMatchObject({ title: '新名称', remoteId: '8', localOnly: false })
  expect(writes().map((call) => call.operation)).toEqual(['favoriteFolderCreate'])
  expect(writes()[0]?.parameters).toMatchObject({ action: '2', collects_id: '8', collects_name: '新名称' })
  expect(store.call('favoriteFolders', { accountId: 'a' })).toMatchObject([
    expect.objectContaining({ id: folder.id, title: '新名称' })
  ])
})
it('renames a local-only folder without touching the cloud', async () => {
  const { service, store, writes } = setup()
  const folder = localFolder(store, 'local-rename-local', '旧名称', true)

  const updated = await service.renameFolder('a', folder.id, '新名称')

  expect(updated).toMatchObject({ title: '新名称', localOnly: true })
  expect(writes()).toHaveLength(0)
})
it('removes selected works from a cloud folder while keeping the default favorite', async () => {
  const { service, store, writes } = setup(true)
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work,
    folder: { id: '8', title: '音乐', remoteCount: 2, localCount: 0 }
  })

  const result = await service.removeFromFolder('a', '8', [work.id])

  expect(result).toEqual({ folderId: '8', folderTitle: '音乐', removed: 1 })
  expect(writes().map((call) => call.operation)).toEqual(['favoriteFolderRemove'])
  expect(store.call('favoriteStatus', { accountId: 'a', workId: work.id }).collected).toBe(true)
  expect(
    store.call('query', {
      accountId: 'a',
      source: 'favorites',
      folderId: '8',
      search: '',
      mediaType: 'all',
      year: null,
      month: null,
      sort: 'published',
      offset: 0,
      limit: 60
    }).total
  ).toBe(0)
})
it('removes selected works from a local-only folder without a cloud request', async () => {
  const { service, store, writes } = setup(true)
  const folder = localFolder(store, 'local-remove', '仅本地', true)
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work,
    folder
  })

  const result = await service.removeFromFolder('a', folder.id, [work.id])

  expect(result).toEqual({ folderId: folder.id, folderTitle: '仅本地', removed: 1 })
  expect(writes()).toHaveLength(0)
  expect(
    store.call('favoriteFolders', { accountId: 'a' }).find((entry) => entry.id === folder.id)
  ).toMatchObject({
    localCount: 0
  })
})
it('skips works that the platform confirms are unavailable and clears their queued writes', async () => {
  const { service, store, platform, writes } = setup()
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work,
    favoriteAddIntent: true,
    queueFavoriteAdd: true
  })
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work,
    folder: { id: '8', title: '音乐', remoteCount: 0, localCount: 0 },
    queueWrite: true
  })
  platform.unavailableWorkIds = [work.id]

  await expect(service.syncToCloud('a', () => {})).resolves.toMatchObject({
    synced: 0,
    remaining: 0,
    skipped: 1,
    skippedItems: [{ workId: work.id, kind: 'favorite-add' }]
  })
  expect(writes().some((call) => call.operation === 'favoriteAdd')).toBe(false)
  expect(writes().some((call) => call.operation === 'favoriteFolderAdd')).toBe(false)
  expect(store.call('favoriteWritePending', { accountId: 'a' })).toBe(0)
})
it('writes locally saved folder items missing from cloud even when no write is pending', async () => {
  const { service, platform, store, writes } = setup()
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work,
    folder: { id: '8', title: '音乐', remoteCount: 1, localCount: 0 }
  })
  store.call('favoriteQueueWrite', {
    accountId: 'a',
    remoteId: 'remote-a',
    kind: 'folder-add',
    folderId: '8',
    workId: work.id
  })
  const [operation] = store.call('favoriteWriteOps', { accountId: 'a' })
  if (!operation) throw new Error('Expected the folder addition to be queued.')
  store.call('favoriteWriteComplete', { accountId: 'a', operationId: operation.id })
  platform.folderWorkIds = []

  expect(store.call('favoriteWritePending', { accountId: 'a' })).toBe(0)
  await expect(
    service.syncToCloud('a', () => {}, { folderIds: ['8'], includeDefault: false })
  ).resolves.toMatchObject({ synced: 2, remaining: 0, skipped: 0 })

  expect(writes().map((call) => call.operation)).toEqual(['favoriteAdd', 'favoriteFolderAdd'])
  expect(store.call('favoriteWritePending', { accountId: 'a' })).toBe(0)
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
