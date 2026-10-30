export type RecoveryAction = 'retry' | 'login' | 'verify' | 'check-result' | 'update'
export interface TaskRecoveryView {
  title: string
  message: string
  action: RecoveryAction
  actionLabel: string
}

/** Technical causes stay internal; every user-visible failure has one clear next action. */
export function taskRecovery(code?: string | null, unknown = false): TaskRecoveryView | null {
  if (unknown)
    return {
      title: '需要确认操作结果',
      message: '暂时没有收到抖音的处理结果，后续操作已暂停。请先检查结果。',
      action: 'check-result',
      actionLabel: '检查结果'
    }
  switch (code) {
    case 'AUTH_REQUIRED':
    case 'LOGIN_PENDING':
    case 'IDENTITY_MISMATCH':
    case 'DUPLICATE_ACCOUNT':
      return {
        title: '需要登录抖音',
        message: '请登录正确的抖音账号，再继续操作。已同步的内容会保留。',
        action: 'login',
        actionLabel: '去登录'
      }
    case 'VERIFICATION_REQUIRED':
      return {
        title: '需要完成验证',
        message: '请在抖音窗口完成验证，再继续操作。已同步的内容会保留。',
        action: 'verify',
        actionLabel: '去验证'
      }
    case 'RATE_LIMITED':
    case 'UPSTREAM_RISK_CONTROL':
      return {
        title: '暂时无法继续',
        message: '抖音暂时无法提供所需内容。请稍后重试，已同步的内容可以正常浏览。',
        action: 'retry',
        actionLabel: '稍后重试'
      }
    case 'UPSTREAM_CHANGED':
      return {
        title: '暂时无法读取内容',
        message: '当前版本暂时无法读取这部分抖音内容。请查看应用更新，或反馈问题。',
        action: 'update',
        actionLabel: '查看更新'
      }
    case 'NETWORK_ERROR':
    case 'TIMEOUT':
      return {
        title: '连接失败',
        message: '暂时无法连接抖音，请稍后重试。已保存的内容和进度会保留。',
        action: 'retry',
        actionLabel: '重试'
      }
    case 'BROWSER_NOT_READY':
    case 'BROWSER_CRASHED':
    case 'PAGE_CHANGED':
      return {
        title: '抖音页面未能正常打开',
        message: '抖音页面未能正常打开，请重试。应用会重新连接，已保存的内容和进度会保留。',
        action: 'retry',
        actionLabel: '重试'
      }
    case 'EMPTY_RESPONSE':
    case 'EMPTY_PAGE':
    case 'EMPTY_PAGE_LIMIT':
    case 'END_UNCONFIRMED':
    case 'NO_AVAILABLE_ITEMS':
    case 'CURSOR_STALLED':
      return {
        title: '暂时无法继续同步',
        message: '暂时没有获取到更多内容。已保存的内容和进度会保留，可以稍后继续。',
        action: 'retry',
        actionLabel: '稍后重试'
      }
    case 'PARTIAL_SYNC':
      return {
        title: '部分内容尚未同步',
        message: '已完成的内容已保存，可以重试尚未完成的部分。',
        action: 'retry',
        actionLabel: '重试未完成项'
      }
    case 'INTERRUPTED':
      return {
        title: '上次操作未完成',
        message: '已保存上次的进度，可以继续。',
        action: 'retry',
        actionLabel: '继续'
      }
    case 'API_REJECTED':
      return {
        title: '操作未完成',
        message: '抖音暂时无法完成这次操作。请稍后重试，已保存的内容会保留。',
        action: 'retry',
        actionLabel: '重试'
      }
    default:
      return code
        ? {
            title: '操作未完成',
            message: '暂时无法完成这次操作，请重试。持续出现时可复制诊断信息反馈。',
            action: 'retry',
            actionLabel: '重试'
          }
        : null
  }
}

export function taskRecoveryHint(code?: string | null, unknown = false): string | null {
  return taskRecovery(code, unknown)?.message ?? null
}
