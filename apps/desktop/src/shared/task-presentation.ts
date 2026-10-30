import type { RecoveryState } from './recovery-state'
import { taskRecovery, type RecoveryAction } from './task-recovery'

export interface PresentableTask {
  accountId: string
  status: 'running' | 'paused' | 'stopped' | 'completed' | 'partial'
  errorCode?: string | null
  unknown?: number
  failed?: number
  pending?: number
  updatedAt?: number
}
export interface TaskPresentation {
  badge: string
  message: string
  tone: 'normal' | 'success' | 'attention'
  action: RecoveryAction | null
  actionLabel: string
  waitingSeconds: number
  canStop: boolean
}
export function recoveryUntil(
  accountId: string,
  operations: readonly string[],
  recovery: readonly RecoveryState[] = []
): number {
  return Math.max(
    0,
    ...recovery
      .filter((item) => item.accountId === accountId && operations.includes(item.operation))
      .map((item) => item.retryAt)
  )
}
export function taskPresentation(
  task: PresentableTask | null | undefined,
  options: {
    operations: readonly string[]
    recovery?: readonly RecoveryState[]
    now?: number
    runningMessage?: string
    completedMessage?: string
    retryLabel?: string
    retryAt?: number
    accountId?: string | null
    resultCheckError?: { code: string; at: number } | null
    accessChecks?: readonly { accountId: string; operation: string; at: number }[]
  }
): TaskPresentation {
  if (!task && options.accountId) {
    const until = recoveryUntil(options.accountId, options.operations, options.recovery)
    if (until > (options.now ?? Date.now())) task = { accountId: options.accountId, status: 'paused' }
  }
  if (!task)
    return {
      badge: '未开始',
      message: '',
      tone: 'normal',
      action: null,
      actionLabel: '',
      waitingSeconds: 0,
      canStop: false
    }
  const canStop = task.status !== 'completed' && task.status !== 'stopped'
  if (task.status === 'running')
    return {
      badge: '进行中',
      message: options.runningMessage ?? '正在处理…',
      tone: 'normal',
      action: null,
      actionLabel: '',
      waitingSeconds: 0,
      canStop: true
    }
  if (task.status === 'completed' && !task.unknown && !task.failed && !task.pending && !task.errorCode)
    return {
      badge: '已完成',
      message: options.completedMessage ?? '本次操作已完成。',
      tone: 'success',
      action: null,
      actionLabel: '',
      waitingSeconds: 0,
      canStop: false
    }
  const unknown = !!task.unknown
  const operations = unknown ? ['self', 'detail'] : options.operations
  const waitingSeconds = Math.max(
    0,
    Math.ceil(
      (Math.max(options.retryAt ?? 0, recoveryUntil(task.accountId, operations, options.recovery)) -
        (options.now ?? Date.now())) /
        1000
    )
  )
  const incomplete =
    task.status === 'partial' || (task.status === 'completed' && !!(task.failed || task.pending))
  const confirmed = (code?: string | null, at = task.updatedAt) => {
    if (
      !at ||
      ![
        'AUTH_REQUIRED',
        'LOGIN_PENDING',
        'IDENTITY_MISMATCH',
        'DUPLICATE_ACCOUNT',
        'VERIFICATION_REQUIRED'
      ].includes(code ?? '')
    )
      return false
    // A complete access check is safe proof for offering a manual retry, including after restart.
    return (
      options.accessChecks?.some(
        (check) => check.accountId === task.accountId && check.operation === 'self' && check.at >= at
      ) ?? false
    )
  }
  const code = confirmed(task.errorCode) ? null : task.errorCode
  const recovery = taskRecovery(code)
  if (unknown) {
    const failure =
      options.resultCheckError && !confirmed(options.resultCheckError.code, options.resultCheckError.at)
        ? taskRecovery(options.resultCheckError.code)
        : null
    const next = failure && ['login', 'verify', 'update'].includes(failure.action) ? failure : null
    return {
      badge: '待确认',
      message:
        '有 ' + task.unknown + ' 条操作需要确认。' + (failure?.message ?? '请先检查结果，再处理剩余内容。'),
      tone: 'attention',
      action: next?.action ?? 'check-result',
      actionLabel:
        next?.actionLabel ?? (waitingSeconds ? '稍后检查（' + waitingSeconds + ' 秒）' : '检查结果'),
      waitingSeconds,
      canStop
    }
  }
  if (waitingSeconds && (!recovery || recovery.action === 'retry'))
    return {
      badge: '暂时无法继续',
      message: '抖音暂时无法提供所需内容，已保存的内容可以正常浏览。请稍后再试。',
      tone: 'normal',
      action: 'retry',
      actionLabel: '稍后重试（' + waitingSeconds + ' 秒）',
      waitingSeconds,
      canStop
    }
  if (recovery && ['login', 'verify', 'update'].includes(recovery.action))
    return {
      badge: recovery.title,
      message: recovery.message,
      tone: 'attention',
      action: recovery.action,
      actionLabel: recovery.actionLabel,
      waitingSeconds,
      canStop
    }
  if (incomplete)
    return {
      badge: '部分完成',
      message:
        task.status === 'partial'
          ? '部分内容尚未同步完成，已完成的内容都已保存。'
          : '有 ' + (task.failed ?? 0) + ' 条内容未能完成处理，可以查看下方记录。',
      tone: 'attention',
      action: (task.pending ?? 0) > 0 || task.status === 'partial' ? 'retry' : null,
      actionLabel: task.status === 'partial' ? '重试未完成项' : '继续处理剩余内容',
      waitingSeconds: 0,
      canStop
    }
  if (recovery)
    return {
      badge: recovery.title,
      message: recovery.message,
      tone: 'attention',
      action: recovery.action,
      actionLabel:
        recovery.action === 'retry' && ['RATE_LIMITED', 'UPSTREAM_RISK_CONTROL'].includes(code ?? '')
          ? '重试'
          : recovery.actionLabel,
      waitingSeconds: 0,
      canStop
    }
  if (task.status === 'completed')
    return {
      badge: '已完成',
      message: options.completedMessage ?? '本次操作已完成。',
      tone: 'success',
      action: null,
      actionLabel: '',
      waitingSeconds: 0,
      canStop: false
    }
  return {
    badge: task.status === 'stopped' ? '已停止' : '已暂停',
    message: '已保存当前进度，可以继续。',
    tone: 'normal',
    action: 'retry',
    actionLabel: options.retryLabel ?? '继续',
    waitingSeconds: 0,
    canStop
  }
}
export function activityMessage(activity?: string | null): string {
  if (activity === 'probing' || activity === 'confirming') return '正在检查是否还有更多内容…'
  if (activity === 'cooling') return '暂时没有获取到更多内容，正在重试…'
  if (activity === 'recycling') return '稍等一下，正在继续同步…'
  return '正在同步内容…'
}

/** The first real read performed when resuming the main favorites task. */
export function favoriteReadOperation(
  task?: {
    status: string
    stage: string
    incomplete?: number
    foldersDeferred?: number
  } | null
): string {
  if (!task || task.status === 'completed') return 'favorites'
  if (task.status === 'partial') return task.incomplete || !task.foldersDeferred ? 'favorites' : 'folderItems'
  return task.stage === 'folder' ? 'folderItems' : task.stage === 'folders' ? 'folders' : 'favorites'
}
