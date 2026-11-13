import { CollectionActions } from './CollectionActions'
import { useEffect, useState } from 'react'
import { ScanSearch, Sparkles } from 'lucide-react'
import type { FavoriteFolder, FavoritesTask, Snapshot } from '../../shared/contracts'
import type { RecoveryState } from '../../shared/recovery-state'
import { taskRecovery } from '../../shared/task-recovery'
import { call, type Perform } from './api'
import { Select } from './Select'
import { LocalFoldersDialog } from './LocalFoldersDialog'

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
export function useFavoriteFolders(
  accountId: string | null,
  revision: number,
  onError: (message: string) => void
) {
  const [result, setResult] = useState<{
    accountId: string
    folders: FavoriteFolder[]
  } | null>(null)
  useEffect(() => {
    if (!accountId) return
    let current = true
    void call(window.mylike.invoke('favoriteFolders', { accountId })).then(
      (folders) => {
        if (current) setResult({ accountId, folders })
      },
      (error) => {
        if (current) {
          setResult({ accountId, folders: [] })
          onError(error instanceof Error ? error.message : '读取收藏夹失败。')
        }
      }
    )
    return () => {
      current = false
    }
  }, [accountId, revision, onError])
  const refresh = async () => {
    if (!accountId) return []
    const folders = await call(window.mylike.invoke('favoriteFoldersRefresh', { accountId }))
    setResult({ accountId, folders })
    return folders
  }
  return result?.accountId === accountId
    ? { ...result, loaded: true, refresh }
    : { folders: [], loaded: false, refresh }
}
export function FavoritesPanel({
  accountId,
  task,
  busy,
  perform,
  folders,
  openClassification,
  foldersLoaded = true,
  folderId,
  setFolderId,
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
  openClassification: (source: 'likes' | 'favorites') => void
  foldersLoaded?: boolean
  folderId?: string | null
  setFolderId?: (id: string | null) => void
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
  const [manageLocalFolders, setManageLocalFolders] = useState(false)
  const selectedFolder = folders?.find((folder) => folder.id === folderId)
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
      {selectedFolder &&
        !selectedFolder.localOnly &&
        selectedFolder.localCount !== selectedFolder.remoteCount && (
          <span className="favorites-progress" role="note">
            {`本地 ${selectedFolder.localCount} 条 · 最近云端 ${selectedFolder.remoteCount} 条`}
          </span>
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
              : ' · 收藏夹 ' +
                progress.foldersDone +
                '/' +
                progress.foldersTotal +
                (progress.status === 'running' && progress.folderTitle ? ' · ' + progress.folderTitle : ''))}
        </span>
      )}
      <div className="panel-actions">
        <CollectionActions
          snapshot={snapshot}
          accountId={accountId}
          source="favorites"
          busy={busy}
          perform={perform}
          syncFolders
          syncToCloud={snapshot?.appPreferences.syncFavoritesToCloud ?? false}
          pendingWrites={snapshot?.favoriteWritePending ?? 0}
          notice={notice}
          folders={folders}
          onManageLocalFolders={() => setManageLocalFolders(true)}
          foldersLoaded={foldersLoaded}
        />
        <button
          disabled={!accountId || busy || !foldersLoaded}
          onClick={() => openClassification('favorites')}
          title={foldersLoaded ? '先核实抖音收藏夹，再选择分类目标' : '正在读取收藏夹'}
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
              notice?.(
                `扫描结束：尝试 ${result.scanned} 条，扫描成功 ${result.succeeded} 条，扫描失败 ${result.failed} 条，待稍后扫描 ${result.deferred} 条，识别文字 ${result.text} 条，新增文字 ${result.addedText} 条。`
              )
            })
          }
          title="批量读取作品详情，识别文字作品"
        >
          <ScanSearch size={14} />
          扫描文字作品
        </button>
      </div>
      <FavoriteIssues task={task} />
      {manageLocalFolders && accountId && (
        <LocalFoldersDialog
          accountId={accountId}
          folders={folders ?? []}
          busy={busy}
          perform={perform}
          close={() => setManageLocalFolders(false)}
          notice={(message) => notice?.(message)}
        />
      )}
    </section>
  )
}
