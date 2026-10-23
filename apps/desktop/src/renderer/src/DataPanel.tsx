import { useEffect, useRef, useState } from 'react'
import type { DataInfo } from '../../shared/contracts'
import { call, type Perform } from './api'
import { ConfirmDialog } from './ConfirmDialog'
import { formatBytes as size } from './format'

export function DataPanel({
  accountId,
  busy,
  perform,
  importFile,
  exportAll,
  notice
}: {
  accountId: string | null
  busy: boolean
  perform: Perform
  importFile: () => void
  exportAll: () => void
  notice: (message: string) => void
}) {
  const [info, setInfo] = useState<DataInfo | null>(null),
    [error, setError] = useState(''),
    [clear, setClear] = useState(false),
    [checking, setChecking] = useState(false),
    [checked, setChecked] = useState<{ ok: boolean; checkedAt: number; issues: number } | null>(null)
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
        <button
          disabled={busy}
          onClick={() =>
            void perform('创建一致性备份', async () => {
              const result = await call(window.mylike.invoke('backup', {}))
              notice(`备份已创建：${result.fileName}`)
              await refresh()
            })
          }
        >
          立即备份数据库
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
          <dt>当前页面缓存</dt>
          <dd>{size(info.cacheBytes)}</dd>
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
        <button
          disabled={checking || busy}
          onClick={() => {
            setChecking(true)
            void perform('检查本地数据库', async () => {
              setChecked(null)
              const result = await call(window.mylike.invoke('checkDatabase', {}))
              setChecked(result)
            }).finally(() => setChecking(false))
          }}
        >
          {checking ? '正在检查…' : '检查数据库完整性'}
        </button>
        <button
          disabled={!accountId || busy}
          onClick={() => {
            setError('')
            setClear(true)
          }}
        >
          清理页面缓存
        </button>
      </div>
      {checked && (
        <p className={checked.ok ? 'check-success' : 'task-error'} role="status">
          {checked.ok
            ? '检查通过：数据库结构与引用完整。'
            : `发现 ${checked.issues} 项问题，请先备份数据并保留诊断。`}{' '}
          · {new Date(checked.checkedAt).toLocaleTimeString('zh-CN')}
        </p>
      )}
      {clear && (
        <ConfirmDialog
          title="清理页面缓存"
          busy={busy}
          cancel={() => setClear(false)}
          confirmLabel="确认清理缓存"
          confirm={() =>
            accountId &&
            void perform('清理页面缓存', async () => {
              try {
                await call(window.mylike.invoke('clearCache', { accountId }))
                setClear(false)
                notice('页面缓存已清理，本地列表与登录凭据保留。')
                await refresh()
              } catch (error) {
                setError(error instanceof Error ? error.message : '缓存清理未完成。')
                throw error
              }
            })
          }
        >
          <p>
            将停止页面请求并关闭抖音窗口，清理当前账号及内容界面的网络与代码缓存。本地列表和登录凭据保留。
          </p>
          {error && (
            <p role="alert" className="task-error">
              {error}
            </p>
          )}
        </ConfirmDialog>
      )}
    </section>
  )
}
