import { taskRecovery } from '../../shared/task-recovery'
import type { TaskPresentation } from '../../shared/task-presentation'
import { call, type Perform } from './api'

export function TaskRecovery({
  view,
  code,
  unknown = false
}: {
  view?: TaskPresentation
  code?: string | null
  unknown?: boolean
}) {
  const message = view?.message ?? taskRecovery(code, unknown)?.message
  return message ? (
    <p
      className={'task-note recovery-hint' + (view?.tone === 'attention' ? ' task-problem' : '')}
      role="status"
    >
      {message}
    </p>
  ) : null
}
export function RecoveryButton({
  view,
  retry,
  login,
  checkResults,
  perform,
  busy = false
}: {
  view: TaskPresentation
  retry?: () => void
  login?: () => void
  checkResults?: () => void
  perform: Perform
  busy?: boolean
}) {
  if (!view.action) return null
  const action = view.action
  const missing =
    action === 'check-result'
      ? !checkResults
      : action === 'retry'
        ? !retry
        : action === 'login' || action === 'verify'
          ? !login
          : false
  // An update is the recommended next step, but a manual attempt remains available
  // after upgrading or when the platform recovers. Unknown writes only get a read check.
  const fallback = action === 'update' ? (checkResults ?? retry) : undefined
  return (
    <>
      <button
        disabled={busy || view.waitingSeconds > 0 || missing}
        onClick={() => {
          if (action === 'login' || action === 'verify') login?.()
          else if (action === 'check-result') checkResults?.()
          else if (action === 'update')
            void perform('查看应用更新', () => call(window.mylike.invoke('openReleases', {})))
          else retry?.()
        }}
      >
        {view.actionLabel}
      </button>
      {fallback && (
        <button className="task-text-button" disabled={busy || view.waitingSeconds > 0} onClick={fallback}>
          {checkResults ? '检查结果' : '重试'}
        </button>
      )}
    </>
  )
}
