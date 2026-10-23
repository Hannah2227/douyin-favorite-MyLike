import { useEffect, useState } from 'react'
import { Pause, Square, RefreshCw } from 'lucide-react'
import type { FavoriteFolder, FavoritesTask } from '../../shared/contracts'
import { call, type Perform } from './api'
import { Select } from './Select'

export function useFavoriteFolders(accountId: string | null, revision: number) {
  const [result, setResult] = useState<{
    accountId: string
    folders: FavoriteFolder[]
    error: string
  } | null>(null)
  useEffect(() => {
    if (!accountId) return
    let current = true
    void call(window.mylike.invoke('favoriteFolders', { accountId })).then(
      (folders) => {
        if (current) setResult({ accountId, folders, error: '' })
      },
      (error) => {
        if (current) setResult({ accountId, folders: [], error: error.message })
      }
    )
    return () => {
      current = false
    }
  }, [accountId, revision])
  return result?.accountId === accountId
    ? { ...result, loaded: true }
    : { folders: [], error: '', loaded: false }
}
export function FavoritesPanel({
  accountId,
  task,
  busy,
  perform,
  start,
  folders,
  folderId,
  setFolderId,
  error,
  compact = false
}: {
  accountId: string | null
  task: FavoritesTask | null
  busy: boolean
  perform: Perform
  start: () => void
  folders?: FavoriteFolder[]
  folderId?: string | null
  setFolderId?: (id: string | null) => void
  error?: string
  compact?: boolean
}) {
  const running = task?.status === 'running'
  const control = (action: 'pause' | 'resume' | 'stop') =>
    task &&
    void perform('更新收藏同步', () =>
      call(window.mylike.invoke('favoritesControl', { accountId: task.accountId, taskId: task.id, action }))
    )
  const stage =
    task?.stage === 'all'
      ? '收藏作品'
      : task?.stage === 'folders'
        ? '收藏夹列表'
        : folders?.find((f) => f.id === task?.folderId)?.title || '收藏夹作品'
  return (
    <section className={compact ? 'favorites-toolbar' : 'panel'} aria-label="收藏同步">
      {!compact && <h2>收藏与收藏夹</h2>}
      {setFolderId && (
        <Select
          label="收藏夹筛选"
          value={folderId ?? ''}
          onChange={(value) => setFolderId(value || null)}
          options={[
            { value: '', label: '全部收藏' },
            ...(folders ?? []).map((folder) => ({
              value: folder.id,
              label: `${folder.title} · ${folder.localCount}`
            }))
          ]}
        />
      )}
      {task && (
        <span className="favorites-progress" role="status">
          {running
            ? `正在同步${stage}`
            : task.status === 'completed'
              ? '同步完成'
              : task.status === 'stopped'
                ? '已停止'
                : '已暂停'}{' '}
          · 新增 {task.added} 条 · 收藏夹 {task.foldersDone}/{task.foldersTotal}
        </span>
      )}
      <div className="panel-actions">
        {running ? (
          <button onClick={() => control('pause')}>
            <Pause size={14} />
            暂停同步
          </button>
        ) : (
          <button disabled={!accountId || busy} onClick={start}>
            <RefreshCw size={14} />
            {task && task.status !== 'completed' ? '继续同步收藏' : '同步收藏'}
          </button>
        )}
        {task && task.status !== 'completed' && task.status !== 'stopped' && (
          <button disabled={busy && !running} onClick={() => control('stop')}>
            <Square size={14} />
            停止同步
          </button>
        )}
      </div>
      {(error || (task?.status !== 'completed' && task?.reason)) && (
        <p
          role={error || task?.errorCode ? 'alert' : undefined}
          className={error || task?.errorCode ? 'task-error' : 'muted'}
        >
          {error || task?.reason}
        </p>
      )}
    </section>
  )
}
