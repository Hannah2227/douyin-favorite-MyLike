import { BrowserWindow, session } from 'electron'
import { randomUUID } from 'node:crypto'
import type { EngineStatus } from '../../shared/contracts'
import { AppError } from '../errors'
import { buildPageScript, serializeForScript, type Operation } from './page-request'
import { parseResponse } from './parse'
import { quietMediaScript } from './page-media'

const allowedPage = (value: string): boolean => {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      ['douyin.com', 'bytedance.com', 'snssdk.com', 'toutiao.com'].some(
        (host) => url.hostname === host || url.hostname.endsWith('.' + host)
      )
    )
  } catch {
    return false
  }
}
const guardedSessions = new WeakSet<Electron.Session>()

export class DouyinEngine {
  private window: BrowserWindow | null = null
  private accountId: string | null = null
  private status: EngineStatus = 'stopped'
  private generation = 0
  private requestGeneration: number | null = null
  private starting: Promise<BrowserWindow> | null = null
  private cancelRequest: ((reason?: AppError) => void) | null = null
  private idle: ReturnType<typeof setTimeout> | null = null
  constructor(
    private readonly changed: () => void,
    private readonly parent: () => BrowserWindow | null
  ) {}
  snapshot() {
    return { status: this.status, accountId: this.accountId }
  }
  private partition(accountId: string): Electron.Session {
    const partition = session.fromPartition(`persist:mylike-${accountId}`)
    if (!guardedSessions.has(partition)) {
      partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      partition.setPermissionCheckHandler(() => false)
      partition.on('will-download', (event) => event.preventDefault())
      guardedSessions.add(partition)
    }
    return partition
  }
  private update(status: EngineStatus) {
    this.status = status
    this.changed()
  }
  private disarmIdle() {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
  }
  private armIdle() {
    this.disarmIdle()
    this.idle = setTimeout(() => {
      if (this.window && !this.window.isVisible()) this.release()
    }, 180_000)
    this.idle.unref()
  }
  async ensure(accountId: string): Promise<BrowserWindow> {
    this.disarmIdle()
    if (this.accountId !== accountId) this.release()
    if (this.starting) return this.starting
    if (this.window && !this.window.isDestroyed() && this.status !== 'failed') return this.window
    if (this.window) this.release()
    this.accountId = accountId
    const partition = this.partition(accountId)
    const win = new BrowserWindow({
      width: 1120,
      height: 800,
      show: false,
      title: '抖音登录 / 验证 — MyLike',
      ...(this.parent() ? { parent: this.parent()! } : {}),
      webPreferences: {
        session: partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // The SDK engine does not render 3D content. Keep GPU features in the local player.
        webgl: false,
        backgroundThrottling: false,
        autoplayPolicy: 'user-gesture-required'
      }
    })
    this.window = win
    win.webContents.setAudioMuted(true)
    win.webContents.on('dom-ready', () => {
      void win.webContents.executeJavaScript(quietMediaScript).catch(() => {})
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event, url) => {
      if (!allowedPage(url)) event.preventDefault()
    })
    win.webContents.on('will-redirect', (event, url) => {
      if (!allowedPage(url)) event.preventDefault()
    })
    win.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
      if (isMainFrame && !inPlace) {
        this.generation++
        if (this.requestGeneration !== null)
          this.cancelRequest?.(new AppError('PAGE_CHANGED', '抖音页面发生导航，本次响应已丢弃。'))
      }
    })
    win.webContents.on('render-process-gone', () => {
      if (this.window !== win) return
      this.cancelRequest?.(
        new AppError('BROWSER_CRASHED', '抖音页面意外停止，已保留已提交进度；请重试或手动继续任务。')
      )
      this.update('failed')
    })
    win.on('close', (event) => {
      event.preventDefault()
      win.hide()
      // Hiding a crashed window must not make its dead renderer reusable.
      if (this.status !== 'failed') this.update('ready')
      this.armIdle()
    })
    this.update('starting')
    this.starting = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          win.loadURL('https://www.douyin.com/user/self?showTab=like'),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new AppError('BROWSER_NOT_READY', '抖音页面加载超时，请打开窗口检查网络后重试。')),
              35_000
            )
          })
        ])
        if (win.isDestroyed() || this.window !== win) throw new AppError('CANCELLED', '页面初始化已取消。')
        this.update(win.isVisible() ? 'visible' : 'ready')
        this.armIdle()
        return win
      } catch (error) {
        if (this.window === win) this.update('failed')
        if (error instanceof AppError) throw error
        throw new AppError('BROWSER_NOT_READY', '抖音页面未加载成功，请检查网络后重新打开。')
      } finally {
        if (timeout) clearTimeout(timeout)
        if (this.window === win) this.starting = null
      }
    })()
    return this.starting
  }
  async show(accountId: string): Promise<void> {
    const ready = this.ensure(accountId)
    this.window?.show()
    this.window?.focus()
    await ready
    this.update('visible')
  }
  async request(
    accountId: string,
    operation: Operation,
    parameters: Record<string, string> = {}
  ): Promise<Record<string, any>> {
    const ready = this.ensure(accountId)
    const id = randomUUID(),
      timeoutMs = 12_000
    let win: BrowserWindow | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const cancelled = new Promise<never>((_resolve, reject) => {
      this.cancelRequest = (reason = new AppError('CANCELLED', '请求已停止，未推进采集断点。')) => {
        if (win && !win.isDestroyed())
          void win.webContents
            .executeJavaScript(`globalThis.__mylikeRequests?.get(${serializeForScript(id)})?.abort()`)
            .catch(() => {})
        reject(reason)
      }
    })
    let generation: number | null = null
    try {
      win = await Promise.race([ready, cancelled])
      this.disarmIdle()
      generation = this.generation
      this.requestGeneration = generation
      timer = setTimeout(() => {
        this.cancelRequest?.(new AppError('TIMEOUT', '接口响应超时，请检查登录、网络或人工验证。'))
      }, timeoutMs + 1500)
      const reply = await Promise.race([
        win.webContents.executeJavaScript(buildPageScript({ id, operation, parameters, timeout: timeoutMs })),
        cancelled
      ])
      if (this.window !== win || this.accountId !== accountId)
        throw new AppError('CANCELLED', '页面或账号已变化，旧响应已丢弃。')
      if (generation !== this.generation)
        throw new AppError('PAGE_CHANGED', '抖音页面发生导航，本次响应已丢弃。')
      if (!reply || reply.id !== id) throw new AppError('INVALID_RESPONSE', '请求关联校验失败。')
      if (reply.error)
        throw new AppError(
          reply.error === 'TIMEOUT' ? 'TIMEOUT' : 'NETWORK_ERROR',
          '接口未正常返回，请检查抖音窗口后重试。'
        )
      if (typeof reply.body !== 'string' || typeof reply.status !== 'number')
        throw new AppError('INVALID_RESPONSE', '接口响应格式不正确。')
      return parseResponse(reply.body, reply.status)
    } catch (error) {
      if (
        !(error instanceof AppError) &&
        generation !== null &&
        this.window === win &&
        generation !== this.generation
      )
        throw new AppError('PAGE_CHANGED', '抖音页面发生导航，本次响应已丢弃。')
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      this.cancelRequest = null
      this.requestGeneration = null
      this.armIdle()
    }
  }
  cancel(): void {
    this.cancelRequest?.()
  }
  release(): void {
    this.disarmIdle()
    this.cancel()
    this.generation++
    const win = this.window
    this.window = null
    this.starting = null
    this.accountId = null
    win?.destroy()
    this.update('stopped')
  }
  async logout(accountId: string): Promise<void> {
    try {
      const partition = this.partition(accountId)
      await partition.clearData()
      await partition.clearAuthCache()
    } catch {
      throw new AppError('LOGOUT_FAILED', '会话清理未能完成，请重试；本地列表已保留。')
    }
  }
  async purgeAccount(accountId: string): Promise<void> {
    try {
      const partition = this.partition(accountId)
      await partition.closeAllConnections()
      await partition.clearData()
      await partition.clearAuthCache()
      await partition.clearCache()
      await partition.clearCodeCaches({})
      await session.fromPartition('persist:mylike-ui').clearCache()
      partition.flushStorageData()
    } catch {
      throw new AppError(
        'ACCOUNT_SESSION_PURGE_FAILED',
        '账号会话或缓存清理未完成，本地账号记录仍保留，请稍后重试。'
      )
    }
  }
  async clearCaches(accountId: string): Promise<void> {
    try {
      const account = this.partition(accountId),
        ui = session.fromPartition('persist:mylike-ui')
      await Promise.all([
        account.clearCache(),
        account.clearCodeCaches({}),
        ui.clearCache(),
        ui.clearCodeCaches({})
      ])
    } catch {
      throw new AppError('CACHE_CLEAR_FAILED', '缓存未能完整清理，请稍后重试；本地数据和登录凭据未主动清理。')
    }
  }
  async cacheSize(accountId: string | null): Promise<number> {
    const ui = await session.fromPartition('persist:mylike-ui').getCacheSize()
    return ui + (accountId ? await this.partition(accountId).getCacheSize() : 0)
  }
}
