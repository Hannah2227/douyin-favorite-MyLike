import { useEffect, useState } from 'react'
import { operationLabels, responseLabels, type RuntimeEvent } from '../../shared/runtime-events'
import { call } from './api'

export function RuntimeHistory({ accountId, revision }: { accountId: string | null; revision: unknown }) {
  const [result, setResult] = useState<{ accountId: string; events: RuntimeEvent[]; error: string } | null>(
    null
  )
  const [retry, setRetry] = useState(0)
  const [filter, setFilter] = useState('all')
  useEffect(() => {
    if (!accountId) return
    let active = true
    void call(window.mylike.invoke('runtimeEvents', { accountId })).then(
      (events) => {
        if (active) setResult({ accountId, events, error: '' })
      },
      (error) => {
        if (active) setResult({ accountId, events: [], error: error.message })
      }
    )
    return () => {
      active = false
    }
  }, [accountId, revision, retry])
  const current = result?.accountId === accountId ? result : null
  if (!accountId) return <p className="task-note">添加账号后查看运行记录。</p>
  if (!current) return <p className="task-note">正在读取运行记录…</p>
  if (current.error)
    return (
      <div role="alert">
        <p>{current.error}</p>
        <button onClick={() => setRetry((n) => n + 1)}>重试运行记录</button>
      </div>
    )
  const events = current.events
    .filter(
      (event) =>
        filter === 'all' || (filter === 'requests' ? event.kind === 'request' : event.kind !== 'request')
    )
    .toReversed()
  return (
    <>
      <div className="runtime-filters segmented" aria-label="运行记录筛选">
        {[
          ['all', '全部'],
          ['tasks', '任务与登录'],
          ['requests', '接口返回']
        ].map(([value, label]) => (
          <button
            key={value}
            aria-pressed={filter === value}
            className={filter === value ? 'selected' : ''}
            onClick={() => setFilter(value!)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="task-note">保留最近各 150 条接口与任务记录，仅记录返回类型、耗时和结果。</p>
      {events.length ? (
        <ul className="history" aria-label="运行记录">
          {events.map((event) => (
            <li key={event.id}>
              <time dateTime={new Date(event.time).toISOString()}>
                {new Date(event.time).toLocaleString('zh-CN', {
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit'
                })}
              </time>
              <div>
                <span>
                  {event.operation ? `${operationLabels[event.operation] ?? event.operation}：` : ''}
                  {event.message}
                </span>
                <small>
                  {[
                    event.responseType
                      ? `返回类型：${responseLabels[event.responseType] ?? event.responseType}`
                      : '',
                    event.status === undefined ? '' : `HTTP ${event.status}`,
                    event.count === undefined ? '' : `${event.count} 条`,
                    event.durationMs === undefined ? '' : `${(event.durationMs / 1000).toFixed(2)} 秒`,
                    event.code ?? ''
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="task-note">暂无此类运行记录</p>
      )}
    </>
  )
}
