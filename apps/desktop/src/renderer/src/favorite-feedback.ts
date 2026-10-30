import { CommandError } from './api'

/** A missing write reply is not an empty collection page and must never suggest replaying it. */
export function favoriteWriteMessage(error: unknown, operation: 'save' | 'create'): string {
  const confirmed = '已确认的结果会保留。'
  const code = error instanceof CommandError ? error.code : null
  if (['AUTH_REQUIRED', 'LOGIN_PENDING', 'IDENTITY_MISMATCH', 'DUPLICATE_ACCOUNT'].includes(code ?? ''))
    return '请先登录正确的抖音账号，再重新读取并确认当前结果。' + confirmed
  if (code === 'VERIFICATION_REQUIRED') return '请在抖音窗口完成验证，再重新读取并确认当前结果。' + confirmed
  if (code === 'RATE_LIMITED' || code === 'UPSTREAM_RISK_CONTROL')
    return '抖音暂时无法完成这项操作，请稍后重新读取并确认当前结果。' + confirmed
  if (code === 'API_REJECTED') return '抖音未接受这一步操作，请重新读取并确认当前结果后再试。' + confirmed
  if (
    code &&
    [
      'FOLDER_EXISTS',
      'EDITOR_EXPIRED',
      'FOLDER_CHANGED',
      'QUEUE_CHANGED',
      'ACCOUNT_CHANGED',
      'INVALID_INPUT',
      'BUSY',
      'CANCELLED',
      'CLOSING'
    ].includes(code)
  )
    return (error as CommandError).message
  return operation === 'create'
    ? '暂时无法确认收藏夹是否已创建，未自动重发。请重新读取收藏夹，确认是否已有同名收藏夹，避免重复创建。'
    : '暂时无法确认此次收藏的完整结果，未自动重发。请重新读取后确认，已确认的结果会保留。'
}
