import { useEffect, useRef, useState } from 'react'
import type { DataInfo } from '../../shared/contracts'
import { call, type Perform } from './api'
import { formatBytes as size } from './format'

export function DataPanel({
  accountId,
  busy,
  perform,
  importFile,
  exportAll
}: {
  accountId: string | null
  busy: boolean
  perform: Perform
  importFile: () => void
  exportAll: () => void
}) {
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
      <p>
        元数据与账号会话保存在本机。导出不含登录信息、封面和临时播放地址；导入后可通过采集或播放刷新封面。
      </p>
      <div className="panel-actions">
        <button disabled={!accountId || busy} onClick={importFile}>
          导入元数据
        </button>
        <button disabled={!accountId || busy} onClick={exportAll}>
          导出全部本地内容
        </button>
      </div>
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
      {error && (
        <p role="alert" className="task-error">
          {error}
        </p>
      )}
      <div className="panel-actions">
        <button
          onClick={() =>
            void perform('打开数据目录', () =>
              call(window.mylike.invoke('openDataFolder', { target: 'data' }))
            )
          }
        >
          打开数据目录
        </button>
        <button
          onClick={() =>
            void perform('打开备份目录', () =>
              call(window.mylike.invoke('openDataFolder', { target: 'backups' }))
            )
          }
        >
          打开备份目录
        </button>
        <button onClick={() => void refresh()}>刷新占用</button>
      </div>
    </section>
  )
}
