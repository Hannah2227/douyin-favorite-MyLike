import type { Snapshot } from '../shared/contracts'
import type { AccessEvent, AccessTarget } from './douyin/page-state'
import type { DouyinEngine } from './douyin/engine'
import { AppError, publicError } from './errors'
import type { RuntimeEventInput } from '../shared/runtime-events'

type Session = {
  accountId: string
  kind: 'login' | 'verification'
  target: AccessTarget | null
  revision: number
  expires: number
  retryAfter: number
  lastWake: number
  started: number
}
type Runner = <T>(accountId: string, action: (check: () => void) => Promise<T>) => Promise<T>

// Local DOM checks are cheap; identity requests remain serialized and wait
// for the preceding reply. Rejected/limited APIs retain their long backoff.
const cadence = { initial: 300, page: 500, login: 2000, retry: 3000, rejected: 30_000 }

/** A bounded, account-scoped interaction. Probes use the same request lane as
 * business operations; completion never resumes a task or repeats a write. */
export class Authentication {
  private current: Session | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private state: Snapshot['authentication'] = null
  private checking = false
  constructor(
    private readonly engine: Pick<DouyinEngine, 'show' | 'hide' | 'setInteraction' | 'pageState'> &
      Partial<Pick<DouyinEngine, 'cancelRecovery'>>,
    private readonly run: Runner,
    private readonly probe: (
      accountId: string,
      target: AccessTarget | null,
      check: () => void,
      kind: Session['kind']
    ) => Promise<void>,
    private readonly changed: () => void,
    private readonly report: (accountId: string, event: RuntimeEventInput) => void = () => {}
  ) {}
  snapshot() {
    return this.state
  }
  target(accountId: string) {
    return this.current?.accountId === accountId ? this.current.target : null
  }
  handle(event: AccessEvent) {
    if (event.type === 'changed') {
      const session = this.current
      if (
        !session ||
        session.accountId !== event.accountId ||
        session.kind !== 'login' ||
        Date.now() < session.retryAfter ||
        Date.now() - session.lastWake < 500
      )
        return
      session.lastWake = Date.now()
      session.revision++
      this.engine.cancelRecovery?.(event.accountId)
      this.report(event.accountId, {
        kind: 'auth',
        message: '检测到登录态变化，作废旧核验并立即复查；尚未确认身份。'
      })
      this.schedule(session, 100)
    } else if (event.type === 'closed') {
      if (this.current?.accountId === event.accountId) {
        this.report(event.accountId, {
          kind: 'auth',
          message: '登录 / 验证检测已取消，任务不会自动恢复。',
          code: 'CANCELLED'
        })
        this.stop()
      }
    } else void this.open(event.accountId, event.kind, event.target, true).catch(() => {})
  }
  async open(
    accountId: string,
    kind: Session['kind'],
    target: AccessTarget | null = null,
    automatic = false
  ) {
    if (this.current?.accountId === accountId) {
      if (kind === 'verification') this.current.kind = kind
      // A DOM challenge can be noticed between identity and the list request.
      // Upgrade the completion probe to that list; self alone is insufficient.
      if (
        (!this.current.target || this.current.target.operation === 'self') &&
        target?.operation !== 'self' &&
        target
      ) {
        this.current.target = target
        this.current.revision++
      }
      this.engine.setInteraction(this.current.kind)
      if (!automatic) {
        this.current.expires = Date.now() + 10 * 60_000
        this.current.retryAfter = 0
        this.schedule(this.current, cadence.initial)
        await this.engine.show(accountId)
      }
      return
    }
    this.stop()
    const session: Session = {
      accountId,
      kind,
      target,
      revision: 0,
      expires: Date.now() + 10 * 60_000,
      retryAfter: 0,
      lastWake: 0,
      started: Date.now()
    }
    this.current = session
    this.report(accountId, {
      kind: 'auth',
      message: kind === 'login' ? '开始登录检测。' : '开始人工验证检测，任务保持暂停。'
    })
    this.engine.setInteraction(kind)
    this.update(
      session,
      'waiting',
      kind === 'login'
        ? '请在抖音窗口登录；身份核验成功后窗口会自动收起。'
        : '请在抖音窗口完成验证；原接口恢复后窗口会自动收起，再手动继续任务。'
    )
    try {
      await this.engine.show(accountId)
      if (this.current === session) {
        this.engine.setInteraction(session.kind)
        this.report(accountId, {
          kind: 'auth',
          message: '登录 / 验证页面已就绪。',
          durationMs: Date.now() - session.started
        })
        this.schedule(session, cadence.initial)
      }
    } catch (error) {
      if (this.current === session) {
        const detail = publicError(error)
        this.update(session, 'failed', detail.message)
        this.report(accountId, { kind: 'auth', message: detail.message, code: detail.code })
        // Navigation can fail while the user completes a redirect or reload.
        // Keep checking the same window within the original time budget.
        this.schedule(session, cadence.page)
      }
      throw error
    }
  }
  stop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.current = null
    this.state = null
    this.engine.setInteraction(null)
    this.changed()
  }
  private update(session: Session, status: 'waiting' | 'checking' | 'failed', message: string) {
    this.state = { accountId: session.accountId, kind: session.kind, status, message }
    this.changed()
  }
  private schedule(session: Session, delay: number) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.check(session)
    }, delay)
    this.timer.unref()
  }
  private async check(session: Session) {
    if (this.current !== session) return
    if (this.checking) {
      this.schedule(session, cadence.page)
      return
    }
    if (Date.now() >= session.expires) {
      this.update(session, 'failed', '自动检测已暂停，请完成操作后关闭窗口，再点“核验登录”或重新打开窗口。')
      this.report(session.accountId, {
        kind: 'auth',
        message: '自动检测达到 10 分钟上限，已暂停。',
        code: 'TIMEOUT'
      })
      return
    }
    this.checking = true
    const revision = session.revision
    const valid = () => {
      if (this.current !== session || revision !== session.revision)
        throw new AppError('CANCELLED', '登录或验证检测已取消。')
    }
    let delay = cadence.retry
    try {
      const state = await this.engine.pageState(session.accountId)
      valid()
      if (!state.ready || state.captcha) {
        delay = cadence.page
        return
      }
      this.update(session, 'checking', '正在核验账号及接口状态，请稍候。')
      await this.run(session.accountId, async (check) => {
        const guard = () => {
          check()
          valid()
        }
        guard()
        await this.probe(session.accountId, session.target, guard, session.kind)
        guard()
        const after = await this.engine.pageState(session.accountId)
        guard()
        if (!after.ready || after.captcha)
          throw new AppError('VERIFICATION_REQUIRED', '请先完成窗口中的验证。')
        this.engine.hide(session.accountId)
        this.report(session.accountId, {
          kind: 'auth',
          message: '身份及所需接口核验成功，窗口已自动收起。',
          durationMs: Date.now() - session.started
        })
        this.stop()
      })
    } catch (error) {
      if (this.current !== session) return
      const detail = publicError(error)
      if (['RATE_LIMITED', 'API_REJECTED'].includes(detail.code))
        session.retryAfter = Date.now() + cadence.rejected
      if (!['AUTH_REQUIRED', 'LOGIN_PENDING', 'CANCELLED'].includes(detail.code))
        this.report(session.accountId, { kind: 'auth', message: detail.message, code: detail.code })
      const needsDecision = ['IDENTITY_MISMATCH', 'DUPLICATE_ACCOUNT', 'WORK_UNAVAILABLE'].includes(
        detail.code
      )
      delay =
        needsDecision || ['RATE_LIMITED', 'API_REJECTED'].includes(detail.code)
          ? cadence.rejected
          : ['AUTH_REQUIRED', 'LOGIN_PENDING'].includes(detail.code)
            ? cadence.login
            : ['BROWSER_NOT_READY', 'PAGE_CHANGED', 'VERIFICATION_REQUIRED', 'CANCELLED'].includes(
                  detail.code
                )
              ? cadence.page
              : cadence.retry
      this.update(
        session,
        needsDecision ? 'failed' : 'waiting',
        needsDecision
          ? detail.message
          : session.kind === 'login'
            ? '等待登录完成并核验身份；窗口可手动关闭。'
            : '验证或原接口尚未恢复，请完成验证或稍候；关闭窗口后任务会保持暂停。'
      )
    } finally {
      this.checking = false
      if (this.current === session) this.schedule(session, delay)
    }
  }
}
