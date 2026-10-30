import type { RecoveryState } from '../shared/recovery-state'
import { AppError } from './errors'
import { retryableRead, rebuildReadPage, readRetryDelay } from './read-recovery'

const restrictedCodes = new Set(['RATE_LIMITED', 'UPSTREAM_RISK_CONTROL'])
const baseWait = 60_000
const maxWait = 10 * 60_000

/** Account/operation-scoped admission for real platform refusals.
 * Navigation, login and a successful different endpoint never clear this state.
 * Expired entries retain their failure streak until that same operation succeeds. */
export class RecoveryGate {
  private readonly entries = new Map<string, { state: RecoveryState; failures: number }>()
  constructor(private readonly now: () => number = () => Date.now()) {}
  private key(accountId: string, operation: string): string {
    return JSON.stringify([accountId, operation])
  }
  assertReady(accountId: string, operation: string): void {
    const entry = this.entries.get(this.key(accountId, operation))
    if (entry && entry.state.retryAt > this.now())
      throw new AppError(
        entry.state.code,
        '抖音暂时无法处理这项操作，请稍后重试。',
        undefined,
        entry.state.retryAt
      )
  }
  failure(accountId: string, operation: string, code: string): RecoveryState | null {
    if (!restrictedCodes.has(code)) return null
    const key = this.key(accountId, operation)
    const previous = this.entries.get(key)
    const failures = Math.min((previous?.failures ?? 0) + 1, 20)
    const state = {
      accountId,
      operation,
      code,
      retryAt: this.now() + Math.min(baseWait * 2 ** (failures - 1), maxWait)
    }
    this.entries.set(key, { state, failures })
    return { ...state }
  }
  success(accountId: string, operation: string): void {
    this.entries.delete(this.key(accountId, operation))
  }
  snapshot(accountId: string): RecoveryState[] {
    const now = this.now()
    return [...this.entries.values()]
      .filter((entry) => entry.state.accountId === accountId && entry.state.retryAt > now)
      .map((entry) => ({ ...entry.state }))
  }
}

export interface ReadRecoveryDecision {
  delay: number
  rebuild: boolean
  activity: 'waiting' | 'cooling'
}

/** Only read-only collectors can use this budget; writes never enter it. */
export function readRecovery(input: {
  source: 'likes' | 'favorites'
  code: string
  retries: number
  baseDelay: number
  visible: boolean
}): ReadRecoveryDecision | null {
  const { source, code, retries, baseDelay, visible } = input
  if (source === 'favorites') {
    if (retries >= 1 || !['NETWORK_ERROR', 'TIMEOUT', 'BROWSER_NOT_READY', 'PAGE_CHANGED'].includes(code))
      return null
    return {
      delay: baseDelay,
      rebuild: !visible && ['BROWSER_NOT_READY', 'PAGE_CHANGED'].includes(code),
      activity: 'waiting'
    }
  }
  if (retries >= 2 || !retryableRead(code)) return null
  return {
    delay: readRetryDelay(code, retries, baseDelay),
    rebuild: rebuildReadPage(code, retries, visible),
    activity: ['EMPTY_PAGE', 'EMPTY_RESPONSE'].includes(code) ? 'cooling' : 'waiting'
  }
}
