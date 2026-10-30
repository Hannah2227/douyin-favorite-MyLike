export type HealthStatus = 'normal' | 'abnormal' | 'uncertain'
export type HealthOperation = 'self' | 'likes' | 'favorites' | 'folders' | 'folderItems'
export interface HealthEntry {
  operation: HealthOperation
  status: HealthStatus
  code: string | null
  at: number
  failures: number
  rule?: string
  retryAt?: number
}
export interface HealthSnapshot {
  accountId: string
  status: HealthStatus
  checking: boolean
  checkedAt: number | null
  entries: HealthEntry[]
}
export const HEALTH_MAX_AGE = 10 * 60_000
export const healthLabels: Record<HealthStatus, string> = {
  normal: '正常',
  abnormal: '异常',
  uncertain: '不明确'
}
export function healthStatus(entries: readonly HealthEntry[], now = Date.now()): HealthStatus {
  if (entries.some((e) => e.status === 'abnormal')) return 'abnormal'
  if (['self', 'likes', 'favorites', 'folders'].some((op) => !entries.some((e) => e.operation === op)))
    return 'uncertain'
  return entries.every((e) => e.status === 'normal' && now - e.at < HEALTH_MAX_AGE) ? 'normal' : 'uncertain'
}
