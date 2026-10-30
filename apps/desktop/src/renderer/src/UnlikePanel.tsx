import { useEffect, useRef, useState } from 'react'
import { HeartOff, StarOff, Square } from 'lucide-react'
import type { UnlikeTask, UnlikeItem } from '../../shared/contracts'
import type { RecoveryState } from '../../shared/recovery-state'
import { taskPresentation } from '../../shared/task-presentation'
import { call, CommandError, type Perform } from './api'
import { Select } from './Select'
import { RecoveryButton, TaskRecovery } from './TaskRecovery'
import { useRecoveryClock } from './useRecoveryClock'
import { useTaskAction } from './useTaskAction'

type Result = {
  accountId: string
  history: UnlikeTask[]
  items: UnlikeItem[]
  taskId: string | null
  offset: number
  total: number
  issuesOnly: boolean
}
function itemMessage(item: UnlikeItem, label: string) {
  if (item.errorCode === 'ITEM_SKIPPED') return '该内容目前无法访问，已跳过。'
  if (item.status === 'unknown') return '需要检查这条操作的结果。'
  if (item.status === 'pending') return '等待处理'
  if (item.status === 'inflight') return '正在处理…'
  if (item.status === 'success') return '已取消' + label
  if (item.errorCode === 'VERIFIED_LIKED' || item.errorCode === 'VERIFIED_COLLECTED')
    return '检查后发现仍在' + label + '列表中。如需再次操作，请重新选择并确认。'
  return '本次未能取消' + label + '，可以稍后重新选择并重试。'
}
export function UnlikePanel({
  accountId,
  latest,
  busy,
  resumeDisabled,
  perform,
  recovery = [],
  login,
  accessChecks
}: {
  accountId: string | null
  latest: UnlikeTask | null
  busy: boolean
  resumeDisabled: boolean
  perform: Perform
  recovery?: readonly RecoveryState[]
  login?: () => void
  accessChecks?: readonly { accountId: string; operation: string; at: number }[]
}) {
  const [result, setResult] = useState<Result | null>(null),
    [selected, setSelected] = useState(''),
    [offset, setOffset] = useState(0)
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(!!accountId),
    [reload, setReload] = useState(0),
    [recordsOpen, setRecordsOpen] = useState(false),
    [issuesOnly, setIssuesOnly] = useState(true)
  const [checking, setChecking] = useState(false),
    [checkProgress, setCheckProgress] = useState({ done: 0, total: 0 }),
    [checkError, setCheckError] = useState(''),
    [checkFailure, setCheckFailure] = useState<{ code: string; at: number } | null>(null)
  const sequence = useRef(0),
    verificationSequence = useRef(0)
  const current = result?.accountId === accountId ? result : null,
    active = latest?.accountId === accountId ? latest : null
  const history = current?.history ?? []
  const record = history.find((task) => task.id === selected) ?? active ?? history[0]
  const task = active?.id === record?.id ? active : record
  const label = task?.source === 'favorites' ? '收藏' : '点赞'
  const filtering = issuesOnly && !!(task?.failed || task?.unknown)
  const items =
    current?.taskId === task?.id && current?.offset === offset && current.issuesOnly === filtering
      ? current.items
      : []
  const total = current && current.taskId === task?.id && current.issuesOnly === filtering ? current.total : 0
  const now = useRecoveryClock(recovery)
  const action = useTaskAction(accountId, task?.id, perform)
  const operations = task?.source === 'favorites' ? ['self', 'detail', 'favoriteRemove'] : ['self', 'unlike']
  const baseView = taskPresentation(action.present(task), {
    operations,
    recovery,
    now,
    retryAt: task?.unknown ? undefined : action.failure?.retryAt,
    accessChecks,
    resultCheckError: checkFailure,
    runningMessage: '正在逐条处理，请稍候…',
    completedMessage: '本次操作已完成。',
    retryLabel: '继续处理剩余内容'
  })
  const view = {
    ...baseView,
    message: checking
      ? '正在检查操作结果（' + checkProgress.done + '/' + checkProgress.total + '）…'
      : checkFailure && ['login', 'verify', 'update'].includes(baseView.action ?? '')
        ? baseView.message
        : checkError && !checkFailure
          ? checkError
          : baseView.message
  }
  const remainingView = taskPresentation(
    task ? { ...task, status: 'paused', unknown: 0, errorCode: null } : null,
    { operations, recovery, now, retryLabel: '继续处理其他内容' }
  )
  const scope = useRef({ accountId, taskId: task?.id })
  scope.current = { accountId, taskId: task?.id }
  useEffect(() => {
    setSelected('')
    setOffset(0)
    setError('')
    setRecordsOpen(false)
    setIssuesOnly(true)
  }, [accountId])
  useEffect(() => {
    verificationSequence.current++
    setChecking(false)
    setCheckError('')
    setCheckFailure(null)
    setCheckProgress({ done: 0, total: 0 })
    return () => {
      verificationSequence.current++
    }
  }, [accountId, task?.id])
  useEffect(() => {
    const seq = ++sequence.current
    if (!accountId) return
    setLoading(true)
    void (async () => {
      try {
        const history = await call(window.mylike.invoke('unlikeHistory', { accountId }))
        const target =
          history.find((task) => task.id === (selected || active?.id)) ??
          (selected ? history[0] : (active ?? history[0]))
        const page = target
          ? await call(
              window.mylike.invoke('unlikeItems', {
                accountId,
                taskId: target.id,
                offset,
                limit: 50,
                issuesOnly: issuesOnly && !!(target.failed || target.unknown)
              })
            )
          : null
        if (seq === sequence.current) {
          setResult({
            accountId,
            history,
            items: page?.items ?? [],
            taskId: target?.id ?? null,
            offset,
            total: page?.total ?? 0,
            issuesOnly: issuesOnly && !!(target?.failed || target?.unknown)
          })
          setError('')
          setLoading(false)
        }
      } catch (error) {
        if (seq === sequence.current) {
          setError(error instanceof Error ? error.message : '任务记录暂时无法读取，请重试。')
          setLoading(false)
        }
      }
    })()
    return () => {
      sequence.current++
    }
  }, [accountId, selected, offset, JSON.stringify(active), reload, issuesOnly])
  useEffect(() => {
    if (task?.unknown || task?.failed || task?.errorCode) setRecordsOpen(true)
  }, [task?.id, task?.unknown, task?.failed, task?.errorCode])
  useEffect(() => setOffset(0), [filtering, task?.id])
  const control = (mode: 'resume' | 'stop') =>
    task &&
    action.run('更新取消' + label + '任务', () =>
      call(
        window.mylike.invoke('unlikeControl', { accountId: task.accountId, taskId: task.id, action: mode })
      )
    )
  const ready =
    !!current &&
    current.taskId === task?.id &&
    current.offset === offset &&
    current.issuesOnly === filtering &&
    !loading
  const checkResults = (workId?: string) => {
    if (
      !task ||
      !accountId ||
      !ready ||
      checking ||
      active?.status === 'running' ||
      baseView.waitingSeconds > 0
    )
      return
    if (workId && !items.some((item) => item.workId === workId && item.status === 'unknown')) return
    const owner = accountId,
      taskId = task.id,
      token = ++verificationSequence.current
    const valid = () =>
      token === verificationSequence.current &&
      scope.current.accountId === owner &&
      scope.current.taskId === taskId
    setChecking(true)
    setCheckError('')
    setRecordsOpen(true)
    setCheckProgress({ done: 0, total: 0 })
    void perform('检查操作结果', async () => {
      try {
        const ids: string[] = []
        if (workId) ids.push(workId)
        else {
          let next = 0,
            total = 1
          // Collect a fixed ID snapshot before any resolution changes the result list.
          while (next < total && valid()) {
            const page = await call(
              window.mylike.invoke('unlikeItems', { accountId: owner, taskId, offset: next, limit: 100 })
            )
            if (!valid()) return
            total = page.total
            if (!page.items.length && next < total) throw Error('记录已更新，请重新检查。')
            for (const item of page.items) if (item.status === 'unknown') ids.push(item.workId)
            next += page.items.length
          }
        }
        const targets = [...new Set(ids)]
        if (!valid()) return
        setCheckProgress({ done: 0, total: targets.length })
        for (let i = 0; i < targets.length; i++) {
          if (!valid()) return
          await call(window.mylike.invoke('unlikeVerify', { accountId: owner, taskId, workId: targets[i]! }))
          if (!valid()) return
          setCheckProgress({ done: i + 1, total: targets.length })
        }
      } catch (error) {
        if (valid()) {
          setCheckError(error instanceof Error ? error.message : '暂时无法检查结果，请稍后重试。')
          setCheckFailure({
            code: error instanceof CommandError ? error.code : 'INTERNAL_ERROR',
            at: Date.now()
          })
        }
      } finally {
        if (valid()) {
          setChecking(false)
          setReload((value) => value + 1)
        }
      }
    })
  }
  const stopChecking = () => {
    verificationSequence.current++
    setChecking(false)
    setCheckError('检查已停止，尚未确认的结果会保留。')
  }
  const checkDisabled = busy || resumeDisabled || !ready || active?.status === 'running'
  return (
    <section className="simple-task unlike-task" aria-label={'取消' + label + '任务'}>
      <div className="simple-task-heading">
        <span className="simple-task-icon">
          {task?.source === 'favorites' ? <StarOff size={19} /> : <HeartOff size={19} />}
        </span>
        <h2>取消{label}</h2>
        <span
          className={
            'task-badge ' +
            (view.tone === 'attention'
              ? 'attention'
              : view.tone === 'success'
                ? 'completed'
                : (task?.status ?? ''))
          }
        >
          {task ? (checking ? '正在检查' : view.badge) : error ? '读取失败' : loading ? '读取中' : '暂无记录'}
        </span>
      </div>
      <div className="simple-task-body">
        <div className="simple-task-copy">
          {task ? (
            <>
              <p role="status">
                共 {task.total} 条 · 已完成 {task.success}
                {task.pending ? ' · 等待处理 ' + task.pending : ''}
                {task.failed ? ' · 未完成 ' + task.failed : ''}
                {task.unknown ? ' · 待确认 ' + task.unknown : ''}
              </p>
              <TaskRecovery view={view} />
            </>
          ) : (
            <p>
              {error
                ? '任务记录暂时无法读取'
                : loading
                  ? '正在读取记录…'
                  : '在内容列表或播放器中选择作品后操作'}
            </p>
          )}
        </div>
        <div className="simple-task-actions">
          {checking ? (
            <button onClick={stopChecking}>停止检查</button>
          ) : task?.status === 'running' ? (
            <button disabled={busy} onClick={() => control('stop')}>
              <Square size={14} />
              停止后续取消{label}
            </button>
          ) : (
            task && (
              <>
                <RecoveryButton
                  view={view}
                  busy={task.unknown ? checkDisabled : busy || resumeDisabled || active?.status === 'running'}
                  retry={task.pending > 0 ? () => control('resume') : undefined}
                  login={login}
                  checkResults={task.unknown ? () => checkResults() : undefined}
                  perform={perform}
                />
                {!!task.unknown && task.pending > 0 && (
                  <button
                    className="task-text-button"
                    disabled={
                      busy ||
                      resumeDisabled ||
                      active?.status === 'running' ||
                      remainingView.waitingSeconds > 0
                    }
                    onClick={() => control('resume')}
                  >
                    继续处理其他内容
                  </button>
                )}
                {view.canStop && view.waitingSeconds > 0 && (
                  <button className="task-text-button" disabled={busy} onClick={() => control('stop')}>
                    停止后续操作
                  </button>
                )}
              </>
            )
          )}
        </div>
      </div>
      {error && (
        <div className="unlike-load-error" role="alert">
          <p className="task-problem">{error}</p>
          <button disabled={loading} onClick={() => setReload((value) => value + 1)}>
            重新读取
          </button>
        </div>
      )}
      {(task || history.length > 0) && (
        <details
          className="unlike-records"
          open={recordsOpen}
          onToggle={(event) => setRecordsOpen(event.currentTarget.open)}
        >
          <summary>查看记录{task?.unknown ? <span>{task.unknown} 条需要确认</span> : null}</summary>
          <div className="unlike-records-content" aria-busy={loading}>
            {history.length > 1 && (
              <Select
                label={'取消' + label + '历史任务'}
                value={task?.id ?? ''}
                disabled={checking}
                onChange={(value) => {
                  setSelected(value)
                  setOffset(0)
                }}
                options={history.map((task) => ({
                  value: task.id,
                  label:
                    new Date(task.createdAt).toLocaleString('zh-CN') +
                    ' · 取消' +
                    (task.source === 'favorites' ? '收藏' : '点赞') +
                    ' · ' +
                    task.total +
                    ' 条 · ' +
                    taskPresentation(task, { operations: [], recovery: [], now }).badge
                }))}
              />
            )}
            {!!(task?.failed || task?.unknown) && (
              <label className="task-note">
                <input
                  type="checkbox"
                  checked={issuesOnly}
                  onChange={(event) => {
                    setIssuesOnly(event.target.checked)
                    setOffset(0)
                  }}
                />
                仅看未完成的内容
              </label>
            )}
            <ol className="write-results" start={offset + 1}>
              {items.map((item) => (
                <li key={item.workId}>
                  <div>
                    <strong>{item.title || '未命名作品'}</strong>
                    <small>{itemMessage(item, label)}</small>
                    <details className="runtime-details">
                      <summary>诊断详情</summary>
                      <small>{'ID ' + item.workId + (item.reason ? ' · ' + item.reason : '')}</small>
                    </details>
                  </div>
                  {item.status === 'unknown' && task && (
                    <button
                      disabled={checkDisabled || checking || baseView.waitingSeconds > 0}
                      onClick={() => checkResults(item.workId)}
                    >
                      检查结果
                    </button>
                  )}
                </li>
              ))}
            </ol>
            {loading && !items.length && <p className="task-note">正在读取结果…</p>}
            {task && total > 50 && (
              <div className="unlike-pagination">
                <button
                  disabled={loading || offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - 50))}
                >
                  上一页结果
                </button>
                <span>
                  {offset + 1}–{Math.min(offset + 50, total)} / {total}
                </span>
                <button disabled={loading || offset + 50 >= total} onClick={() => setOffset(offset + 50)}>
                  下一页结果
                </button>
              </div>
            )}
          </div>
        </details>
      )}
    </section>
  )
}
