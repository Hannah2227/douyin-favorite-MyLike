import { randomUUID } from 'node:crypto'
import type { Account, FavoriteEditor, FavoriteFolder, PlaybackScope } from '../shared/contracts'
import type { Database } from './storage/client'
import type { DouyinEngine } from './douyin/engine'
import {
  parseFavoriteState,
  parseFavoriteFolders,
  parseFavoriteFolder,
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
      queue.work.id !== scope.workId ||
      (queue.source && queue.source !== 'likes')
    )
      throw new AppError('QUEUE_CHANGED', '播放作品已变化，请为当前作品重新打开收藏。')
    await this.db.call('favoriteWriteGuard', { accountId: scope.accountId, workId: scope.workId })
    check()
  }
  private async folders(accountId: string, check: () => void): Promise<FavoriteFolder[]> {
    const local = await this.db.call('favoriteFolders', { accountId })
    const counts = new Map(local.map((folder) => [folder.id, folder.localCount]))
    const result = new Map<string, FavoriteFolder>(),
      visited = new Set<string>()
    let cursor = '0'
    for (let page = 0; page < 100; page++) {
      check()
      const data = parseFavoriteFolders(
        await this.engine.request(accountId, 'folders', { cursor, count: '20' })
      )
      check()
      for (const folder of data.folders)
        result.set(folder.id, { ...folder, localCount: counts.get(folder.id) ?? 0 })
      if (!data.hasMore) return [...result.values()]
      visited.add(cursor)
      if (visited.has(data.cursor))
        throw new AppError('CURSOR_STALLED', '收藏夹列表游标重复，请稍后重新读取。')
      cursor = data.cursor
    }
    throw new AppError('TOO_MANY_FOLDERS', '收藏夹列表过长，本次未完整读取，未发送收藏请求。')
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
      const folders = await this.folders(scope.accountId, check)
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
        const folders = await this.folders(accountId, valid)
        const targets = [...new Set(folderIds)].map((id) => {
          const folder = folders.find((entry) => entry.id === id)
          if (!folder) throw new AppError('FOLDER_CHANGED', '所选收藏夹已变化，请重新读取后再保存。')
          return folder
        })
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
          await this.db.call('favoriteConfirm', { accountId, remoteId: editor.remoteId, work: state.work })
          this.changed()
          for (const folder of targets) {
            await this.guard(editor.scope, valid)
            inflight = true
            parseWriteResult(
              await this.engine.request(accountId, 'favoriteFolderAdd', {
                aweme_id: state.work.id,
                item_ids: state.work.id,
                item_type: '2',
                to_collects_id: folder.id,
                collects_name: folder.title,
                update_collects_sort: 'true'
              })
            )
            inflight = false
            await this.db.call('favoriteConfirm', {
              accountId,
              remoteId: editor.remoteId,
              work: state.work,
              folder
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
    const epoch = this.writeEpoch
    return this.write(token, () =>
      this.run(accountId, async (check) => {
        const valid = () => {
          check()
          if (epoch !== this.writeEpoch) throw new AppError('CANCELLED', '新建收藏夹已停止，未发送新的请求。')
        }
        const editor = this.editor(accountId, token)
        await this.guard(editor.scope, valid)
        const account = await this.identity(accountId, check)
        if (account.remoteId !== editor.remoteId)
          throw new AppError('IDENTITY_MISMATCH', '当前抖音身份已变化，未新建收藏夹。')
        const existing = await this.folders(accountId, valid)
        if (existing.some((folder) => folder.title === name))
          throw new AppError('FOLDER_EXISTS', '已有同名收藏夹，请直接选择。')
        await this.guard(editor.scope, valid)
        try {
          const response = await this.engine.request(accountId, 'favoriteFolderCreate', {
            action: '1',
            collects_name: name,
            secret: secret ? '1' : '0'
          })
          parseWriteResult(response)
          const folder = { ...parseFavoriteFolder(response.collects_info), localCount: 0 }
          await this.db.call('favoriteRememberFolder', { accountId, remoteId: editor.remoteId, folder })
          editor.folders.unshift(folder)
          this.changed()
          return folder
        } catch (error) {
          this.editors.delete(token)
          if (error instanceof AppError && error.code === 'API_REJECTED') throw error
          throw new AppError(
            'WRITE_UNCONFIRMED',
            '新建结果未完整确认，未自动重试。请重新读取收藏夹，核对是否已创建。'
          )
        }
      })
    )
  }
}
