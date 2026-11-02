import { CollectionActions } from './CollectionActions'
import { useEffect, useState } from 'react'
import { Sparkles, ScanSearch } from 'lucide-react'
import type { FavoriteFolder, FavoritesTask, Snapshot } from '../../shared/contracts'
import type { RecoveryState } from '../../shared/recovery-state'
import { taskRecovery } from '../../shared/task-recovery'
import { call, type Perform } from './api'
import { Select } from './Select'

export function FavoriteIssues({ task }: { task: FavoritesTask | null }) {
  return task?.issues?.length ? (
    <details className="favorite-sync-issues">
      <summary>未完成的收藏夹（{task.issues.length}）</summary>
      <ul>
        {task.issues.map((issue) => (
          <li key={issue.folderId}>
            <strong>{issue.title}</strong>
            <small>
              {taskRecovery(issue.errorCode)?.message ?? '暂时未能同步这个收藏夹，可以稍后重试。'}
            </small>
            <details className="runtime-details">
              <summary>诊断详情</summary>
              <small>{'ID ' + issue.folderId + ' · ' + issue.reason}</small>
            </details>
          </li>
        ))}
      </ul>
    </details>
  ) : null
}
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
  folders,
  folderId,
  setFolderId,
  error,
  compact = false,
  snapshot,
  notice
}: {
  snapshot: Snapshot | null
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
  updateTask?: FavoritesTask | null
  recovery?: readonly RecoveryState[]
  login?: () => void
  accessChecks?: readonly { accountId: string; operation: string; at: number }[]
  notice?: (message: string) => void
}) {
  const latest = snapshot?.favoritesUpdate
  const progress =
    latest && (latest.status === 'running' || latest.updatedAt > (task?.updatedAt ?? 0)) ? latest : task
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
              label: folder.title + ' · ' + folder.localCount
            }))
          ]}
        />
      )}
      {progress && (
        <span className="favorites-progress" role="status">
          {(progress.status === 'running'
            ? '进行中'
            : progress.status === 'completed'
              ? '已完成'
              : progress.status === 'partial'
                ? '部分完成'
                : '已停止') +
            ' · 本次新增 ' +
            progress.added +
            ' 条' +
            (progress.mode === 'update'
              ? ' · 更新顶部'
              : ' · 收藏夹 ' + progress.foldersDone + '/' + progress.foldersTotal)}
        </span>
      )}
      <div className="panel-actions">
        <CollectionActions
          snapshot={snapshot}
          accountId={accountId}
          source="favorites"
          busy={busy}
          perform={perform}
        />
        <button
          disabled={!accountId || busy}
          onClick={() =>
            void perform('AI 自动整理收藏', async () => {
              const result = await call(window.mylike.invoke('aiClassifyFavorites', { accountId: accountId! }))
              notice?.(
                [
                  `AI 分类完成：成功 ${result.classified} 条，失败 ${result.failed} 条，创建 ${result.foldersCreated} 个收藏夹，使用 ${result.foldersUsed} 个收藏夹。`,
                  ...result.failedItems.map(
                    (item) => `失败作品 ${item.workId}（${item.category}）：${item.reason}`
                  )
                ].join('\n')
              )
            })
          }
          title="使用语音转文字和 DeepSeek 自动分类默认收藏"
        >
          <Sparkles size={14} />
          AI 自动分类
        </button>
        <button
          disabled={!accountId || busy}
          onClick={() =>
            void perform('扫描文字作品', async () => {
              const result = await call(
                window.mylike.invoke('scanTextWorks', { accountId: accountId!, source: 'favorites' })
              )
              notice?.(`扫描完成：检查 ${result.scanned} 条，识别文字 ${result.text} 条，失败 ${result.failed} 条。`)
            })
          }
          title="批量读取作品详情，识别文字作品"
        >
          <ScanSearch size={14} />
          扫描文字作品
        </button>
      </div>
      {error && (
        <p role="alert" className="task-error">
          {error}
        </p>
      )}

      <FavoriteIssues task={task} />
    </section>
  )
}
