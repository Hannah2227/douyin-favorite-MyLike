import { FavoritesService } from './favorites'
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
import { AppError } from './errors'
import { version } from '../../package.json'
import { RequestLane } from './request-lane'
import { CollectionService } from './collection'
import { FileTransfers } from './transfers'
import { AccountService } from './accounts'
import { DataMaintenance } from './data-maintenance'
import { UnlikeService } from './unlike'
import { metadataBytes } from './storage/usage'
import { runtimeEventCategory, type RuntimeEventInput } from '../shared/runtime-events'

export class Application {
  private playerVisible = false
  private busy = false
  private epoch = 0
  private libraryRevision = 0
  private mediaEpoch = 0
  private activeMedia = false
  private closing = false
  private accountAction: Promise<unknown> | null = null
  private readonly files: FileTransfers
  private readonly accounts: AccountService
  private readonly maintenance: DataMaintenance
  private readonly lane = new RequestLane()
  private readonly favorites: FavoritesService
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
      },
      changed,
      this.record.bind(this)
    )
    engine.setAttentionHandler((event) => {
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
    this.files = new FileTransfers(
      database,
      parent,
      this.exclusive.bind(this),
      this.active.bind(this),
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
    this.maintenance = new DataMaintenance(engine)
  }
  private record(accountId: string, event: RuntimeEventInput) {
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
      busy: this.busy,
      collection: activeAccountId
        ? await this.database.call('collection', { accountId: activeAccountId })
        : null,
      collectionActivity: this.collection.activity,
      unlike: activeAccountId ? await this.database.call('unlikeTask', { accountId: activeAccountId }) : null,
      favorites: activeAccountId
        ? await this.database.call('favoritesTask', { accountId: activeAccountId })
        : null,
      favoritesActivity: this.favorites.activity,
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
      return await this.database.call('bindAccount', { accountId, ...identity })
    } catch (error) {
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
    return this.database.call('bindAccount', { accountId, ...identity })
  }
  private async quiesce(): Promise<void> {
    await this.unlike.stop()
    const paused = Promise.all([this.collection.pause(), this.favorites.pause()])
    this.epoch++
    this.engine.release()

    await paused
    await this.lane.idle()
  }
  async execute(command: Command, input: any): Promise<unknown> {
    if (this.closing) throw new AppError('CLOSING', '应用正在退出。')
    if (
      ['login', 'probe', 'collectionStart', 'favoritesStart', 'unlikeStart', 'collectPage'].includes(
        command
      ) ||
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
        'importCommit',
        'deleteLocal',
        'unlikeVerify'
      ].includes(command)
    )
      throw new AppError('BUSY', '请先停止取消点赞任务，等待当前请求结果保存。')
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
        return this.run(input.accountId, async () => {
          const target = this.engine.recoveryTarget(input.accountId)
          await this.authentication.open(
            input.accountId,
            target && target.operation !== 'self' ? 'verification' : 'login',
            target
          )
          return null
        })
      case 'renameAccount':
        return this.accounts.rename(input.accountId, input.name)
      case 'logoutAccount':
      case 'removeAccount': {
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
        const paused = Promise.all([this.collection.pause(), this.favorites.pause()])
        this.epoch++
        this.engine.cancel()
        await paused
        return null
      }
      case 'collectPage':
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
      case 'favoritesStart':
        return this.exclusive(async () => {
          await this.active(input.accountId)
          if (this.collection.running || this.unlike.running)
            throw new AppError('BUSY', '请先暂停喜欢采集或取消点赞任务。')
          return this.favorites.start(input.accountId)
        })
      case 'favoritesControl':
        await this.active(input.accountId)
        if (input.action === 'resume' && (this.collection.running || this.unlike.running))
          throw new AppError('BUSY', '请先暂停喜欢采集或取消点赞任务。')
        return input.action === 'resume'
          ? this.exclusive(() => {
              if (this.collection.running || this.unlike.running)
                throw new AppError('BUSY', '其他任务正在运行。')
              return this.favorites.control(input.accountId, input.taskId, input.action)
            })
          : this.favorites.control(input.accountId, input.taskId, input.action)
      case 'collectionStart':
        return this.exclusive(async () => {
          if (this.unlike.running || this.favorites.running)
            throw new AppError('BUSY', '请先停止其他采集或取消点赞任务。')
          await this.active(input.accountId)
          return this.collection.start(input.accountId, input.mode)
        })
      case 'collectionControl':
        await this.active(input.accountId)
        if (input.action === 'resume' && (this.unlike.running || this.favorites.running))
          throw new AppError('BUSY', '请先停止取消点赞任务。')
        if (input.action === 'resume')
          return this.exclusive(() => {
            if (this.unlike.running || this.favorites.running)
              throw new AppError('BUSY', '请先停止收藏同步或取消点赞任务。')
            return this.collection.control(input.accountId, input.taskId, input.action)
          })
        return this.collection.control(input.accountId, input.taskId, input.action)
      case 'unlikeStart':
        await this.active(input.accountId)
        await Promise.all([this.collection.pause(), this.favorites.pause()])
        await this.lane.idle()
        return this.exclusive(async () => {
          await this.active(input.accountId)
          if (this.lane.pending || this.collection.running || this.favorites.running)
            throw new AppError('BUSY', '请等待当前页面请求结束。')
          return this.unlike.start(input.accountId, input.workIds, input.mode)
        })
      case 'unlikeControl': {
        await this.active(input.accountId)
        if (input.action === 'resume') {
          await Promise.all([this.collection.pause(), this.favorites.pause()])
          await this.lane.idle()
          return this.exclusive(async () => {
            await this.active(input.accountId)
            if (this.lane.pending || this.collection.running || this.favorites.running)
              throw new AppError('BUSY', '请等待当前页面请求结束。')
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
            this.mediaEpoch++
            if (this.activeMedia) this.engine.cancel()
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
      case 'exportLibrary':
        return this.files.export(input.accountId, input.source)
      case 'importLibrary':
        return this.files.prepareImport(input.accountId)
      case 'importCommit':
        return this.files.commit(input.accountId, input.token)
      case 'importCancel':
        return this.files.cancel(input.token)
      case 'backup':
        return this.database.call('backup', { reason: 'manual' })
      case 'dataInfo':
        if (input.accountId) await this.active(input.accountId)
        return this.maintenance.info(input.accountId)
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
        return this.run(input.accountId, async (check) => {
          const guard = () => {
            check()
            if (epoch !== this.mediaEpoch) throw new AppError('CANCELLED', '已切换播放目标，旧取链已取消。')
          }
          guard()
          if (input.playback) {
            const queue = await this.database.call('queueState', { accountId: input.accountId })
            if (
              !queue ||
              queue.queueId !== input.playback.queueId ||
              queue.revision !== input.playback.revision ||
              ![queue.work.id, queue.next?.id].includes(input.workId)
            )
              throw new AppError('QUEUE_CHANGED', '播放目标已变化，旧取链已丢弃。')
          }
          guard()
          this.activeMedia = true
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
            return media
          } finally {
            this.activeMedia = false
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
