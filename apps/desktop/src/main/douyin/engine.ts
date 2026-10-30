import { BrowserWindow, session } from 'electron'
import { randomUUID } from 'node:crypto'
import type { EngineStatus } from '../../shared/contracts'
import { AppError } from '../errors'
import { buildPageScript, serializeForScript, isWriteOperation, type Operation } from './page-request'
import {
  parseResponse,
  parseIdentity,
  parseLikedPage,
  parseFavoritesPage,
  parseFavoriteFolders
} from './parse'
import { quietMediaScript } from './page-media'
import { pageStateScript, type AccessEvent, type AccessTarget, type PageState } from './page-state'
import type { RuntimeEventInput } from '../../shared/runtime-events'
import { responseSummary } from './response-summary'
import { failureResponseType, failureRule } from './response-policy'
import { RecoveryGate } from '../recovery'
import type { RecoveryState } from '../../shared/recovery-state'

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
type PageReply = { id?: unknown; error?: unknown; body?: unknown; status?: unknown }

export class DouyinEngine {
  private readonly recoveryGate = new RecoveryGate()
  private window: BrowserWindow | null = null
  private accountId: string | null = null
  private status: EngineStatus = 'stopped'
  private documentCommitted = false
  private generation = 0
  private requestGeneration: number | null = null
  private starting: Promise<BrowserWindow> | null = null
  private cancelStart: ((reason?: AppError) => void) | null = null
  private cancelRequest: ((reason?: AppError) => void) | null = null
  private idle: ReturnType<typeof setTimeout> | null = null
  private monitor: ReturnType<typeof setTimeout> | null = null
  private attention: ((event: AccessEvent) => void) | null = null
  private interaction: 'login' | 'verification' | null = null
  private suppressed = false
  private challengeSeen = false
  private operation: Operation | null = null
  private target: AccessTarget = { operation: 'self', parameters: {} }
  private failedTarget: AccessTarget | null = null
  private recoveryRequest = false
  private observer: ((accountId: string, event: RuntimeEventInput) => void) | null = null
  constructor(
    private readonly changed: () => void,
    private readonly parent: () => BrowserWindow | null
  ) {}
  snapshot() {
    return { status: this.status, accountId: this.accountId }
  }
  assertAvailable(accountId: string, operation: string): void {
    this.recoveryGate.assertReady(accountId, operation)
  }
  recovery(accountId: string): RecoveryState[] {
    return this.recoveryGate.snapshot(accountId)
  }
  setObserver(observer: ((accountId: string, event: RuntimeEventInput) => void) | null) {
    this.observer = observer
  }
  cancelRecovery(accountId: string) {
    if (this.accountId === accountId && this.recoveryRequest)
      this.cancelRequest?.(new AppError('CANCELLED', '登录态已变化，重新核验当前身份。'))
  }
  setAttentionHandler(handler: (event: AccessEvent) => void) {
    this.attention = handler
  }
  private async executeInPage<T = unknown>(win: BrowserWindow, code: string): Promise<T> {
    // WebContents.executeJavaScript waits for all page resources. The main
    // frame API runs in the same page/SDK context once the DOM is available.
    return (await win.webContents.mainFrame.executeJavaScript(code)) as T
  }
  setInteraction(kind: 'login' | 'verification' | null) {
    this.interaction = kind
  }
  allowAttention() {
    this.suppressed = false
  }
  recoveryTarget(accountId: string) {
    return this.accountId === accountId ? this.failedTarget : null
  }
  dismissAttention(accountId: string) {
    this.suppressed = true
    this.hide(accountId, false)
    this.attention?.({ type: 'closed', accountId })
  }
  requireAttention(accountId: string, kind: 'login' | 'verification', target = this.target) {
    if (!this.suppressed) this.attention?.({ type: 'required', accountId, kind, target })
  }
  async pageState(accountId: string): Promise<PageState> {
    const win = this.window,
      generation = this.generation
    if (
      !win ||
      win.isDestroyed() ||
      !this.documentCommitted ||
      this.accountId !== accountId ||
      !allowedPage(win.webContents.getURL())
    )
      return { ready: false, captcha: false }
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        this.executeInPage<Partial<PageState> | null>(win, pageStateScript),
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => resolve(null), 1500)
        })
      ])
      if (this.window !== win || this.generation !== generation || this.accountId !== accountId)
        return { ready: false, captcha: false }
      return { ready: result?.ready === true, captcha: result?.captcha === true }
    } catch {
      return { ready: false, captcha: false }
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
  private watch(win: BrowserWindow, accountId: string) {
    if (this.monitor) clearTimeout(this.monitor)
    this.monitor = setTimeout(async () => {
      this.monitor = null
      const state = await this.pageState(accountId)
      if (this.window !== win || win.isDestroyed()) return
      if (state.ready && state.captcha && !this.challengeSeen) {
        this.challengeSeen = true
        // Never interrupt a write whose remote result may still arrive.
        if (this.operation && !isWriteOperation(this.operation))
          this.cancelRequest?.(
            new AppError('VERIFICATION_REQUIRED', '检测到安全验证，已保留进度；请在抖音窗口完成验证。')
          )
        this.requireAttention(accountId, 'verification')
      } else if (state.ready && !state.captcha) this.challengeSeen = false
      this.watch(win, accountId)
    }, 1200)
    this.monitor.unref()
  }
  hide(accountId: string, verified = true) {
    if (this.accountId !== accountId || !this.window || this.window.isDestroyed()) return
    if (verified) this.failedTarget = null
    void this.executeInPage(this.window, quietMediaScript).catch(() => {})
    this.window.hide()
    if (this.status !== 'failed') this.update('ready')
    this.armIdle()
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
    const interaction = this.interaction
    if (this.accountId !== accountId) this.release(false)
    if (this.starting) return this.starting
    if (this.window && !this.window.isDestroyed() && this.status !== 'failed') return this.window
    if (this.window) this.release(false)
    this.interaction = interaction
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
    this.documentCommitted = false
    const fail = (error: AppError) => {
      if (this.window !== win) return
      this.documentCommitted = false
      this.update('failed')
      this.observer?.(accountId, {
        kind: 'engine',
        message: error.message,
        code: error.code,
        rule: failureRule(error)
      })
      this.cancelStart?.(error)
      this.cancelRequest?.(error)
    }
    const credentials = new Map<string, string>()
    const onCookieChanged = (
      _event: Electron.Event,
      cookie: Electron.Cookie,
      _cause: string,
      removed: boolean
    ) => {
      if (
        this.window !== win ||
        this.interaction !== 'login' ||
        removed ||
        !['sessionid', 'sessionid_ss', 'sid_guard', 'uid_tt', 'uid_tt_ss'].includes(cookie.name) ||
        !/(^|\.)douyin\.com$/.test(cookie.domain?.replace(/^\./, '') ?? '')
      )
        return
      if (credentials.get(cookie.name) === cookie.value) return
      credentials.set(cookie.name, cookie.value)
      this.attention?.({ type: 'changed', accountId })
    }
    partition.cookies.on('changed', onCookieChanged)
    win.once('closed', () => {
      partition.cookies.removeListener('changed', onCookieChanged)
      credentials.clear()
    })
    win.webContents.setAudioMuted(true)
    win.webContents.on('dom-ready', () => {
      if (this.window !== win || !this.documentCommitted) return
      // A manual reload may recover a failed document in the same window.
      if (this.status === 'failed') {
        this.update(win.isVisible() ? 'visible' : 'ready')
        this.watch(win, accountId)
      }
      void this.executeInPage(win, quietMediaScript).catch(() => {})
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
        this.documentCommitted = false
        this.generation++
        if (this.requestGeneration !== null)
          this.cancelRequest?.(new AppError('PAGE_CHANGED', '抖音页面发生导航，本次响应已丢弃。'))
      }
    })
    win.webContents.on('did-navigate', (_event, url, responseCode) => {
      if (this.window !== win) return
      // A 4xx response can still contain an interactive login or challenge.
      // Keep its document available to the existing identity/captcha checks.
      if (responseCode >= 500) {
        fail(
          new AppError(
            'BROWSER_NOT_READY',
            `抖音页面加载失败（HTTP ${responseCode}），请检查网络后重新打开。`,
            'http.error'
          )
        )
        return
      }
      this.documentCommitted = allowedPage(url)
    })
    win.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      // Redirects and intentional navigation replacement report ERR_ABORTED.
      if (!isMainFrame || code === -3) return
      const name = /^ERR_[A-Z0-9_]{1,60}$/.test(description) ? description : 'ERR_UNKNOWN'
      fail(
        new AppError(
          'BROWSER_NOT_READY',
          `抖音页面加载失败（${name}，${code}），请检查网络或代理后重新打开。`,
          'transport.network'
        )
      )
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      fail(
        new AppError(
          'BROWSER_CRASHED',
          `抖音页面进程意外停止（${details.reason}，退出码 ${details.exitCode}），已保存进度保留；请重新打开窗口。`
        )
      )
    })
    win.on('close', (event) => {
      event.preventDefault()
      if (this.window === win && this.starting) {
        this.release()
        return
      }
      win.hide()
      this.suppressed = true
      this.interaction = null
      this.attention?.({ type: 'closed', accountId })
      // Hiding a crashed window must not make its dead renderer reusable.
      if (this.status !== 'failed') this.update('ready')
      this.armIdle()
    })
    this.update('starting')
    this.starting = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      let onDomReady: () => void = () => {}
      let onLoaded: () => void = () => {}
      try {
        const cancelled = new Promise<never>((_resolve, reject) => {
          this.cancelStart = (reason = new AppError('CANCELLED', '抖音窗口初始化已取消。')) => reject(reason)
        })
        const documentReady = new Promise<void>((resolve) => {
          onLoaded = () => {
            // Chromium's error document also emits dom-ready and can retain
            // the requested HTTPS URL. Require a successful main-frame commit.
            if (
              this.window === win &&
              !win.isDestroyed() &&
              this.documentCommitted &&
              allowedPage(win.webContents.getURL())
            )
              resolve()
          }
          // Interactive login can probe as soon as the DOM exists. Hidden
          // collection still waits for page scripts/SDK initialization.
          onDomReady = () => {
            if (this.interaction) onLoaded()
          }
          win.webContents.on('dom-ready', onDomReady)
          win.webContents.on('did-finish-load', onLoaded)
        })
        await Promise.race([
          cancelled,
          documentReady,
          win
            .loadURL('https://www.douyin.com/user/self?showTab=like')
            .then(() => documentReady)
            .catch((error) => {
              // QR login can replace the initial navigation. Its replacement
              // document, rather than the aborted load, decides readiness.
              if (error.code === 'ERR_ABORTED' || error.errno === -3) return documentReady
              throw error
            }),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new AppError('BROWSER_NOT_READY', '抖音页面加载超时，请打开窗口检查网络后重试。')),
              35_000
            )
          })
        ])
        if (win.isDestroyed() || this.window !== win) throw new AppError('CANCELLED', '页面初始化已取消。')
        this.update(win.isVisible() ? 'visible' : 'ready')
        this.watch(win, accountId)
        this.armIdle()
        return win
      } catch (error) {
        if (this.window === win) this.update('failed')
        if (error instanceof AppError) throw error
        throw new AppError('BROWSER_NOT_READY', '抖音页面未加载成功，请检查网络后重新打开。')
      } finally {
        if (timeout) clearTimeout(timeout)
        if (!win.isDestroyed()) {
          win.webContents.removeListener('dom-ready', onDomReady)
          win.webContents.removeListener('did-finish-load', onLoaded)
        }
        if (this.window === win) {
          this.starting = null
          this.cancelStart = null
        }
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
    parameters: Record<string, string> = {},
    options: { recovery?: boolean; loginCheck?: boolean } = {}
  ): Promise<Record<string, any>> {
    // Refusing a local early retry does not load a page, observe a new failure,
    // or extend the original waiting period.
    this.assertAvailable(accountId, operation)
    const started = Date.now()
    let summary: Pick<RuntimeEventInput, 'responseType' | 'count' | 'shape' | 'rule' | 'platformCode'> = {
      responseType: 'no-response'
    }
    let status: number | undefined, code: string | undefined, failureMessage: string | undefined
    const ready = this.ensure(accountId)
    this.recoveryRequest = options.recovery === true
    const id = randomUUID(),
      timeoutMs = 12_000
    let win: BrowserWindow | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const cancelled = new Promise<never>((_resolve, reject) => {
      this.cancelRequest = (reason = new AppError('CANCELLED', '请求已停止，未推进采集断点。')) => {
        if (win && !win.isDestroyed())
          void this.executeInPage(
            win,
            `globalThis.__mylikeRequests?.get(${serializeForScript(id)})?.abort()`
          ).catch(() => {})
        reject(reason)
      }
    })
    let generation: number | null = null
    try {
      win = await Promise.race([ready, cancelled])
      const target: AccessTarget =
        operation === 'favoriteFolderCreate'
          ? { operation: 'folders', parameters: { cursor: '0', count: '20' } }
          : isWriteOperation(operation)
            ? { operation: 'detail', parameters: { aweme_id: parameters.aweme_id ?? '' } }
            : { operation, parameters: { ...parameters } }
      if (!options.recovery) this.target = target
      if (!options.recovery && this.interaction) {
        this.requireAttention(accountId, this.interaction, target)
        throw new AppError(
          this.interaction === 'login' ? 'AUTH_REQUIRED' : 'VERIFICATION_REQUIRED',
          '请先在抖音窗口完成登录或验证，再手动继续任务。'
        )
      }
      const before = await this.pageState(accountId)
      if (!before.ready) throw new AppError('BROWSER_NOT_READY', '抖音页面尚未就绪，请稍候再试。')
      if (before.captcha) {
        if (!options.recovery) this.requireAttention(accountId, 'verification', target)
        throw new AppError('VERIFICATION_REQUIRED', '检测到安全验证，当前进度未推进，请完成验证后继续。')
      }
      this.disarmIdle()
      generation = this.generation
      this.requestGeneration = generation
      this.operation = operation
      timer = setTimeout(() => {
        this.cancelRequest?.(new AppError('TIMEOUT', '接口响应超时，请检查登录、网络或人工验证。'))
      }, timeoutMs + 1500)
      const reply = await Promise.race([
        this.executeInPage<PageReply>(
          win,
          buildPageScript({ id, operation, parameters, timeout: timeoutMs })
        ),
        cancelled
      ])
      if (this.window !== win || this.accountId !== accountId)
        throw new AppError('CANCELLED', '页面或账号已变化，旧响应已丢弃。')
      if (generation !== this.generation)
        throw new AppError('PAGE_CHANGED', '抖音页面发生导航，本次响应已丢弃。')
      if (!reply || reply.id !== id)
        throw new AppError('INVALID_RESPONSE', '请求关联校验失败。', 'request.mismatch')
      if (reply.error === 'TOO_LARGE')
        throw new AppError('INVALID_RESPONSE', '接口响应过大，已停止处理。', 'body.oversized')
      if (reply.error)
        throw new AppError(
          reply.error === 'TIMEOUT' ? 'TIMEOUT' : 'NETWORK_ERROR',
          '接口未正常返回，请检查抖音窗口后重试。'
        )
      if (typeof reply.body !== 'string' || typeof reply.status !== 'number')
        throw new AppError('INVALID_RESPONSE', '接口响应格式不正确。')
      status = reply.status
      summary = responseSummary(reply.body, reply.status, operation)
      const data = parseResponse(reply.body, reply.status, { operation, workId: parameters.aweme_id })
      if (operation === 'self') parseIdentity(data)
      // Preserve a confirmed write promptly. A challenge detected afterward
      // affects subsequent operations, not this response's known outcome.
      if (isWriteOperation(operation)) {
        if (String(data.status_code) === '0') this.recoveryGate.success(accountId, operation)
        return data
      }
      const after = await this.pageState(accountId)
      if (this.window !== win || this.accountId !== accountId)
        throw new AppError('CANCELLED', '账号已变化，旧响应已丢弃。')
      if (generation !== this.generation) throw new AppError('PAGE_CHANGED', '抖音页面已导航，旧响应已丢弃。')
      if (after.captcha) {
        if (!options.recovery) this.requireAttention(accountId, 'verification')
        throw new AppError('VERIFICATION_REQUIRED', '检测到安全验证，当前响应未提交，请完成验证后继续。')
      }
      // JSON alone is not proof that the original collection endpoint recovered.
      if (operation === 'likes') parseLikedPage(data, { allowEmpty: true })
      if (operation === 'favorites' || operation === 'folderItems')
        parseFavoritesPage(data, { allowEmpty: true })
      if (operation === 'folders') parseFavoriteFolders(data, { allowEmpty: true })
      if (!options.recovery && this.failedTarget?.operation === operation) this.failedTarget = null
      this.recoveryGate.success(accountId, operation)
      return data
    } catch (caught) {
      const error =
        !(caught instanceof AppError) &&
        generation !== null &&
        this.window === win &&
        generation !== this.generation
          ? new AppError('PAGE_CHANGED', '抖音页面发生导航，本次响应已丢弃。')
          : caught
      code = error instanceof AppError ? error.code : 'INTERNAL_ERROR'
      // API rejections, empty replies and timeouts can accompany an in-page
      // challenge. DOM evidence upgrades those failures instead of guessing.
      let failure = error
      if (
        error instanceof AppError &&
        !['CANCELLED', 'BROWSER_CRASHED', 'PAGE_CHANGED'].includes(error.code)
      ) {
        if (error.code !== 'VERIFICATION_REQUIRED' && (await this.pageState(accountId)).captcha)
          failure = new AppError('VERIFICATION_REQUIRED', '检测到安全验证，请在抖音窗口完成后继续。')
        if (
          !options.recovery &&
          failure instanceof AppError &&
          failure.code !== 'CONTENT_UNAVAILABLE' &&
          (!this.interaction || !this.failedTarget || this.failedTarget.operation === 'self')
        )
          this.failedTarget = this.target
        if (
          !options.recovery &&
          failure instanceof AppError &&
          ['AUTH_REQUIRED', 'VERIFICATION_REQUIRED'].includes(failure.code)
        )
          this.requireAttention(accountId, failure.code === 'AUTH_REQUIRED' ? 'login' : 'verification')
      }
      if (failure instanceof AppError) code = failure.code
      const waiting = this.recoveryGate.failure(accountId, operation, code!)
      if (waiting && failure instanceof AppError)
        failure = new AppError(failure.code, failure.message, failure.rule, waiting.retryAt)
      failureMessage = failure instanceof AppError ? failure.message : '请求处理失败，请查看错误码。'
      if (
        code === 'CONTENT_UNAVAILABLE' &&
        this.failedTarget?.operation === operation &&
        this.failedTarget.parameters.aweme_id === parameters.aweme_id
      )
        this.failedTarget = null
      const responseType = failureResponseType(code)
      if (responseType) summary = { ...summary, responseType }
      const rule = failureRule(failure)
      if (rule) summary = { ...summary, rule }
      throw failure
    } finally {
      if (timer) clearTimeout(timer)
      this.cancelRequest = null
      this.requestGeneration = null
      this.operation = null
      this.recoveryRequest = false
      if (!(
        options.recovery &&
        options.loginCheck &&
        operation === 'self' &&
        ['AUTH_REQUIRED', 'API_REJECTED'].includes(code ?? '')
      ))
        this.observer?.(accountId, {
          kind: 'request',
          message: failureMessage ?? '接口已返回',
          operation,
          ...summary,
          ...(status === undefined ? {} : { status }),
          ...(code ? { code } : {}),
          durationMs: Date.now() - started
        })
      this.armIdle()
    }
  }
  cancel(): void {
    this.cancelRequest?.()
  }
  release(notify = true): void {
    this.disarmIdle()
    this.cancel()
    this.cancelStart?.()
    this.cancelStart = null
    this.generation++
    const win = this.window
    const accountId = this.accountId
    if (this.monitor) clearTimeout(this.monitor)
    this.monitor = null
    this.interaction = null
    this.suppressed = false
    this.challengeSeen = false
    this.failedTarget = null
    this.target = { operation: 'self', parameters: {} }
    this.window = null
    this.documentCommitted = false
    this.starting = null
    this.accountId = null
    win?.destroy()
    if (accountId && notify) this.attention?.({ type: 'closed', accountId })
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
}
