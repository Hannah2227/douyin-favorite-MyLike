import type { Snapshot } from '../shared/contracts'
import type { AccessEvent, AccessTarget } from './douyin/page-state'
import type { DouyinEngine } from './douyin/engine'
import { AppError, publicError } from './errors'

type Session = {
  accountId: string
  kind: 'login' | 'verification'
  target: AccessTarget | null
  revision: number
  expires: number
}
type Runner = <T>(accountId: string, action: (check: () => void) => Promise<T>) => Promise<T>

/** A bounded, account-scoped interaction. Probes use the same request lane as
 * business operations; completion never resumes a task or repeats a write. */
export class Authentication {
  private current: Session | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private state: Snapshot['authentication'] = null
  private checking = false
  constructor(
    private readonly engine: Pick<DouyinEngine, 'show' | 'hide' | 'setInteraction' | 'pageState'>,
    private readonly run: Runner,
    private readonly probe: (
      accountId: string,
      target: AccessTarget | null,
      check: () => void
    ) => Promise<void>,
    private readonly changed: () => void
  ) {}
  snapshot() {
    return this.state
  }
  target(accountId: string) {
    return this.current?.accountId === accountId ? this.current.target : null
  }
  handle(event: AccessEvent) {
    if (event.type === 'closed') {
      if (this.current?.accountId === event.accountId) this.stop()
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
        this.schedule(this.current, 1200)
        await this.engine.show(accountId)
      }
      return
    }
    this.stop()
    const session: Session = { accountId, kind, target, revision: 0, expires: Date.now() + 10 * 60_000 }
    this.current = session
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
        this.schedule(session, 1200)
      }
    } catch (error) {
      if (this.current === session) this.update(session, 'failed', publicError(error).message)
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
      this.schedule(session, 1200)
      return
    }
    if (Date.now() >= session.expires) {
      this.update(session, 'failed', '自动检测已暂停，请完成操作后关闭窗口，再点“核验登录”或重新打开窗口。')
      return
    }
    this.checking = true
    const revision = session.revision
    const valid = () => {
      if (this.current !== session || revision !== session.revision)
        throw new AppError('CANCELLED', '登录或验证检测已取消。')
    }
    let delay = 5000
    try {
      const state = await this.engine.pageState(session.accountId)
      valid()
      if (!state.ready || state.captcha) {
        delay = 2000
        return
      }
      this.update(session, 'checking', '正在核验账号及接口状态，请稍候。')
      await this.run(session.accountId, async (check) => {
        const guard = () => {
          check()
          valid()
        }
        guard()
        await this.probe(session.accountId, session.target, guard)
        guard()
        const after = await this.engine.pageState(session.accountId)
        guard()
        if (!after.ready || after.captcha)
          throw new AppError('VERIFICATION_REQUIRED', '请先完成窗口中的验证。')
        this.engine.hide(session.accountId)
        this.stop()
      })
    } catch (error) {
      if (this.current !== session) return
      const detail = publicError(error)
      const needsDecision = ['IDENTITY_MISMATCH', 'DUPLICATE_ACCOUNT', 'WORK_UNAVAILABLE'].includes(
        detail.code
      )
      delay = needsDecision || ['RATE_LIMITED', 'API_REJECTED'].includes(detail.code) ? 30_000 : 5000
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
