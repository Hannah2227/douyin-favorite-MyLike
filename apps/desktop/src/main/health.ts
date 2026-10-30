import { healthStatus, type HealthEntry, type HealthOperation, type HealthSnapshot } from '../shared/health'
const operations = new Set(['self', 'likes', 'favorites', 'folders', 'folderItems'])
const definite = new Set([
  'AUTH_REQUIRED',
  'LOGIN_PENDING',
  'IDENTITY_MISMATCH',
  'DUPLICATE_ACCOUNT',
  'VERIFICATION_REQUIRED',
  'RATE_LIMITED',
  'API_REJECTED',
  'UPSTREAM_CHANGED'
])
const ignored = new Set(['CANCELLED', 'ACCOUNT_CHANGED', 'CLOSING', 'BUSY'])
export class HealthMonitor {
  private accounts = new Map<string, Map<string, HealthEntry>>()
  private manual = new Set<string>()
  private rounds = new Map<string, { baseline: Map<string, number>; failed: Set<string> }>()
  private checked = new Map<string, number>()
  begin(accountId: string) {
    this.manual.add(accountId)
    this.rounds.set(accountId, {
      baseline: new Map(
        [...(this.accounts.get(accountId)?.values() ?? [])].map((e) => [e.operation, e.failures])
      ),
      failed: new Set()
    })
  }
  finish(accountId: string, completed = true) {
    this.manual.delete(accountId)
    if (completed) this.checked.set(accountId, Date.now())
    for (const entry of this.accounts.get(accountId)?.values() ?? [])
      if (entry.status === 'normal') entry.failures = 0
    this.rounds.delete(accountId)
  }
  clear(accountId: string) {
    this.accounts.delete(accountId)
    this.manual.delete(accountId)
    this.checked.delete(accountId)
    this.rounds.delete(accountId)
  }
  observe(
    accountId: string,
    operation: string,
    code?: string,
    retryAt?: number,
    explicit = false,
    rule?: string
  ) {
    if (!operations.has(operation) || (code && ignored.has(code))) return
    // Automatic retries are evidence, but never count as repeated user checks.
    const rows = this.accounts.get(accountId) ?? new Map<string, HealthEntry>()
    const prior = rows.get(operation)
    const round = this.rounds.get(accountId)
    if (!code && round?.failed.has(operation)) return
    const baseline = round?.baseline.get(operation) ?? prior?.failures ?? 0
    const failures = code
      ? Math.max(prior?.failures ?? 0, baseline + (explicit ? 1 : 0))
      : round
        ? baseline
        : 0
    if (code) round?.failed.add(operation)
    const evidence = rule ?? (prior?.code === code ? prior?.rule : undefined)
    const risk = code === 'UPSTREAM_RISK_CONTROL' && evidence === 'envelope.risk_code'
    const status = !code ? 'normal' : definite.has(code) || risk || failures >= 3 ? 'abnormal' : 'uncertain'
    rows.set(operation, {
      operation: operation as HealthOperation,
      status,
      code: code ?? null,
      at: Date.now(),
      failures,
      retryAt,
      rule: rule ?? (code === prior?.code ? prior?.rule : undefined)
    })
    this.accounts.set(accountId, rows)
  }
  snapshot(accountId: string): HealthSnapshot {
    const entries = [...(this.accounts.get(accountId)?.values() ?? [])]
    return {
      accountId,
      entries,
      status: healthStatus(entries),
      checking: this.manual.has(accountId),
      checkedAt: this.checked.get(accountId) ?? null
    }
  }
}
