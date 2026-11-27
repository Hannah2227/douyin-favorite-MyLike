import { useEffect, useRef, useState } from 'react'
import { Shuffle } from 'lucide-react'
import type { QueueCreate, QueueMonths } from '../../shared/contracts'
import { call } from './api'
import { Select } from './Select'
import './shuffle-dialog.css'

type MonthRange = NonNullable<QueueCreate['monthRange']>
const monthOptions = Array.from({ length: 12 }, (_, index) => {
  const month = index + 1
  return { value: String(month), label: `${month} 月` }
})

export function ShuffleDialog({
  accountId,
  source,
  close,
  start
}: Pick<QueueCreate, 'accountId' | 'source'> & { close: () => void; start: (range?: MonthRange) => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [scope, setScope] = useState<QueueMonths>()
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [specific, setSpecific] = useState(false)
  const [picked, setPicked] = useState<MonthRange>()

  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  useEffect(() => {
    let current = true
    void call(window.mylike.invoke('queueMonths', { accountId, source }))
      .then((result) => {
        if (current) setScope(result)
      })
      .catch((failure: Error) => {
        if (current) setError(failure.message)
      })
    return () => {
      current = false
    }
  }, [accountId, source, attempt])

  const months = scope?.months ?? []
  const keys = months.map(({ key }) => key)
  const yearOptions = [...new Set(keys.map((key) => Math.floor(key / 100)))]
    .sort((a, b) => b - a)
    .map((year) => ({ value: String(year), label: `${year} 年` }))
  const range =
    specific && keys.length ? (picked ?? { from: Math.min(...keys), to: Math.max(...keys) }) : undefined
  const reversed = range && range.from > range.to
  const total = range
    ? months.reduce((sum, { key, count }) => (key >= range.from && key <= range.to ? sum + count : sum), 0)
    : (scope?.total ?? 0)

  return (
    <dialog
      ref={dialog}
      className="modal confirm-dialog shuffle-dialog"
      aria-label="洗牌播放"
      onClose={close}
    >
      <header className="shuffle-heading">
        <span className="shuffle-icon">
          <Shuffle size={20} aria-hidden="true" />
        </span>
        <div>
          <h2>洗牌播放</h2>
          <p>按作品发布时间选取范围</p>
        </div>
      </header>
      <div className="shuffle-body">
        <div className="shuffle-modes" role="group" aria-label="播放时间">
          <button type="button" aria-pressed={!specific} disabled={!scope} onClick={() => setSpecific(false)}>
            全部时间
          </button>
          <button
            type="button"
            aria-pressed={specific}
            disabled={!keys.length}
            onClick={() => setSpecific(true)}
          >
            指定年月
          </button>
        </div>
        {error ? (
          <div className="shuffle-read-state">
            <p role="alert">{error}</p>
            <button
              type="button"
              onClick={() => {
                setError('')
                setAttempt((n) => n + 1)
              }}
            >
              重试
            </button>
          </div>
        ) : !scope ? (
          <p role="status">正在读取作品年月…</p>
        ) : !keys.length ? (
          <p>当前列表没有可按年月筛选的作品。</p>
        ) : range ? (
          <div className="shuffle-dates">
            {(['from', 'to'] as const).map((end) => {
              const label = end === 'from' ? '开始' : '结束'
              const year = Math.floor(range[end] / 100)
              const month = range[end] % 100
              return (
                <div className="shuffle-date-row" key={end}>
                  <span>{label}年月</span>
                  <Select
                    label={`${label}年份`}
                    value={String(year)}
                    options={yearOptions}
                    onChange={(value) => setPicked({ ...range, [end]: Number(value) * 100 + month })}
                  />
                  <Select
                    label={`${label}月份`}
                    value={String(month)}
                    options={monthOptions}
                    onChange={(value) => setPicked({ ...range, [end]: year * 100 + Number(value) })}
                  />
                </div>
              )
            })}
          </div>
        ) : null}
      </div>
      <footer className="shuffle-footer">
        <output aria-live="polite" className={reversed ? 'is-invalid' : undefined}>
          {scope && (reversed ? '结束年月不能早于开始年月' : `范围内 ${total} 条作品`)}
        </output>
        <div className="panel-actions">
          <button type="button" autoFocus onClick={() => dialog.current?.close()}>
            取消
          </button>
          <button type="button" className="primary" disabled={!total} onClick={() => start(range)}>
            开始洗牌
          </button>
        </div>
      </footer>
    </dialog>
  )
}
