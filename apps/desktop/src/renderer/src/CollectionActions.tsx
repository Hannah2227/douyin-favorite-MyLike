import { useState } from 'react'
import type { Snapshot } from '../../shared/contracts'
import { favoriteReadOperation, recoveryUntil } from '../../shared/task-presentation'
import { useRecoveryClock } from './useRecoveryClock'
import type { Perform } from './api'
export function CollectionActions({
  snapshot,
  accountId,
  source,
  busy,
  perform
}: {
  snapshot: Snapshot | null
  accountId: string | null
  source: 'likes' | 'favorites'
  busy: boolean
  perform: Perform
}) {
  const [rejectedFor, setRejectedFor] = useState<{ accountId: string; at: number } | null>(null)
  const rejected = rejectedFor?.accountId === accountId
  const now = useRecoveryClock(snapshot?.recovery)
  const task = source === 'likes' ? snapshot?.collection : snapshot?.favorites
  const top = source === 'favorites' ? snapshot?.favoritesUpdate : null
  const running = task?.status === 'running' || top?.status === 'running'
  const pending = [task, top].some((t) => t && t.status !== 'completed' && t.status !== 'stopped')
  const recovered = (operation: string, at: number) =>
    ['self', operation].every((op) =>
      snapshot?.health?.entries.some(
        (e) => e.operation === op && e.status === 'normal' && e.at >= at && Date.now() - e.at < 600000
      )
    )
  const blocked =
    (!!task?.errorCode &&
      !recovered(
        source === 'likes' ? 'likes' : favoriteReadOperation(snapshot?.favorites),
        task.updatedAt
      )) ||
    (!!top?.errorCode && !recovered('favorites', top.updatedAt)) ||
    (rejected && !recovered(source === 'likes' ? 'likes' : 'favorites', rejectedFor?.at ?? 0))
  const waiting = (operation: string) =>
    accountId ? recoveryUntil(accountId, ['self', operation], snapshot?.recovery) > now : false
  const execute = (action: 'top' | 'down' | 'stop') =>
    void perform(action === 'stop' ? '停止任务' : '启动采集', async () => {
      if (!accountId) return
      setRejectedFor(null)
      const result = await window.mylike.invoke('collectionAction', { accountId, source, action })
      if (!result.ok) setRejectedFor({ accountId, at: Date.now() })
    })
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
      </div>
      {blocked && !running && (
        <small className="collection-blocked" role="status">
          任务受阻，进度已保存。请到“连接与任务”核验状态。
        </small>
      )}
    </div>
  )
}
