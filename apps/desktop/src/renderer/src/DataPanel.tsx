import { useEffect, useRef, useState } from 'react'
import type { DataInfo } from '../../shared/contracts'
import { call, type Perform } from './api'
import { formatBytes as size } from './format'

export function DataPanel({ accountId, perform }: { accountId: string | null; perform: Perform }) {
  const [info, setInfo] = useState<DataInfo | null>(null),
    [error, setError] = useState('')
  const sequence = useRef(0)
  const refresh = async () => {
    const current = ++sequence.current
    try {
      const next = await call(window.mylike.invoke('dataInfo', { accountId }))
      if (current === sequence.current) {
        setInfo(next)
        setError('')
      }
    } catch (e) {
      if (current === sequence.current) setError(e instanceof Error ? e.message : '数据占用读取失败。')
    }
  }
  useEffect(() => {
    setInfo(null)
    void refresh()
    return () => {
      sequence.current++
    }
  }, [accountId])
  return (
    <section className="panel">
      <h2>数据与备份</h2>
      {info && (
        <dl className="diagnostics">
          <dt>数据目录</dt>
          <dd className="data-path">{info.folder}</dd>
          <dt>元数据文件</dt>
          <dd>{size(info.metadataBytes)}</dd>
          <dt>数据库备份</dt>
          <dd>
            {info.backupsCount} 份 · {size(info.backupsBytes)}
          </dd>
        </dl>
      )}
      {info?.warning && <p role="status">{info.warning}</p>}
      {error && (
        <p role="alert" className="task-error">
          {error}
        </p>
      )}
      <div className="panel-actions">
        <button
          disabled={!info}
          onClick={() => void perform('更改目录', () => call(window.mylike.invoke('moveDataFolder', {})))}
        >
          更改目录
        </button>
      </div>
    </section>
  )
}
