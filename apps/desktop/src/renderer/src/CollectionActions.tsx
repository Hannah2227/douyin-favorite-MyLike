import { useState } from 'react'
import type { FavoriteFolder } from '../../shared/contracts'
import type { Snapshot } from '../../shared/contracts'
import { favoriteReadOperation, recoveryUntil } from '../../shared/task-presentation'
import { useRecoveryClock } from './useRecoveryClock'
import { call, type Perform } from './api'
import { FavoriteWritebackDialog } from './FavoriteWritebackDialog'
export function CollectionActions({
  snapshot,
  accountId,
  source,
  busy,
  perform,
  syncFolders = false,
  syncToCloud = false,
  pendingWrites = 0,
  notice,
  folders = [],
  onManageLocalFolders,
  foldersLoaded = true
}: {
  snapshot: Snapshot | null
  accountId: string | null
  source: 'likes' | 'favorites'
  busy: boolean
  perform: Perform
  syncFolders?: boolean
  syncToCloud?: boolean
  pendingWrites?: number
  notice?: (message: string) => void
  folders?: FavoriteFolder[]
  onManageLocalFolders?: () => void
  foldersLoaded?: boolean
}) {
  const [writebackOpen, setWritebackOpen] = useState(false)
  const now = useRecoveryClock(snapshot?.recovery)
  const task = source === 'likes' ? snapshot?.collection : snapshot?.favorites
  const top = source === 'favorites' ? snapshot?.favoritesUpdate : null
  const running = task?.status === 'running' || top?.status === 'running'
  const pending = [task, top].some((t) => t && t.status !== 'completed' && t.status !== 'stopped')
  const waiting = (operation: string) =>
    accountId ? recoveryUntil(accountId, ['self', operation], snapshot?.recovery) > now : false
  const execute = (action: 'top' | 'down' | 'stop' | 'folders') =>
    void perform(
      action === 'stop' ? '停止任务' : action === 'folders' ? '同步收藏夹' : '启动采集',
      async () => {
        if (!accountId) return
        await call(window.mylike.invoke('collectionAction', { accountId, source, action }))
      }
    )
  return (
    <div className="collection-control-group">
      <div
        className="collection-controls"
        role="group"
        aria-label={source === 'likes' ? '喜欢采集操作' : '收藏采集操作'}
      >
        <button
          disabled={!accountId || busy || running || waiting(source === 'likes' ? 'likes' : 'favorites')}
          onClick={() => execute('top')}
        >
          更新顶部
        </button>
        <button
          disabled={
            !accountId ||
            busy ||
            running ||
            waiting(source === 'likes' ? 'likes' : favoriteReadOperation(snapshot?.favorites))
          }
          onClick={() => execute('down')}
        >
          向下采集
        </button>
        <button disabled={!accountId || (!running && !pending)} onClick={() => execute('stop')}>
          停止
        </button>
        {syncFolders && (
          <button
            disabled={!accountId || busy || running || waiting('folders')}
            onClick={() => execute('folders')}
            title="从抖音读取收藏夹及其作品的最新内容到本机，不会修改云端"
          >
            同步收藏夹
          </button>
        )}
        {syncFolders && onManageLocalFolders && (
          <button
            disabled={!accountId || busy || !foldersLoaded}
            onClick={onManageLocalFolders}
            title="创建、改名或删除本地创建的收藏夹"
          >
            管理本地收藏夹
          </button>
        )}
        {syncToCloud && (
          <button
            disabled={!accountId || busy || running || !foldersLoaded}
            onClick={() => setWritebackOpen(true)}
            title={
              !foldersLoaded
                ? '正在读取收藏夹'
                : pendingWrites
                  ? `把本机改动写回抖音（${pendingWrites} 项待写回）`
                  : '选择收藏夹，把本机新增的收藏夹和作品写回抖音'
            }
          >
            写回云端{pendingWrites ? ` · ${pendingWrites}` : ''}
          </button>
        )}
      </div>
      {syncToCloud && writebackOpen && accountId && (
        <FavoriteWritebackDialog
          accountId={accountId}
          folders={folders}
          pendingWrites={pendingWrites}
          busy={busy}
          perform={perform}
          close={() => setWritebackOpen(false)}
          notice={notice}
        />
      )}
    </div>
  )
}
