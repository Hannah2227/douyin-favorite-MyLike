import { HealthMonitor } from './health'
import type { HealthSnapshot } from '../shared/health'
import { FavoritesService } from './favorites'
import { FavoriteActions } from './favorite-actions'
import { app, shell, clipboard, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import type { Account, Command, Diagnostics, Query, Snapshot } from '../shared/contracts'
import { Database } from './storage/client'
import { DouyinEngine } from './douyin/engine'
import {
  parseIdentity,
  parseLikedPage,
  parseMedia,
  parseFavoriteFolders,
  parseFavoritesPage
} from './douyin/parse'
import { Authentication } from './authentication'
import type { AccessTarget } from './douyin/page-state'
import type { Operation } from './douyin/page-request'
import { AppError } from './errors'
import { version } from '../../package.json'
import { RequestLane } from './request-lane'
import { CollectionService } from './collection'
import { AccountService } from './accounts'
import { DataMaintenance } from './data-maintenance'
import { UnlikeService } from './unlike'
import { metadataBytes } from './storage/usage'
import { runtimeEventCategory, type RuntimeEventInput } from '../shared/runtime-events'

export class Application {
  private readonly health = new HealthMonitor()
  private readonly healthRuns = new Map<string, Promise<HealthSnapshot>>()
  private readonly healthAfterAuth = new Set<string>()
  private readonly accessChecks = new Map<string, { accountId: string; operation: string; at: number }>()
  private playerVisible = false
  private busy = false
  private epoch = 0
  private libraryRevision = 0
  private mediaEpoch = 0
  private activeMedia: {
    accountId: string
    workId: string
    queueId: string | null
    cancelled: boolean
  } | null = null
  private closing = false
  private accountAction: Promise<unknown> | null = null
  private readonly accounts: AccountService
  private readonly maintenance: DataMaintenance
  private readonly lane = new RequestLane()
  private readonly favorites: FavoritesService
  private readonly favoriteActions: FavoriteActions
  private readonly collection: CollectionService
  private readonly unlike: UnlikeService
  private readonly authentication: Authentication
  private admission: Promise<void> = Promise.resolve()
  constructor(
    readonly database: Database,
    readonly engine: DouyinEngine,
    private readonly changed: () => void,
    private readonly parent: () => BrowserWindow | null = () => null
  ) {
    engine.setObserver((accountId, event) => this.record(accountId, event))
    this.authentication = new Authentication(
      engine,
      this.run.bind(this),
      async (accountId, target, check, kind) => {
        await this.verifyAccess(accountId, target, check, kind === 'login')
        if (this.healthAfterAuth.delete(accountId))
          setTimeout(() => {
            if (!this.closing) void this.checkHealth(accountId).catch(() => {})
          }, 0)
      },
      changed,
      this.record.bind(this)
    )
    engine.setAttentionHandler((event) => {
      if (event.type === 'closed') this.healthAfterAuth.delete(event.accountId)
      if (event.type === 'required') this.clearAccessChecks(event.accountId)
      if (!this.closing) this.authentication.handle(event)
    })
    this.collection = new CollectionService(
      database,
      engine,
      this.run.bind(this),
      this.identity.bind(this),
      (committed) => {
        if (committed) this.libraryRevision++
        changed()
      },
      undefined,
      this.record.bind(this)
    )
    this.favorites = new FavoritesService(
      database,
      engine,
      this.run.bind(this),
      this.identity.bind(this),
      (committed) => {
        if (committed) this.libraryRevision++
        changed()
      },
      undefined,
      this.record.bind(this)
    )
    this.unlike = new UnlikeService(
      database,
      engine,
      this.run.bind(this),
      this.identity.bind(this),
      (committed) => {
        if (committed) this.libraryRevision++
        changed()
      }
    )
    this.favoriteActions = new FavoriteActions(
      database,
      engine,
      this.run.bind(this),
      this.identity.bind(this),
      () => {
        this.libraryRevision++
        changed()
      }
    )
    this.accounts = new AccountService(
      database,
      engine,
      this.exclusive.bind(this),
      this.active.bind(this),
      this.quiesce.bind(this),
      changed
    )
    this.maintenance = new DataMaintenance()
  }
  private record(accountId: string, event: RuntimeEventInput) {
    if (!this.closing && event.operation) {
      if (event.operation !== 'self' || event.code)
        this.health.observe(accountId, event.operation, event.code, undefined, false, event.rule)
      this.changed()
    }
    if (this.closing || !runtimeEventCategory(event)) return
    void this.database
      .call('appendRuntimeEvent', { accountId, event })
      .then(() => this.changed())
      .catch(() => console.error('[MyLike] Runtime record could not be saved.'))
  }
  async snapshot(): Promise<Snapshot> {
    const accounts = await this.database.call('accounts', undefined)
    const active = await this.database.call('setting', { key: 'activeAccount' })
    const theme = await this.database.call('setting', { key: 'theme' })
    const activeAccountId = accounts.some((a) => a.id === active) ? active : (accounts[0]?.id ?? null)
    return {
      accounts,
      activeAccountId,
      theme: theme === 'light' ? 'light' : 'dark',
      engine: this.engine.snapshot(),
      authentication: this.authentication.snapshot(),
      health: activeAccountId ? this.health.snapshot(activeAccountId) : null,
      busy: this.busy,
      collection: activeAccountId
        ? await this.database.call('collection', { accountId: activeAccountId })
        : null,
      recovery: activeAccountId ? this.engine.recovery(activeAccountId) : [],
      accessChecks: [...this.accessChecks.values()].filter((item) => item.accountId === activeAccountId),
      collectionActivity: this.collection.activity,
      unlike: activeAccountId ? await this.database.call('unlikeTask', { accountId: activeAccountId }) : null,
      favorites: activeAccountId
        ? await this.database.call('favoritesTask', { accountId: activeAccountId })
        : null,
      favoritesActivity: this.favorites.activity,
      favoritesUpdate: activeAccountId
        ? await this.database.call('favoritesTask', { accountId: activeAccountId, mode: 'update' })
        : null,
      libraryRevision: this.libraryRevision,
      playback: activeAccountId
        ? await this.database.call('queueState', { accountId: activeAccountId })
        : null,
      playbackPreferences: await this.database.call('playbackPreferences', {}),
      appPreferences: await this.database.call('appPreferences', {}),
      version
    }
  }
  async applyAppearance(theme?: 'dark' | 'light'): Promise<void> {
    const value = theme ?? (await this.database.call('setting', { key: 'theme' }))
    const light = value === 'light' && !this.playerVisible
    const color = this.playerVisible ? '#111113' : light ? '#f7f8fb' : '#101014'
    const win = this.parent()
    if (!win || win.isDestroyed()) return
    win.setBackgroundColor(color)
    if (process.platform === 'win32')
      win.setTitleBarOverlay({ color, symbolColor: light ? '#202436' : '#ececf2', height: 30 })
  }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.admission
    let release!: () => void
    this.admission = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await action()
    } finally {
      release()
    }
  }
  private async active(accountId: string): Promise<Account> {
    const snapshot = await this.snapshot()
    const account = snapshot.accounts.find((a) => a.id === accountId)
    if (!account || snapshot.activeAccountId !== accountId)
      throw new AppError('ACCOUNT_CHANGED', '操作账号已变化，请重新选择。')
    return account
  }
  private async run<T>(
    accountId: string,
    operation: (check: () => void) => Promise<T>,
    background = false
  ): Promise<T> {
    const epoch = this.epoch
    const check = () => {
      if (epoch !== this.epoch) throw new AppError('CANCELLED', '操作已停止，旧结果已丢弃。')
    }
    return this.lane.run(background, async () => {
      await this.exclusive(async () => {
        if (this.closing) throw new AppError('CLOSING', '应用正在退出，未发送新的请求。')
        if (this.accountAction) throw new AppError('BUSY', '账号操作正在收口，请稍候。')
        check()
        await this.active(accountId)
        this.busy = true
      })
      this.changed()
      try {
        const result = await operation(check)
        check()
        return result
      } finally {
        this.busy = false
        this.changed()
      }
    })
  }
  private async identity(accountId: string, check: () => void): Promise<Account> {
    const identity = parseIdentity(await this.engine.request(accountId, 'self'))
    check()
    try {
      const account = await this.database.call('bindAccount', { accountId, ...identity })
      check()
      this.health.observe(accountId, 'self')
      return account
    } catch (error) {
      if (error instanceof AppError) this.health.observe(accountId, 'self', error.code)
      if (error instanceof AppError && ['IDENTITY_MISMATCH', 'DUPLICATE_ACCOUNT'].includes(error.code))
        this.engine.requireAttention(accountId, 'login', { operation: 'self', parameters: {} })
      throw error
    }
  }
  private async verifyAccess(
    accountId: string,
    target: AccessTarget | null,
    check: () => void,
    loginCheck = false
  ): Promise<Account> {
    const account = await this.active(accountId)
    this.assertAvailable(accountId, target ? [target.operation] : [])
    check()
    let identity: ReturnType<typeof parseIdentity>
    try {
      identity = parseIdentity(
        await this.engine.request(accountId, 'self', {}, { recovery: true, loginCheck })
      )
    } catch (error) {
      // Before login, self can reject with HTTP 200 instead of an empty user.
      // Only this identity check uses the two-second login cadence. Explicit
      // HTTP rate limits and failures of the blocked business API stay distinct.
      if (loginCheck && error instanceof AppError && error.code === 'API_REJECTED')
        throw new AppError('LOGIN_PENDING', '尚未取得已登录身份，请完成窗口中的登录。')
      throw error
    }
    check()
    if (account.remoteId && account.remoteId !== identity.remoteId)
      throw new AppError(
        'IDENTITY_MISMATCH',
        '窗口登录的身份与这个账号不一致，请切回原账号或添加新的本地账号。'
      )
    if (target && target.operation !== 'self') {
      const data = await this.engine.request(
        accountId,
        target.operation,
        target.operation === 'likes'
          ? { ...target.parameters, sec_user_id: identity.remoteId }
          : target.parameters,
        { recovery: true }
      )
      check()
      if (target.operation === 'likes') parseLikedPage(data)
      else if (target.operation === 'folders') parseFavoriteFolders(data)
      else if (['favorites', 'folderItems'].includes(target.operation)) parseFavoritesPage(data)
      else if (target.operation === 'detail') {
        if (String(data.aweme_detail?.aweme_id) !== target.parameters.aweme_id)
          throw new AppError('WORK_UNAVAILABLE', '原作品详情尚未恢复，请稍后重试。')
      }
    }
    check()
    const state = await this.engine.pageState(accountId)
    check()
    if (!state.ready) throw new AppError('BROWSER_NOT_READY', '抖音页面尚未就绪，请稍候核验。')
    if (state.captcha) throw new AppError('VERIFICATION_REQUIRED', '请先完成抖音窗口中的安全验证。')
    const bound = await this.database.call('bindAccount', { accountId, ...identity })
    check()
    // Only the complete read-only recovery check grants this UI evidence.
    // A healthy self response followed by a failed target must not unlock it.
    this.health.observe(accountId, 'self')
    const at = Date.now()
    for (const operation of new Set(['self', target?.operation ?? 'self']))
      this.accessChecks.set(JSON.stringify([accountId, operation]), { accountId, operation, at })
    return bound
  }
  private async checkHealth(accountId: string): Promise<HealthSnapshot> {
    const existing = this.healthRuns.get(accountId)
    if (existing) return existing
    const run = (async () => {
      await this.active(accountId)
      this.engine.allowAttention()
      this.health.begin(accountId)
      this.changed()
      let completed = false
      try {
        await this.run(accountId, async (check) => {
          const identityWaiting = this.engine.recovery(accountId).some((r) => r.operation === 'self')
          let identity: Account
          try {
            identity = await this.verifyAccess(accountId, null, check, true)
          } catch (caught) {
            const error =
              caught instanceof AppError
                ? caught
                : new AppError('STORAGE_ERROR', '暂时无法读取本地账号信息。')
            if (error instanceof AppError) {
              this.health.observe(accountId, 'self', error.code, error.retryAt, !identityWaiting, error.rule)
              if (
                [
                  'AUTH_REQUIRED',
                  'LOGIN_PENDING',
                  'IDENTITY_MISMATCH',
                  'DUPLICATE_ACCOUNT',
                  'VERIFICATION_REQUIRED'
                ].includes(error.code)
              ) {
                this.healthAfterAuth.add(accountId)
                this.engine.requireAttention(
                  accountId,
                  error.code === 'VERIFICATION_REQUIRED' ? 'verification' : 'login',
                  { operation: 'self', parameters: {} }
                )
              }
            }
            if (error instanceof AppError && ['CANCELLED', 'ACCOUNT_CHANGED', 'CLOSING'].includes(error.code))
              throw error
            return
          }
          const likes = await this.database.call('collection', { accountId })
          const favorites = await this.database.call('favoritesTask', { accountId })
          const targets: AccessTarget[] = [
            {
              operation: 'likes',
              parameters: { sec_user_id: identity.remoteId!, max_cursor: '0', count: '18' }
            },
            { operation: 'favorites', parameters: { cursor: '0', count: '20' } },
            { operation: 'folders', parameters: { cursor: '0', count: '20' } }
          ]
          if (likes?.errorCode && likes.cursor !== '0')
            targets.push({
              operation: 'likes',
              parameters: { sec_user_id: identity.remoteId!, max_cursor: likes.cursor, count: '18' }
            })
          if (favorites?.stage === 'folder' && favorites.folderId)
            targets.push({
              operation: 'folderItems',
              parameters: { collects_id: favorites.folderId, cursor: favorites.cursor, count: '20' }
            })
          for (const issue of (favorites?.issues ?? []).slice(0, 5))
            targets.push({
              operation: 'folderItems',
              parameters: { collects_id: issue.folderId, cursor: '0', count: '20' }
            })
          const original = this.engine.recoveryTarget(accountId)
          if (original && ['likes', 'favorites', 'folders', 'folderItems'].includes(original.operation))
            targets.push(original)
          const seen = new Set<string>(),
            failed = new Set<string>()
          let attention = false
          for (const target of targets) {
            check()
            const key = JSON.stringify(target)
            if (seen.has(key)) continue
            seen.add(key)
            let attempted = false
            try {
              this.engine.assertAvailable(accountId, target.operation)
              attempted = true
              const data = await this.engine.request(accountId, target.operation, target.parameters, {
                recovery: true
              })
              const page =
                target.operation === 'likes'
                  ? parseLikedPage(data, { allowEmpty: true })
                  : target.operation === 'folders'
                    ? parseFavoriteFolders(data, { allowEmpty: true })
                    : parseFavoritesPage(data, { allowEmpty: true })
              if (page.hasMore && ('folders' in page ? !page.folders.length : !page.items.length))
                throw new AppError('EMPTY_PAGE', '暂时未能取得可用内容，请稍后核验。')
              check()
              if (failed.has(target.operation)) continue
              this.health.observe(accountId, target.operation)
            } catch (error) {
              if (!(error instanceof AppError)) throw error
              if (['CANCELLED', 'ACCOUNT_CHANGED', 'CLOSING'].includes(error.code)) throw error
              // One failed operation counts once per explicit round, even with several folders.
              const first = !failed.has(target.operation)
              failed.add(target.operation)
              this.health.observe(
                accountId,
                target.operation,
                error.code,
                error.retryAt,
                first && attempted,
                error.rule
              )
              if (['AUTH_REQUIRED', 'VERIFICATION_REQUIRED'].includes(error.code)) {
                this.healthAfterAuth.add(accountId)
                attention = true
                this.engine.requireAttention(
                  accountId,
                  error.code === 'AUTH_REQUIRED' ? 'login' : 'verification',
                  target
                )
                break
              }
            }
          }
          // A healthy folder cannot erase the failure of another checked folder.
          for (const operation of failed) {
            const entry = this.health.snapshot(accountId).entries.find((e) => e.operation === operation)
            if (entry?.status === 'normal') this.health.observe(accountId, operation, 'INVALID_RESPONSE')
          }
          if ((favorites?.issues?.length ?? 0) > 5)
            this.health.observe(accountId, 'folderItems', 'MORE_CHECKS')
          if (!attention) {
            this.engine.hide(accountId)
            this.authentication.stop()
          }
        })
        completed = true
        return this.health.snapshot(accountId)
      } catch (error) {
        if (
          error instanceof AppError &&
          ['CANCELLED', 'ACCOUNT_CHANGED', 'CLOSING', 'BUSY'].includes(error.code)
        )
          throw error
        const failure =
          error instanceof AppError ? error : new AppError('STORAGE_ERROR', '暂时无法完成本地检查。')
        this.health.observe(accountId, 'self', failure.code, failure.retryAt, true, failure.rule)
        completed = true
        this.record(accountId, {
          kind: 'task',
          operation: 'self',
          code: failure.code,
          message: '状态核验未完成，请查看诊断详情。'
        })
        return this.health.snapshot(accountId)
      } finally {
        this.health.finish(accountId, completed)
        this.changed()
      }
    })()
    const result = run.then(() => this.health.snapshot(accountId))
    this.healthRuns.set(accountId, result)
    try {
      return await result
    } finally {
      if (this.healthRuns.get(accountId) === result) this.healthRuns.delete(accountId)
    }
  }
  private async collectionAction(
    accountId: string,
    source: 'likes' | 'favorites',
    action: 'top' | 'down' | 'stop'
  ) {
    await this.active(accountId)
    if (source === 'favorites') {
      if (action === 'stop') {
        const normal = await this.database.call('favoritesTask', { accountId }),
          top = await this.database.call('favoritesTask', { accountId, mode: 'update' })
        for (const task of [normal, top])
          if (task && task.status !== 'completed' && task.status !== 'stopped')
            await this.execute('favoritesControl', {
              accountId,
              taskId: task.id,
              mode: task.mode,
              action: 'stop'
            })
      } else await this.execute('favoritesStart', { accountId, mode: action === 'top' ? 'update' : 'sync' })
      return
    }
    const task = await this.database.call('collection', { accountId })
    if (action === 'stop') {
      if (task && task.status !== 'completed' && task.status !== 'stopped')
        await this.execute('collectionControl', { accountId, taskId: task.id, action: 'stop' })
      return
    }
    if (action === 'top') {
      await this.execute('collectionStart', { accountId, mode: 'incremental' })
      return
    }
    if (task && task.status !== 'completed') {
      // Finish an interrupted head before continuing its preserved historical cursor.
      this.assertAvailable(accountId, ['likes'])
      if (task.mode === 'incremental') {
        await this.exclusive(async () => {
          await this.active(accountId)
          if (this.collection.running || this.favorites.running || this.unlike.running)
            throw new AppError('BUSY', '请先停止当前任务。')
          this.assertAvailable(accountId, ['likes'])
          await this.database.call('updateCollection', {
            accountId,
            taskId: task.id,
            status: task.status,
            reason: task.reason,
            mode: 'update'
          })
          await this.collection.control(accountId, task.id, 'resume')
        })
      } else await this.execute('collectionControl', { accountId, taskId: task.id, action: 'resume' })
    } else {
      const checkpoint = await this.database.call('checkpoint', { accountId })
      const mode = task?.tailCursor != null && !checkpoint?.hasMore ? 'recheck' : 'update'
      await this.execute('collectionStart', { accountId, mode })
    }
  }
  private clearAccessChecks(accountId: string): void {
    for (const [key, item] of this.accessChecks)
      if (item.accountId === accountId) this.accessChecks.delete(key)
  }
  private assertAvailable(accountId: string, operations: Operation[]): void {
    for (const operation of new Set<Operation>(['self', ...operations]))
      this.engine.assertAvailable(accountId, operation)
  }
  private async favoriteReadOperation(
    accountId: string,
    mode: 'sync' | 'update' = 'sync',
    probe = false
  ): Promise<Operation> {
    const task = await this.database.call('favoritesTask', { accountId, mode })
    if (mode === 'update' || !task || task.status === 'completed' || (probe && task.status === 'partial'))
      return 'favorites'
    if (task.status === 'partial')
      return task.incomplete || !task.foldersDeferred ? 'favorites' : 'folderItems'
    return task.stage === 'all' ? 'favorites' : task.stage === 'folders' ? 'folders' : 'folderItems'
  }
  private async quiesce(): Promise<void> {
    await this.unlike.stop()
    await this.favoriteActions.idle(true)
    const paused = Promise.all([this.collection.pause(), this.favorites.pause()])
    this.epoch++
    this.engine.release()

    await paused
    await this.lane.idle()
  }
  async execute(command: Command, input: any): Promise<unknown> {
    if (this.closing) throw new AppError('CLOSING', '应用正在退出。')
    if (
      [
        'login',
        'probe',
        'collectionStart',
        'favoritesStart',
        'favoritesProbe',
        'unlikeStart',
        'collectPage',
        'favoriteEditor',
        'favoriteSave',
        'favoriteCreateFolder'
      ].includes(command) ||
      (['collectionControl', 'favoritesControl', 'unlikeControl'].includes(command) &&
        input.action === 'resume')
    )
      this.engine.allowAttention()
    if (
      ['collectionControl', 'favoritesControl', 'unlikeControl'].includes(command) &&
      input.action === 'stop' &&
      this.authentication.snapshot()?.accountId === input.accountId
    )
      this.engine.dismissAttention(input.accountId)
    if (
      this.accountAction &&
      ![
        'snapshot',
        'query',
        'runtimeEvents',
        'diagnostics',
        'dataInfo',
        'theme',
        'windowPresentation'
      ].includes(command)
    )
      throw new AppError('BUSY', '账号操作正在收口，请稍候。')
    if (
      this.unlike.running &&
      [
        'createAccount',
        'switchAccount',
        'collectPage',
        'collectionStart',
        'deleteLocal',
        'favoriteEditor',
        'favoriteSave',
        'favoriteCreateFolder',
        'unlikeVerify'
      ].includes(command)
    )
      throw new AppError('BUSY', '请先停止取消点赞或收藏任务，等待当前请求结果保存。')
    switch (command) {
      case 'appPreferences': {
        const value = await this.database.call('appPreferences', input)
        this.parent()?.webContents.setZoomFactor(value.zoom)
        this.changed()
        return value
      }
      case 'checkDatabase':
        return this.database.call('checkDatabase', {})
      case 'copyDiagnostics': {
        const diagnostic = await this.execute('diagnostics', {})
        await clipboard.writeText(
          JSON.stringify(
            {
              application: 'MyLike',
              version,
              platform: process.platform,
              arch: process.arch,
              runtime: diagnostic
            },
            null,
            2
          )
        )
        return null
      }
      case 'openReleases':
        try {
          await shell.openExternal('https://github.com/Hannah2227/douyin-favorite-MyLike/releases')
        } catch {
          throw new AppError('OPEN_BROWSER_FAILED', '无法打开系统默认浏览器，请稍后重试。')
        }
        return null
      case 'snapshot':
        return this.snapshot()
      case 'runtimeEvents':
        await this.active(input.accountId)
        return this.database.call('runtimeEvents', { accountId: input.accountId })
      case 'createAccount':
        return this.exclusive(async () => {
          if (this.lane.pending || this.collection.running || this.favorites.running || this.unlike.running)
            throw new AppError('BUSY', '请先暂停采集并等待当前请求结束。')
          const account = await this.database.call('createAccount', { id: randomUUID(), name: input.name })
          this.epoch++
          this.engine.release()

          await this.database.call('setting', { key: 'activeAccount', value: account.id })
          this.changed()
          return account
        })
      case 'switchAccount':
        return this.exclusive(async () => {
          if (this.lane.pending || this.collection.running || this.favorites.running || this.unlike.running)
            throw new AppError('BUSY', '请先暂停采集，等待请求收口后再切换账号。')
          if (!(await this.database.call('accounts', undefined)).some((a) => a.id === input.accountId))
            throw new AppError('ACCOUNT_NOT_FOUND', '账号不存在。')
          if (this.busy) throw new AppError('BUSY', '请先停止当前请求。')
          this.epoch++
          this.engine.release()

          await this.database.call('setting', { key: 'activeAccount', value: input.accountId })
          this.changed()
          return null
        })
      case 'login':
        return this.run(input.accountId, async (check) => {
          const target = this.engine.recoveryTarget(input.accountId)
          // A temporarily unavailable business API is not a captcha. Opening
          // the page must not put otherwise healthy media requests behind a
          // fabricated verification requirement or clear the API's wait.
          if (
            target &&
            target.operation !== 'self' &&
            this.engine.recovery(input.accountId).some((state) => state.operation === target.operation)
          ) {
            await this.engine.show(input.accountId)
            return null
          }
          const interaction = this.authentication.snapshot()
          const kind =
            interaction && interaction.accountId === input.accountId
              ? interaction.kind
              : (await this.engine.pageState(input.accountId)).captcha
                ? 'verification'
                : 'login'
          check()
          await this.active(input.accountId)
          check()
          await this.authentication.open(input.accountId, kind, target)
          return null
        })
      case 'renameAccount':
        return this.accounts.rename(input.accountId, input.name)
      case 'logoutAccount':
      case 'removeAccount': {
        this.health.clear(input.accountId)
        this.healthAfterAuth.delete(input.accountId)
        this.clearAccessChecks(input.accountId)
        const action =
          command === 'logoutAccount'
            ? this.accounts.logout(input.accountId)
            : this.accounts.remove(input.accountId)
        this.accountAction = action
        try {
          return await action
        } finally {
          if (this.accountAction === action) this.accountAction = null
        }
      }
      case 'checkHealth':
        return this.checkHealth(input.accountId)
      case 'collectionAction': {
        try {
          await this.collectionAction(input.accountId, input.source, input.action)
          return null
        } catch (error) {
          if (error instanceof AppError)
            this.health.observe(
              input.accountId,
              input.source === 'likes' ? 'likes' : 'favorites',
              error.code,
              error.retryAt
            )
          this.changed()
          throw error
        }
      }
      case 'probe':
        return this.run(input.accountId, async (check) => {
          const account = await this.verifyAccess(
            input.accountId,
            this.authentication.target(input.accountId) ?? this.engine.recoveryTarget(input.accountId),
            check
          )
          check()
          this.engine.hide(input.accountId)
          this.authentication.stop()
          this.record(input.accountId, { kind: 'auth', message: '手动身份核验成功，窗口已收起。' })
          return account
        })
      case 'releaseEngine': {
        await this.unlike.stop()
        await this.favoriteActions.idle(true)
        const paused = Promise.all([this.collection.pause(), this.favorites.pause()])
        this.epoch++
        this.engine.release()
        await paused
        return null
      }
      case 'stopRequest': {
        const accountId = this.engine.snapshot().accountId
        if (accountId) this.engine.dismissAttention(accountId)
        await this.unlike.stop()
        await this.favoriteActions.idle(true)
        const paused = Promise.all([this.collection.pause(), this.favorites.pause()])
        this.epoch++
        this.engine.cancel()
        await paused
        return null
      }
      case 'collectPage':
        await this.active(input.accountId)
        this.assertAvailable(input.accountId, ['likes'])
        if (this.collection.running || this.favorites.running)
          throw new AppError('BUSY', '请先暂停自动采集，再进行单页检查。')
        return this.run(input.accountId, async (check) => {
          const account = await this.identity(input.accountId, check)
          check()
          const saved = await this.database.call('checkpoint', { accountId: input.accountId })
          const checkpoint = input.continue ? saved : null
          if (checkpoint && !checkpoint.hasMore)
            throw new AppError('NO_MORE', '当前断点已到列表末尾；可从头采集检查新增。')
          const cursor = checkpoint?.cursor ?? '0'
          const page = parseLikedPage(
            await this.engine.request(input.accountId, 'likes', {
              sec_user_id: account.remoteId!,
              max_cursor: cursor,
              min_cursor: '0',
              count: '18',
              publish_video_strategy_type: '2',
              pc_client_type: '1'
            })
          )
          check()
          if (page.hasMore && page.cursor === cursor)
            throw new AppError('CURSOR_STALLED', '分页游标没有前进，已停止以避免重复空转。')
          const result = await this.database.call('savePage', {
            accountId: input.accountId,
            remoteId: account.remoteId!,
            preserveCheckpoint: !input.continue && !!saved?.hasMore,
            ...page
          })
          this.libraryRevision++
          this.record(input.accountId, {
            kind: 'task',
            message: `单页检查完成：接收 ${result.received} 条，新增 ${result.added} 条。`
          })
          this.changed()
          return result
        })
      case 'favoriteFolders':
        await this.active(input.accountId)
        return this.database.call('favoriteFolders', input)
      case 'favoriteStatus':
        await this.active(input.accountId)
        return this.database.call('favoriteStatus', input)
      case 'favoriteEditor':
        await this.active(input.accountId)
        this.assertAvailable(input.accountId, ['detail', 'folders'])
        return this.favoriteActions.open(input)
      case 'favoriteSave':
        await this.active(input.accountId)
        this.assertAvailable(input.accountId, ['detail', 'folders'])
        await this.favorites.pause()
        return this.favoriteActions.save(input.accountId, input.token, input.folderIds)
      case 'favoriteCreateFolder':
        await this.active(input.accountId)
        this.assertAvailable(input.accountId, ['favoriteFolderCreate'])
        await this.favorites.pause()
        return this.favoriteActions.createFolder(input.accountId, input.token, input.name, input.private)
      case 'favoritesStart':
        return this.exclusive(async () => {
          await this.active(input.accountId)
          this.assertAvailable(input.accountId, [
            await this.favoriteReadOperation(input.accountId, input.mode)
          ])
          if (this.collection.running || this.unlike.running)
            throw new AppError('BUSY', '请先暂停喜欢采集或取消点赞 / 收藏任务。')
          return this.favorites.start(input.accountId, input.mode)
        })
      case 'favoritesProbe':
        await this.active(input.accountId)
        this.assertAvailable(input.accountId, [
          await this.favoriteReadOperation(input.accountId, 'sync', true)
        ])
        if (this.collection.running || this.unlike.running || this.favorites.running)
          throw new AppError('BUSY', '请先暂停自动任务，再进行收藏检查。')
        return this.favorites.probe(input.accountId)
      case 'favoritesControl':
        await this.active(input.accountId)
        if (input.action === 'resume' && (this.collection.running || this.unlike.running))
          throw new AppError('BUSY', '请先暂停喜欢采集或取消点赞 / 收藏任务。')
        return input.action === 'resume'
          ? this.exclusive(async () => {
              this.assertAvailable(input.accountId, [
                await this.favoriteReadOperation(input.accountId, input.mode)
              ])
              if (this.collection.running || this.unlike.running)
                throw new AppError('BUSY', '其他任务正在运行。')
              return this.favorites.control(input.accountId, input.taskId, input.action, input.mode)
            })
          : this.favorites.control(input.accountId, input.taskId, input.action, input.mode)
      case 'collectionStart':
        return this.exclusive(async () => {
          await this.active(input.accountId)
          this.assertAvailable(input.accountId, ['likes'])
          if (this.unlike.running || this.favorites.running)
            throw new AppError('BUSY', '请先停止其他采集或取消点赞 / 收藏任务。')
          return this.collection.start(input.accountId, input.mode)
        })
      case 'collectionControl':
        await this.active(input.accountId)
        if (input.action === 'resume' && (this.unlike.running || this.favorites.running))
          throw new AppError('BUSY', '请先停止取消点赞 / 收藏任务。')
        if (input.action === 'resume')
          return this.exclusive(() => {
            this.assertAvailable(input.accountId, ['likes'])
            if (this.unlike.running || this.favorites.running)
              throw new AppError('BUSY', '请先停止收藏同步或取消点赞 / 收藏任务。')
            return this.collection.control(input.accountId, input.taskId, input.action)
          })
        return this.collection.control(input.accountId, input.taskId, input.action)
      case 'unlikeStart':
        await this.active(input.accountId)
        this.assertAvailable(
          input.accountId,
          input.source === 'favorites' ? ['detail', 'favoriteRemove'] : ['unlike']
        )
        await Promise.all([this.collection.pause(), this.favorites.pause()])
        await this.favoriteActions.idle()
        await this.lane.idle()
        return this.exclusive(async () => {
          await this.active(input.accountId)
          if (this.lane.pending || this.collection.running || this.favorites.running)
            throw new AppError('BUSY', '请等待当前页面请求结束。')
          this.assertAvailable(
            input.accountId,
            input.source === 'favorites' ? ['detail', 'favoriteRemove'] : ['unlike']
          )
          return this.unlike.start(input.accountId, input.workIds, input.mode, input.source)
        })
      case 'unlikeControl': {
        await this.active(input.accountId)
        if (input.action === 'resume') {
          const task = await this.database.call('unlikeTask', input)
          this.assertAvailable(
            input.accountId,
            task?.source === 'favorites' ? ['detail', 'favoriteRemove'] : ['unlike']
          )
          await Promise.all([this.collection.pause(), this.favorites.pause()])
          await this.favoriteActions.idle()
          await this.lane.idle()
          return this.exclusive(async () => {
            await this.active(input.accountId)
            if (this.lane.pending || this.collection.running || this.favorites.running)
              throw new AppError('BUSY', '请等待当前页面请求结束。')
            this.assertAvailable(
              input.accountId,
              task?.source === 'favorites' ? ['detail', 'favoriteRemove'] : ['unlike']
            )
            return this.unlike.resume(input.accountId, input.taskId)
          })
        }
        const task = await this.database.call('unlikeTask', input)
        if (task?.status === 'running') await this.unlike.stop()
        if ((await this.database.call('unlikeTask', input))?.status !== 'stopped')
          await this.database.call('unlikeUpdate', {
            ...input,
            status: 'stopped',
            reason: '已停止后续未发送项。'
          })
        this.changed()
        return this.database.call('unlikeTask', input)
      }
      case 'unlikeVerify':
        await this.active(input.accountId)
        this.assertAvailable(input.accountId, ['detail'])
        return this.unlike.verify(input.accountId, input.taskId, input.workId)
      case 'unlikeItems':
      case 'unlikeHistory':
        await this.active(input.accountId)
        return this.database.call(command, input)
      case 'query':
        return this.database.call('query', input as Query)
      case 'libraryOverview':
        await this.active(input.accountId)
        return {
          ...(await this.database.call('libraryOverview', input)),
          metadataBytes: await metadataBytes(app.getPath('userData'))
        }
      case 'matchingIds':
        return this.database.call('matchingIds', input)
      case 'deleteLocal': {
        return this.exclusive(async () => {
          await this.active(input.accountId)
          const result = await this.database.call('deleteLocal', input)
          this.libraryRevision++
          this.changed()
          return result
        })
      }
      case 'queueCreate':
      case 'queueResume':
      case 'queueMove':
      case 'queueProgress':
      case 'queueEnd':
      case 'queueReplay':
      case 'queueDismiss':
        return this.exclusive(async () => {
          await this.active(input.accountId)
          const result = await this.database.call(command, input)
          if (command !== 'queueProgress') {
            if (['queueCreate', 'queueDismiss'].includes(command)) this.mediaEpoch++
            const active = this.activeMedia
            // A prefetched next item becomes the current item when advancing.
            // Keep that read alive; unrelated targets still cancel immediately.
            if (
              active &&
              !(
                active.accountId === result.accountId &&
                active.queueId === result.queueId &&
                active.workId === result.work.id &&
                !result.completed
              )
            ) {
              active.cancelled = true
              this.engine.cancel()
            }
            this.changed()
          }
          return result
        })
      case 'queueItems':
        await this.active(input.accountId)
        return this.database.call('queueItems', input)
      case 'cancelMedia':
        return this.exclusive(async () => {
          await this.active(input.accountId)
          const queue = await this.database.call('queueState', { accountId: input.accountId })
          if (!queue || queue.queueId !== input.queueId || queue.revision !== input.revision)
            throw new AppError('QUEUE_CHANGED', '播放会话已变化。')
          this.mediaEpoch++
          if (this.activeMedia) this.engine.cancel()
          return null
        })
      case 'playbackPreferences': {
        const preferences = await this.database.call('playbackPreferences', input)
        this.changed()
        return preferences
      }
      case 'backup':
        return this.database.call('backup', { reason: 'manual' })
      case 'dataInfo':
        if (input.accountId) await this.active(input.accountId)
        return this.maintenance.info()
      case 'openDataFolder':
        return this.maintenance.open(input.target)
      case 'clearCache':
        await this.active(input.accountId)
        await this.quiesce()
        return this.exclusive(async () => {
          await this.active(input.accountId)
          await this.engine.clearCaches(input.accountId)
          this.changed()
          return null
        })
      case 'media': {
        const epoch = this.mediaEpoch
        const request = {
          accountId: input.accountId,
          workId: input.workId,
          queueId: input.playback?.queueId ?? null,
          cancelled: false
        }
        return this.run(input.accountId, async (check) => {
          const guard = () => {
            check()
            if (epoch !== this.mediaEpoch || request.cancelled)
              throw new AppError('CANCELLED', '已切换播放目标，旧取链已取消。')
          }
          guard()
          const validateQueue = async () => {
            if (!input.playback) return
            const queue = await this.database.call('queueState', { accountId: input.accountId })
            if (
              !queue ||
              queue.queueId !== input.playback.queueId ||
              !(
                (queue.revision === input.playback.revision &&
                  [queue.work.id, queue.next?.id].includes(input.workId)) ||
                (queue.revision > input.playback.revision &&
                  queue.work.id === input.workId &&
                  !queue.completed)
              )
            )
              throw new AppError('QUEUE_CHANGED', '播放目标已变化，旧取链已丢弃。')
          }
          await validateQueue()
          guard()
          this.activeMedia = request
          try {
            await this.identity(input.accountId, guard)
            guard()
            const media = parseMedia(
              await this.engine.request(input.accountId, 'detail', {
                aweme_id: input.workId,
                publish_video_strategy_type: '2',
                pc_client_type: '1'
              })
            )
            guard()
            if (media.work.id !== input.workId)
              throw new AppError('INVALID_RESPONSE', '作品详情与请求目标不一致。')
            await validateQueue()
            guard()
            return media
          } finally {
            this.activeMedia = null
          }
        })
      }
      case 'original': {
        const epoch = this.epoch
        await this.active(input.accountId)
        if (input.playback) {
          const queue = await this.database.call('queueState', { accountId: input.accountId })
          if (
            !queue ||
            queue.queueId !== input.playback.queueId ||
            queue.revision !== input.playback.revision ||
            queue.work.id !== input.workId
          )
            throw new AppError('QUEUE_CHANGED', '播放目标已变化，请重新打开原页。')
        }
        if (epoch !== this.epoch) throw new AppError('ACCOUNT_CHANGED', '当前账号已变化，请重新打开原页。')
        try {
          await shell.openExternal(`https://www.douyin.com/video/${input.workId}`)
        } catch {
          throw new AppError('OPEN_BROWSER_FAILED', '无法打开系统默认浏览器，请检查默认浏览器设置后重试。')
        }
        return null
      }
      case 'theme':
        await this.database.call('setting', { key: 'theme', value: input.theme })
        await this.applyAppearance(input.theme)
        this.changed()
        return null
      case 'openProject':
        try {
          await shell.openExternal('https://github.com/Hannah2227/douyin-favorite-MyLike')
        } catch {
          throw new AppError('OPEN_BROWSER_FAILED', '无法打开系统默认浏览器，请检查默认浏览器设置后重试。')
        }
        return null
      case 'windowPresentation':
        this.playerVisible = input.player
        await this.applyAppearance()
        return null
      case 'diagnostics':
        return {
          electron: process.versions.electron,
          chromium: process.versions.chrome,
          node: process.versions.node,
          sqlite: await this.database.call('sqliteVersion', undefined),
          packaged: app.isPackaged,
          processes: app.getAppMetrics().map((metric) => ({
            type: metric.type,
            memoryMB: Math.round(metric.memory.workingSetSize / 1000)
          }))
        } satisfies Diagnostics
    }
  }
  async close(): Promise<void> {
    this.closing = true
    this.engine.setObserver(null)
    this.authentication.stop()
    await this.accountAction?.catch(() => {})
    await this.unlike.stop()
    await this.favoriteActions.idle(true)
    const paused = Promise.all([this.collection.pause(), this.favorites.pause()])
    this.epoch++
    this.engine.release()

    await paused
    await this.lane.idle()
    // Window preferences must never prevent inflight business results from being saved.
    const win = this.parent()
    if (win && !win.isDestroyed()) {
      try {
        const preferences = await this.database.call('appPreferences', {})
        if (preferences.rememberWindow)
          await this.database.call('windowState', {
            state: { ...win.getNormalBounds(), maximized: win.isMaximized() }
          })
      } catch {
        console.error('[MyLike] Window preferences could not be saved; task shutdown completed.')
      }
    }
    await this.database.close()
  }
}
