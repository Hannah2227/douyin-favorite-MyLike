import type { EngineStatus } from '../../shared/contracts'
import { taskRecovery } from '../../shared/task-recovery'

export type Tab = 'dashboard' | 'library' | 'favorites' | 'tasks' | 'settings' | 'faq' | 'guide'
export type Perform = (label: string, action: () => Promise<unknown>) => Promise<void>
export const statusLabels: Record<EngineStatus, string> = {
  stopped: '需要时会自动连接',
  starting: '正在连接抖音',
  ready: '抖音页面已就绪',
  visible: '抖音窗口已打开',
  failed: '暂时无法打开抖音页面'
}
const technicalCodes = new Set([
  'AUTH_REQUIRED',
  'LOGIN_PENDING',
  'IDENTITY_MISMATCH',
  'DUPLICATE_ACCOUNT',
  'VERIFICATION_REQUIRED',
  'RATE_LIMITED',
  'UPSTREAM_RISK_CONTROL',
  'UPSTREAM_CHANGED',
  'NETWORK_ERROR',
  'TIMEOUT',
  'BROWSER_NOT_READY',
  'BROWSER_CRASHED',
  'PAGE_CHANGED',
  'EMPTY_RESPONSE',
  'EMPTY_PAGE',
  'EMPTY_PAGE_LIMIT',
  'END_UNCONFIRMED',
  'NO_AVAILABLE_ITEMS',
  'CURSOR_STALLED',
  'PARTIAL_SYNC',
  'INTERRUPTED',
  'API_REJECTED',
  'INVALID_RESPONSE',
  'INTERNAL_ERROR',
  'STORAGE_ERROR'
])
export class CommandError extends Error {
  constructor(
    public readonly code: string,
    public readonly diagnosticMessage: string,
    public readonly retryAt?: number
  ) {
    super(
      technicalCodes.has(code)
        ? (taskRecovery(code)?.message ?? '暂时无法完成操作，请稍后重试。已保存的内容会保留。')
        : diagnosticMessage
    )
  }
}
export async function call<T>(
  promise: Promise<
    { ok: true; data: T } | { ok: false; error: { code?: string; message: string; retryAt?: number } }
  >
): Promise<T> {
  const result = await promise
  if (!result.ok)
    throw new CommandError(result.error.code ?? 'INTERNAL_ERROR', result.error.message, result.error.retryAt)
  return result.data
}
