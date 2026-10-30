import { useEffect, useState } from 'react'
import {
  operationLabels,
  responseLabels,
  responseRuleLabels,
  runtimeEventCategory,
  type RuntimeEvent
} from '../../shared/runtime-events'
import { call } from './api'
import { taskRecovery } from '../../shared/task-recovery'

const legacyFailureLabels: Record<string, string> = {
  TIMEOUT: '请求超时',
  NETWORK_ERROR: '网络请求失败',
  AUTH_REQUIRED: '需要重新登录或完成验证',
  VERIFICATION_REQUIRED: '需要完成人工验证',
  RATE_LIMITED: '平台暂时限流',
  API_REJECTED: '平台拒绝请求',
  EMPTY_RESPONSE: '平台返回空响应，未确认末尾',
  INVALID_RESPONSE: '平台响应格式异常',
  UPSTREAM_CHANGED: '接口结构变化',
  UPSTREAM_RISK_CONTROL: '平台暂未提供所需数据',
  BROWSER_NOT_READY: '抖音页面未加载成功',
  BROWSER_CRASHED: '抖音页面进程意外停止'
}
function eventMessage(event: RuntimeEvent): string {
  if (runtimeEventCategory(event) === 'exception' && event.code)
    return taskRecovery(event.code)?.message ?? '操作未完成，请稍后重试。'
  if (event.message !== '接口请求未正常结束') return event.message
  return (
    (event.rule ? responseRuleLabels[event.rule] : legacyFailureLabels[event.code ?? '']) ??
    `请求失败（${event.code ?? '原因未明'}）`
  )
}

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
    .filter((event) => filter === 'all' || runtimeEventCategory(event) === filter)
    .toReversed()
  return (
    <>
      <div className="runtime-filters segmented" aria-label="运行记录筛选">
        {[
          ['all', '全部'],
          ['exception', '异常'],
          ['end', '确认触底']
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
      <p className="task-note">仅保留关键异常与采集确认结束，5 分钟内同原因合并。</p>
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
                  {event.kind === 'request' && event.operation
                    ? `${operationLabels[event.operation] ?? event.operation}：`
                    : ''}
                  {eventMessage(event)}
                </span>
                {runtimeEventCategory(event) === 'exception' && (
                  <details className="runtime-details">
                    <summary>诊断详情</summary>
                    <small>
                      {[
                        event.message,
                        event.responseType
                          ? `返回类型：${responseLabels[event.responseType] ?? event.responseType}`
                          : '',
                        event.status === undefined ? '' : `HTTP ${event.status}`,
                        event.code ?? '',
                        event.rule ? `判定：${responseRuleLabels[event.rule]}（${event.rule}）` : '',
                        event.platformCode === undefined ? '' : `平台状态 ${event.platformCode}`,
                        event.shape ?? ''
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </small>
                  </details>
                )}
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
