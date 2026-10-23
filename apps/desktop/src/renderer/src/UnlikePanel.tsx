import { useEffect, useRef, useState } from 'react'
import { HeartOff, Play, Square } from 'lucide-react'
import type { UnlikeTask, UnlikeItem } from '../../shared/contracts'
import { call, type Perform } from './api'
import { Select } from './Select'

const states = { running: '进行中', paused: '已暂停', stopped: '已停止', completed: '本轮结束' }
const itemStates = {
  pending: '未发送',
  inflight: '正在请求',
  success: '已确认未点赞',
  failed: '未完成',
  unknown: '结果未知'
}
type Result = {
  accountId: string
  history: UnlikeTask[]
  items: UnlikeItem[]
  taskId: string | null
  offset: number
}

export function UnlikePanel({
  accountId,
  latest,
  busy,
  resumeDisabled,
  perform
}: {
  accountId: string | null
  latest: UnlikeTask | null
  busy: boolean
  resumeDisabled: boolean
  perform: Perform
}) {
  const [result, setResult] = useState<Result | null>(null)
  const [selected, setSelected] = useState(''),
    [offset, setOffset] = useState(0)
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(!!accountId)
  const [reload, setReload] = useState(0),
    [recordsOpen, setRecordsOpen] = useState(false)
  const sequence = useRef(0)
  const current = result?.accountId === accountId ? result : null
  const active = latest?.accountId === accountId ? latest : null
  const history = current?.history ?? []
  const record = history.find((task) => task.id === selected) ?? active ?? history[0]
  const task = active?.id === record?.id ? active : record
  const items = current?.taskId === task?.id && current?.offset === offset ? current.items : []
  useEffect(() => {
    setSelected('')
    setOffset(0)
    setError('')
    setRecordsOpen(false)
  }, [accountId])
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
              window.mylike.invoke('unlikeItems', { accountId, taskId: target.id, offset, limit: 50 })
            )
          : null
        if (seq === sequence.current) {
          setResult({ accountId, history, items: page?.items ?? [], taskId: target?.id ?? null, offset })
          setError('')
          setLoading(false)
        }
      } catch (error) {
        if (seq === sequence.current) {
          setError(error instanceof Error ? error.message : '任务读取失败。')
          setLoading(false)
        }
      }
    })()
    return () => {
      sequence.current++
    }
  }, [accountId, selected, offset, JSON.stringify(active), reload])
  useEffect(() => {
    if (task?.unknown) setRecordsOpen(true)
  }, [task?.id, task?.unknown])
  const control = (action: 'resume' | 'stop') =>
    task &&
    void perform('更新取消点赞任务', () =>
      call(window.mylike.invoke('unlikeControl', { accountId: task.accountId, taskId: task.id, action }))
    )
  return (
    <section className="simple-task unlike-task" aria-label="取消点赞任务">
      <div className="simple-task-heading">
        <span className="simple-task-icon">
          <HeartOff size={19} />
        </span>
        <h2>取消点赞</h2>
        <span
          className={`task-badge ${task?.unknown || task?.failed || task?.errorCode ? 'attention' : (task?.status ?? '')}`}
        >
          {task?.unknown
            ? '待核验'
            : task
              ? task.failed || task.errorCode
                ? '需处理'
                : states[task.status]
              : error
                ? '读取失败'
                : loading
                  ? '读取中'
                  : '暂无记录'}
        </span>
      </div>
      <div className="simple-task-body">
        <div className="simple-task-copy">
          {task ? (
            <>
              <p role="status">
                共 {task.total} 条 · 成功 {task.success} · 未发送 {task.pending}
                {task.failed ? ` · 未完成 ${task.failed}` : ''}
                {task.unknown ? ` · 结果未知 ${task.unknown}` : ''}
              </p>
              {task.reason && (task.errorCode || task.unknown || task.failed) && (
                <p className={task.errorCode || task.unknown ? 'task-problem' : 'task-note'}>{task.reason}</p>
              )}
            </>
          ) : (
            <p>
              {error ? '任务历史暂不可用' : loading ? '正在读取记录…' : '在内容库或播放器中选择作品后操作'}
            </p>
          )}
        </div>
        {task && (
          <div className="simple-task-actions">
            {task.status === 'running' ? (
              <button disabled={busy} onClick={() => control('stop')}>
                <Square size={14} />
                停止后续取消点赞
              </button>
            ) : (
              task.pending > 0 && (
                <button
                  disabled={busy || resumeDisabled || active?.status === 'running'}
                  onClick={() => control('resume')}
                >
                  <Play size={15} />
                  继续未发送项
                </button>
              )
            )}
          </div>
        )}
      </div>
      {error && (
        <div className="unlike-load-error" role="alert">
          <p className="task-problem">任务记录读取失败：{error}</p>
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
          <summary>查看记录{task?.unknown ? <span>{task.unknown} 条结果待核验</span> : null}</summary>
          <div className="unlike-records-content" aria-busy={loading}>
            {history.length > 1 && (
              <Select
                label="取消点赞历史任务"
                value={task?.id ?? ''}
                onChange={(value) => {
                  setSelected(value)
                  setOffset(0)
                }}
                options={history.map((task) => ({
                  value: task.id,
                  label: `${new Date(task.createdAt).toLocaleString('zh-CN')} · ${task.total} 条 · ${states[task.status]}`
                }))}
              />
            )}
            {task?.unknown ? (
              <p className="task-note">结果未知项不会自动重发；重新核验只读取当前点赞状态。</p>
            ) : null}
            <ol className="write-results" start={offset + 1}>
              {items.map((item) => (
                <li key={item.workId}>
                  <div>
                    <strong>{item.title || item.workId}</strong>
                    <small>
                      {itemStates[item.status]}
                      {item.reason ? ` · ${item.reason}` : ''}
                    </small>
                  </div>
                  {item.status === 'unknown' && task && (
                    <button
                      disabled={busy || loading || active?.status === 'running'}
                      onClick={() =>
                        void perform('读取当前点赞状态', () =>
                          call(
                            window.mylike.invoke('unlikeVerify', {
                              accountId: task.accountId,
                              taskId: task.id,
                              workId: item.workId
                            })
                          )
                        )
                      }
                    >
                      重新核验
                    </button>
                  )}
                </li>
              ))}
            </ol>
            {loading && !items.length && <p className="task-note">正在读取结果…</p>}
            {task && task.total > 50 && (
              <div className="unlike-pagination">
                <button
                  disabled={loading || offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - 50))}
                >
                  上一页结果
                </button>
                <span>
                  {offset + 1}–{Math.min(offset + 50, task.total)} / {task.total}
                </span>
                <button
                  disabled={loading || offset + 50 >= task.total}
                  onClick={() => setOffset(offset + 50)}
                >
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
