import { randomUUID } from 'node:crypto'
import type { Account, FavoriteEditor, FavoriteFolder, PlaybackScope } from '../shared/contracts'
import type { Database } from './storage/client'
import type { DouyinEngine } from './douyin/engine'
import {
  parseFavoriteState,
  parseFavoriteFolders,
  parseFavoriteFolder,
  parseFavoritesPage,
  parseWriteResult
} from './douyin/parse'
import { AppError } from './errors'

type Scope = PlaybackScope & { workId: string }
type Run = <T>(accountId: string, action: (check: () => void) => Promise<T>) => Promise<T>
type Editor = { scope: Scope; remoteId: string; expires: number; folders: FavoriteFolder[] }

/** Explicit, additive writes only. Never replay a write as an authentication probe or network retry. */
export class FavoriteActions {
  private editors = new Map<string, Editor>()
  private writes = new Set<Promise<unknown>>()
  private locked = new Set<string>()
  private writeEpoch = 0
  constructor(
    private readonly db: Pick<Database, 'call'>,
    private readonly engine: Pick<DouyinEngine, 'request'>,
    private readonly run: Run,
    private readonly identity: (accountId: string, check: () => void) => Promise<Account>,
    private readonly changed: () => void
  ) {}
  async idle(stop = false): Promise<void> {
    if (stop) this.writeEpoch++
    await Promise.allSettled([...this.writes])
  }
  private async guard(scope: Scope, check: () => void): Promise<void> {
    check()
    const queue = await this.db.call('queueState', { accountId: scope.accountId })
    if (
      !queue ||
      queue.queueId !== scope.queueId ||
      queue.revision !== scope.revision ||
      queue.work.id !== scope.workId
    )
      throw new AppError('QUEUE_CHANGED', '播放作品已变化，请为当前作品重新打开收藏。')
    await this.db.call('favoriteWriteGuard', { accountId: scope.accountId, workId: scope.workId })
    check()
  }
  private async folders(accountId: string, check: () => void, remoteId = ''): Promise<FavoriteFolder[]> {
    const local = await this.db.call('favoriteFolders', { accountId })
    const byRemoteId = new Map(local.map((folder) => [folder.remoteId ?? folder.id, folder]))
    const hiddenRemoteIds = new Set(await this.db.call('favoriteHiddenFolderIds', { accountId }))
    const result = new Map<string, FavoriteFolder>(),
      visited = new Set<string>()
    let cursor = '0'
    for (let page = 0; page < 100; page++) {
      check()
      const data = parseFavoriteFolders(
        await this.engine.request(accountId, 'folders', {
          cursor,
          count: '20',
          ...(remoteId ? { sec_user_id: remoteId } : {})
        })
      )
      check()
      for (const folder of data.folders) {
        if (hiddenRemoteIds.has(folder.id)) continue
        const known = byRemoteId.get(folder.id)
        const mapped = {
          ...folder,
          title: known?.managedLocally ? known.title : folder.title,
          id: known?.id ?? folder.id,
          remoteId: folder.id,
          localOnly: false,
          managedLocally: known?.managedLocally ?? false,
          localCount: known?.localCount ?? 0
        }
        result.set(mapped.id, mapped)
      }
      if (!data.hasMore) {
        for (const folder of local.filter((entry) => entry.localOnly)) result.set(folder.id, folder)
        return [...result.values()]
      }
      visited.add(cursor)
      if (visited.has(data.cursor))
        throw new AppError('CURSOR_STALLED', '收藏夹列表游标重复，请稍后重新读取。')
      cursor = data.cursor
    }
    throw new AppError('TOO_MANY_FOLDERS', '收藏夹列表过长，本次未完整读取，未发送收藏请求。')
  }
  async refreshFolders(accountId: string): Promise<FavoriteFolder[]> {
    return this.run(accountId, async (check) => {
      const account = await this.identity(accountId, check)
      if (!account.remoteId) throw new AppError('AUTH_REQUIRED', '请先登录并核验账号。')
      const folders = await this.folders(accountId, check, account.remoteId)
      check()
      return folders
    })
  }
  private async remoteFolderWorkIds(
    accountId: string,
    remoteFolderId: string,
    check: () => void
  ): Promise<Set<string>> {
    const workIds = new Set<string>()
    const visited = new Set<string>()
    let cursor = '0'
    for (let pageNumber = 0; pageNumber < 1000; pageNumber++) {
      check()
      if (visited.has(cursor)) throw new AppError('CURSOR_STALLED', '收藏夹分页游标重复，未继续写回。')
      visited.add(cursor)
      const page = parseFavoritesPage(
        await this.engine.request(accountId, 'folderItems', {
          collects_id: remoteFolderId,
          cursor,
          count: '20'
        })
      )
      check()
      if (page.skipped.length)
        throw new AppError('INVALID_ITEMS', '云端收藏夹包含无法读取的作品，已停止写回以避免遗漏。')
      for (const work of page.items) workIds.add(work.id)
      if (!page.hasMore) return workIds
      cursor = page.cursor
    }
    throw new AppError('TOO_MANY_ITEMS', '收藏夹分页过多，已停止写回。')
  }
  async open(scope: Scope): Promise<FavoriteEditor> {
    return this.run(scope.accountId, async (check) => {
      await this.guard(scope, check)
      const account = await this.identity(scope.accountId, check)
      if (!account.remoteId) throw new AppError('AUTH_REQUIRED', '请先登录并核验账号。')
      const state = parseFavoriteState(
        await this.engine.request(scope.accountId, 'detail', { aweme_id: scope.workId }),
        scope.workId
      )
      const folders = await this.folders(scope.accountId, check, account.remoteId ?? '')
      await this.guard(scope, check)
      // A read can confirm an existing remote collection without inventing folder memberships.
      if (state.collected) {
        await this.db.call('favoriteConfirm', {
          accountId: scope.accountId,
          remoteId: account.remoteId,
          work: state.work
        })
        this.changed()
      }
      for (const [token, editor] of this.editors) {
        if (editor.expires < Date.now() || editor.scope.accountId === scope.accountId)
          this.editors.delete(token)
      }
      const token = randomUUID()
      this.editors.set(token, {
        scope: { ...scope },
        remoteId: account.remoteId,
        expires: Date.now() + 10 * 60_000,
        folders
      })
      const overview = await this.db.call('libraryOverview', { accountId: scope.accountId })
      return {
        token,
        accountId: scope.accountId,
        workId: scope.workId,
        collected: state.collected,
        localCount: overview.favorites,
        folders
      }
    })
  }
  private editor(accountId: string, token: string): Editor {
    const editor = this.editors.get(token)
    if (!editor || editor.scope.accountId !== accountId || editor.expires < Date.now())
      throw new AppError('EDITOR_EXPIRED', '收藏选择已失效，请重新读取后再保存。')
    return editor
  }
  private write<T>(token: string, action: () => Promise<T>): Promise<T> {
    if (this.locked.has(token)) throw new AppError('BUSY', '收藏操作正在保存，请等待结果。')
    this.locked.add(token)
    const promise = action().finally(() => {
      this.writes.delete(promise)
      this.locked.delete(token)
    })
    this.writes.add(promise)
    return promise
  }
  save(
    accountId: string,
    token: string,
    folderIds: string[]
  ): Promise<{ collected: true; foldersAdded: number }> {
    const epoch = this.writeEpoch
    return this.write(token, () =>
      this.run(accountId, async (check) => {
        const valid = () => {
          check()
          if (epoch !== this.writeEpoch)
            throw new AppError('CANCELLED', '后续收藏操作已停止，已确认的结果保留。')
        }
        const editor = this.editor(accountId, token)
        await this.guard(editor.scope, valid)
        const account = await this.identity(accountId, check)
        if (account.remoteId !== editor.remoteId)
          throw new AppError('IDENTITY_MISMATCH', '当前抖音身份已变化，未发送收藏请求。')
        const state = parseFavoriteState(
          await this.engine.request(accountId, 'detail', { aweme_id: editor.scope.workId }),
          editor.scope.workId
        )
        const folders = await this.folders(accountId, valid, account.remoteId ?? '')
        const targets = [...new Set(folderIds)].map((id) => {
          const folder = folders.find((entry) => entry.id === id)
          if (!folder) throw new AppError('FOLDER_CHANGED', '所选收藏夹已变化，请重新读取后再保存。')
          return folder
        })
        const preferences = await this.db.call('appPreferences', {})
        let inflight = false,
          collected = state.collected,
          foldersAdded = 0
        try {
          await this.guard(editor.scope, valid)
          if (!collected) {
            inflight = true
            parseWriteResult(
              await this.engine.request(accountId, 'favoriteAdd', {
                aweme_id: state.work.id,
                aweme_type: state.type
              })
            )
            inflight = false
            collected = true
          }
          await this.db.call('favoriteConfirm', {
            accountId,
            remoteId: editor.remoteId,
            work: state.work,
            favoriteAddIntent: !state.collected,
            synced: true
          })
          this.changed()
          for (const folder of targets) {
            if (folder.localOnly) {
              // Locally created folders stay local until an explicit writeback
              // when the user allows cloud writeback.
              await this.db.call('favoriteConfirm', {
                accountId,
                remoteId: editor.remoteId,
                work: state.work,
                folder,
                queueWrite: preferences.syncFavoritesToCloud
              })
              foldersAdded++
              this.changed()
              continue
            }
            await this.guard(editor.scope, valid)
            inflight = true
            parseWriteResult(
              await this.engine.request(accountId, 'favoriteFolderAdd', {
                aweme_id: state.work.id,
                item_ids: state.work.id,
                item_type: '2',
                to_collects_id: folder.remoteId ?? folder.id,
                collects_name: folder.title,
                update_collects_sort: 'true'
              })
            )
            inflight = false
            await this.db.call('favoriteConfirm', {
              accountId,
              remoteId: editor.remoteId,
              work: state.work,
              folder: { ...folder, remoteCount: folder.remoteCount + 1 },
              synced: true
            })
            foldersAdded++
            this.changed()
          }
          this.editors.delete(token)
          return { collected: true, foldersAdded }
        } catch (error) {
          this.editors.delete(token)
          const code = error instanceof AppError ? error.code : 'STORAGE_ERROR'
          throw new AppError(
            code,
            `${collected ? '作品已收藏，已确认的结果已同步到本地。' : ''}${
              inflight && code !== 'API_REJECTED'
                ? '部分操作结果未确认，未自动重发；请重新读取，并在抖音原页核对。'
                : error instanceof AppError
                  ? error.message
                  : '本地保存未完成，请重新读取核对。'
            }`
          )
        }
      })
    )
  }
  createFolder(accountId: string, token: string, name: string, secret: boolean): Promise<FavoriteFolder> {
    return this.write(token, () =>
      this.run(accountId, async (check) => {
        const editor = this.editor(accountId, token)
        await this.guard(editor.scope, check)
        const account = await this.identity(accountId, check)
        if (account.remoteId !== editor.remoteId)
          throw new AppError('IDENTITY_MISMATCH', '当前抖音身份已变化，收藏夹未创建。')
        const existing = await this.folders(accountId, check, account.remoteId ?? '')
        if (existing.some((folder) => folder.title === name))
          throw new AppError('FOLDER_EXISTS', '已有同名收藏夹，请直接选择。')
        await this.guard(editor.scope, check)
        // A folder created from the video view is a real cloud collection. Create
        // it on the platform first, then link a local record so the following
        // save adds the work to that cloud folder immediately.
        const response = await this.engine.request(accountId, 'favoriteFolderCreate', {
          action: '1',
          collects_name: name,
          secret: secret ? '1' : '0'
        })
        parseWriteResult(response)
        const remote = { ...parseFavoriteFolder(response.collects_info), localCount: 0 }
        const id = `local-${randomUUID()}`
        await this.db.call('favoriteLocalFolderCreate', {
          accountId,
          remoteId: editor.remoteId,
          id,
          title: name,
          private: secret,
          queueWrite: false
        })
        await this.db.call('favoriteLinkFolder', {
          accountId,
          folderId: id,
          remoteId: remote.remoteId ?? remote.id,
          title: remote.title,
          remoteCount: remote.remoteCount,
          private: remote.private
        })
        const folder = (await this.db.call('favoriteFolders', { accountId })).find(
          (entry) => entry.id === id
        )!
        editor.folders.unshift(folder)
        this.changed()
        return folder
      })
    )
  }
  async renameFolder(accountId: string, folderId: string, title: string): Promise<FavoriteFolder> {
    return this.run(accountId, async (check) => {
      const account = await this.identity(accountId, check)
      if (!account.remoteId) throw new AppError('AUTH_REQUIRED', '请先登录并核验账号。')
      const folders = await this.db.call('favoriteFolders', { accountId })
      const folder = folders.find((entry) => entry.id === folderId)
      if (!folder?.managedLocally)
        throw new AppError('LOCAL_FOLDER_ONLY', '只有本地创建的收藏夹可以在本机改名。')
      if (folders.some((entry) => entry.id !== folderId && entry.title === title))
        throw new AppError('FOLDER_EXISTS', '已有同名收藏夹，请选择其他名称。')
      // A locally managed folder that is already linked to a cloud collection keeps
      // its cloud name in sync. The maintain endpoint renames with action=2.
      if (folder.remoteId && !folder.localOnly) {
        parseWriteResult(
          await this.engine.request(accountId, 'favoriteFolderCreate', {
            action: '2',
            collects_id: folder.remoteId,
            collects_name: title
          })
        )
      }
      const updated = await this.db.call('favoriteLocalFolderEdit', { accountId, folderId, title })
      this.changed()
      return updated
    })
  }
  async removeFromFolder(
    accountId: string,
    folderId: string,
    workIds: string[]
  ): Promise<{ folderId: string; folderTitle: string; removed: number }> {
    return this.run(accountId, async (check) => {
      const account = await this.identity(accountId, check)
      if (!account.remoteId) throw new AppError('AUTH_REQUIRED', '请先登录并核验账号。')
      const folder = (await this.db.call('favoriteFolders', { accountId })).find(
        (entry) => entry.id === folderId
      )
      if (!folder) throw new AppError('FOLDER_CHANGED', '收藏夹已不存在，请重新读取。')
      const targets = [...new Set(workIds)]
      const cloud = !folder.localOnly && !!folder.remoteId
      let removed = 0
      try {
        for (const workId of targets) {
          check()
          if (cloud) {
            parseWriteResult(
              await this.engine.request(accountId, 'favoriteFolderRemove', {
                aweme_id: workId,
                item_ids: workId,
                item_type: '2',
                from_collects_id: folder.remoteId!,
                collects_name: folder.title
              })
            )
          }
          await this.db.call('favoriteForgetFolderWork', {
            accountId,
            remoteId: account.remoteId,
            folderId,
            workId
          })
          removed++
        }
      } catch (error) {
        this.changed()
        const code = error instanceof AppError ? error.code : 'WRITE_UNCONFIRMED'
        const message = error instanceof Error ? error.message : '移出收藏夹失败。'
        throw new AppError(code, `${removed ? `已从“${folder.title}”移出 ${removed} 条；` : ''}${message}`)
      }
      this.changed()
      return { folderId, folderTitle: folder.title, removed }
    })
  }
  async syncToCloud(
    accountId: string,
    check: () => void,
    scope?: { folderIds: string[]; includeDefault: boolean }
  ): Promise<{
    synced: number
    remaining: number
    skipped: number
    skippedItems: { workId: string; kind: string; reason: string }[]
  }> {
    const account = await this.identity(accountId, check)
    if (!account.remoteId) throw new AppError('AUTH_REQUIRED', '请先登录并核验抖音账号。')
    const folders = await this.db.call('favoriteFolders', { accountId })
    const folderIds = scope?.folderIds ?? folders.map((folder) => folder.id)
    const includeDefault = scope?.includeDefault ?? true
    if (!includeDefault && folderIds.length === 0)
      throw new AppError('INVALID_INPUT', '请选择要写回的收藏夹或默认收藏列表。')
    if (folderIds.some((id) => !folders.some((folder) => folder.id === id)))
      throw new AppError('FOLDER_CHANGED', '收藏夹列表已变化，请重新选择写回范围。')
    for (const folder of folders.filter((entry) => folderIds.includes(entry.id) && !entry.localOnly)) {
      const remoteFolderId = folder.remoteId ?? folder.id
      const [localWorkIds, remoteWorkIds] = await Promise.all([
        this.db.call('favoriteFolderWorkIds', { accountId, folderId: folder.id }),
        this.remoteFolderWorkIds(accountId, remoteFolderId, check)
      ])
      for (const workId of localWorkIds) {
        if (remoteWorkIds.has(workId)) continue
        await this.db.call('favoriteQueueWrite', {
          accountId,
          remoteId: account.remoteId,
          kind: 'favorite-add',
          workId
        })
        await this.db.call('favoriteQueueWrite', {
          accountId,
          remoteId: account.remoteId,
          kind: 'folder-add',
          folderId: folder.id,
          workId
        })
      }
    }
    await this.db.call('favoriteStageLocalFolders', {
      accountId,
      remoteId: account.remoteId,
      folderIds,
      includeDefault
    })
    const staged = await this.db.call('favoriteWriteOps', { accountId })
    const selected = new Set(folderIds)
    const selectedFolderWorks = new Set(
      staged
        .filter((operation) => operation.kind === 'folder-add' && selected.has(operation.folderId ?? ''))
        .map((operation) => operation.workId)
        .filter((workId): workId is string => !!workId)
    )
    const operations = staged.filter((operation) =>
      operation.kind === 'favorite-add'
        ? includeDefault || selectedFolderWorks.has(operation.workId ?? '')
        : selected.has(operation.folderId ?? '')
    )
    let synced = 0
    let skipped = 0
    const skippedWorkIds = new Set<string>()
    const skippedItems: { workId: string; kind: string; reason: string }[] = []
    for (const operation of operations) {
      check()
      if (operation.workId && skippedWorkIds.has(operation.workId)) {
        await this.db.call('favoriteWriteComplete', { accountId, operationId: operation.id })
        continue
      }
      try {
        if (operation.kind === 'favorite-add') {
          const state = parseFavoriteState(
            await this.engine.request(accountId, 'detail', { aweme_id: operation.workId! }),
            operation.workId!
          )
          check()
          if (!state.collected)
            parseWriteResult(
              await this.engine.request(accountId, 'favoriteAdd', {
                aweme_id: state.work.id,
                aweme_type: state.type
              })
            )
        } else if (operation.kind === 'folder-create') {
          const folders = await this.folders(accountId, check, account.remoteId ?? '')
          const existing = folders.find((folder) => !folder.localOnly && folder.title === operation.title)
          let remoteFolder: FavoriteFolder
          if (existing) remoteFolder = existing
          else {
            const response = await this.engine.request(accountId, 'favoriteFolderCreate', {
              action: '1',
              collects_name: operation.title!,
              secret: operation.private ? '1' : '0'
            })
            parseWriteResult(response)
            remoteFolder = { ...parseFavoriteFolder(response.collects_info), localCount: 0 }
          }
          await this.db.call('favoriteLinkFolder', {
            accountId,
            folderId: operation.folderId!,
            remoteId: remoteFolder.remoteId ?? remoteFolder.id,
            title: remoteFolder.title,
            remoteCount: remoteFolder.remoteCount,
            private: remoteFolder.private
          })
        } else {
          const folder = (await this.db.call('favoriteFolders', { accountId })).find(
            (entry) => entry.id === operation.folderId
          )
          if (!folder?.remoteId || folder.localOnly)
            throw new AppError(
              'FOLDER_UNSYNCED',
              `收藏夹“${folder?.title ?? operation.folderId}”尚未创建到云端。`
            )
          if (operation.kind === 'folder-add') {
            if (!operation.workId) throw new AppError('INVALID_INPUT', '收藏夹写回缺少作品标识。')
            parseWriteResult(
              await this.engine.request(accountId, 'favoriteFolderAdd', {
                aweme_id: operation.workId,
                item_ids: operation.workId,
                item_type: '2',
                to_collects_id: folder.remoteId,
                collects_name: folder.title,
                update_collects_sort: 'true'
              })
            )
          } else {
            if (operation.kind !== 'folder-remove' || !operation.workId)
              throw new AppError('INVALID_INPUT', '收藏夹写回操作类型无效。')
            parseWriteResult(
              await this.engine.request(accountId, 'favoriteFolderRemove', {
                aweme_id: operation.workId,
                item_ids: operation.workId,
                item_type: '2',
                from_collects_id: folder.remoteId,
                collects_name: folder.title
              })
            )
            await this.db.call('favoriteForgetFolderWork', {
              accountId,
              remoteId: account.remoteId,
              folderId: folder.id,
              workId: operation.workId
            })
          }
        }
        await this.db.call('favoriteWriteComplete', { accountId, operationId: operation.id })
        if (operation.kind === 'folder-add' && operation.folderId) {
          const folder = (await this.db.call('favoriteFolders', { accountId })).find(
            (entry) => entry.id === operation.folderId
          )
          if (folder && !folder.localOnly)
            await this.db.call('favoriteRememberFolder', {
              accountId,
              remoteId: account.remoteId,
              folder: { ...folder, remoteCount: folder.remoteCount + 1 }
            })
        }
        synced++
        // Space out platform writes; a tight burst trips the same risk control
        // that makes every later item fail.
        await new Promise<void>((resolve) => setTimeout(resolve, 350))
      } catch (error) {
        const code = error instanceof AppError ? error.code : ''
        const skippable = operation.kind === 'favorite-add' || operation.kind === 'folder-add'
        if (skippable && (code === 'WORK_UNAVAILABLE' || code === 'CONTENT_UNAVAILABLE')) {
          if (operation.workId && !skippedWorkIds.has(operation.workId)) {
            skippedWorkIds.add(operation.workId)
            skipped++
            skippedItems.push({
              workId: operation.workId,
              kind: operation.kind,
              reason: error instanceof Error ? error.message : String(error)
            })
          }
          await this.db.call('favoriteWriteComplete', { accountId, operationId: operation.id })
          continue
        }
        const remaining = await this.db.call('favoriteWritePending', { accountId })
        const message = error instanceof Error ? error.message : '云端写回失败。'
        throw new AppError(
          error instanceof AppError ? error.code : 'WRITE_UNCONFIRMED',
          `${synced ? `已完成 ${synced} 项；` : ''}写回“${operation.kind}”失败：${message}队列中仍有 ${remaining} 项，未自动重试。`
        )
      }
    }
    const remaining = await this.db.call('favoriteWritePending', { accountId })
    this.changed()
    return { synced, remaining, skipped, skippedItems }
  }
}
