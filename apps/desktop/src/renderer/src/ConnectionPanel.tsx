import type { Dispatch, ReactNode, SetStateAction } from 'react'
import {
  Bookmark,
  Heart,
  LogIn,
  Pause,
  Play,
  ShieldCheck,
  Square,
  Unplug,
  type LucideIcon
} from 'lucide-react'
import type { CollectionTask, Snapshot } from '../../shared/contracts'
import { accountLabel } from '../../shared/account-label'
import { call, statusLabels, type Perform } from './api'
import { UnlikePanel } from './UnlikePanel'
import { RuntimeHistory } from './RuntimeHistory'
import './tasks.css'

type Props = {
  snapshot: Snapshot | null
  accountId: string | null
  busy: boolean
  operationBusy: boolean
  login: () => void
  probe: () => void
  collect: (resume: boolean) => void
  startCollection: (mode: Exclude<CollectionTask['mode'], 'full'>) => void
  setError: Dispatch<SetStateAction<string>>
  perform: Perform
}
const states = { running: '进行中', paused: '已暂停', stopped: '已停止', completed: '已完成' }

function TaskCard({
  title,
  label,
  icon: Icon,
  status,
  summary,
  reason,
  attention,
  badge,
  activity,
  children
}: {
  title: string
  label: string
  icon: LucideIcon
  status?: keyof typeof states
  summary: string
  reason?: string | null
  attention?: boolean
  badge?: string
  activity?: string
  children: ReactNode
}) {
  return (
    <section className="simple-task" aria-label={label}>
      <div className="simple-task-heading">
        <span className="simple-task-icon">
          <Icon size={19} />
        </span>
        <h2>{title}</h2>
        <span className={`task-badge ${attention ? 'attention' : (status ?? '')}`}>
          {badge ?? (attention && status !== 'running' ? '需处理' : status ? states[status] : '未开始')}
        </span>
      </div>
      <div className="simple-task-body">
        <div className="simple-task-copy">
          <p>{summary}</p>
          {activity && <span className="task-activity">{activity}</span>}
          {reason && (
            <p className={attention ? 'task-problem' : 'task-note'} role={attention ? 'alert' : undefined}>
              {reason}
            </p>
          )}
        </div>
        <div className="simple-task-actions">{children}</div>
      </div>
      {status === 'running' && (
        <div className="task-working" role="progressbar" aria-label={`${title}进度`} />
      )}
    </section>
  )
}

export function ConnectionPanel({
  snapshot,
  accountId,
  busy,
  operationBusy,
  login,
  probe,
  collect,
  startCollection,
  setError,
  perform
}: Props) {
  const account = snapshot?.accounts.find((item) => item.id === accountId)
  const collection = snapshot?.collection?.accountId === accountId ? snapshot.collection : null
  const favorites = snapshot?.favorites?.accountId === accountId ? snapshot.favorites : null
  const unlike = snapshot?.unlike?.accountId === accountId ? snapshot.unlike : null
  const engine = snapshot?.engine.accountId === accountId ? snapshot.engine.status : 'stopped'
  const authentication = snapshot?.authentication?.accountId === accountId ? snapshot.authentication : null
  const control = (kind: 'likes' | 'favorites', action: 'pause' | 'resume' | 'stop') => {
    const task = kind === 'likes' ? collection : favorites
    if (!task || !accountId) return
    void perform('更新任务', () =>
      kind === 'likes'
        ? call(window.mylike.invoke('collectionControl', { accountId, taskId: task.id, action }))
        : call(window.mylike.invoke('favoritesControl', { accountId, taskId: task.id, action }))
    )
  }
  const runningActivity = (activity: Snapshot['collectionActivity']) =>
    activity === 'recycling'
      ? '分段休息，稍后自动继续'
      : activity === 'probing'
        ? '正在复查空页并探查后续分页，原断点保留'
        : activity === 'confirming'
          ? '收到结束标记，正在等待复查同一断点'
          : activity === 'cooling'
            ? '平台返回空内容，等待冷却后复查同一断点'
            : activity === 'requesting'
              ? '正在读取当前页'
              : '等待下一页'
  return (
    <div className="panel-scroll task-center">
      <div className="task-content">
        <section className="connection-strip" aria-label="账号连接">
          <span className={`connection-avatar ${engine === 'ready' ? 'ready' : ''}`}>
            <ShieldCheck size={21} />
          </span>
          <div className="connection-copy">
            <strong>{account ? accountLabel(account) : '尚未添加账号'}</strong>
            <p>
              {statusLabels[engine]}
              <span>
                {account?.lastVerifiedAt
                  ? ` · 最近核验 ${new Date(account.lastVerifiedAt).toLocaleString('zh-CN')}`
                  : ' · 登录后核验身份'}
              </span>
            </p>
          </div>
          <div className="connection-actions">
            <button disabled={!accountId || busy} onClick={login}>
              <LogIn size={15} />
              打开抖音窗口
            </button>
            <button className="primary verify-login" disabled={!accountId || busy} onClick={probe}>
              <ShieldCheck size={15} />
              核验登录
            </button>
          </div>
        </section>
        {authentication && (
          <p className="task-note" role="status">
            {authentication.message}
          </p>
        )}

        <div className="collection-tasks" aria-label="采集任务">
          <TaskCard
            title="喜欢列表采集"
            label="自动采集任务"
            icon={Heart}
            status={collection?.status}
            summary={
              collection
                ? `本轮新增 ${collection.added} 条 · 接收 ${collection.received} 条 · 已保存 ${collection.pages} 页`
                : '将喜欢的作品收录到本机'
            }
            activity={
              collection?.status === 'running'
                ? `${collection.mode === 'incremental' ? '更新 · ' : ''}${runningActivity(snapshot?.collectionActivity ?? null)}`
                : undefined
            }
            reason={
              collection?.errorCode || collection?.status === 'completed'
                ? collection.reason?.replace('；需要重新遍历时可从头采集。', '。')
                : null
            }
            attention={!!collection?.errorCode && collection.errorCode !== 'NO_AVAILABLE_ITEMS'}
            badge={collection?.errorCode === 'NO_AVAILABLE_ITEMS' ? '待复查' : undefined}
          >
            {collection?.status === 'running' ? (
              <>
                <button disabled={operationBusy} onClick={() => control('likes', 'pause')}>
                  <Pause size={15} />
                  暂停采集
                </button>
                <button
                  className="task-text-button"
                  disabled={operationBusy}
                  onClick={() => control('likes', 'stop')}
                >
                  停止采集
                </button>
              </>
            ) : (
              <>
                <button
                  disabled={!accountId || busy}
                  onClick={() =>
                    collection && collection.status !== 'completed'
                      ? control('likes', 'resume')
                      : startCollection('update')
                  }
                >
                  <Play size={15} />
                  {collection && collection.status !== 'completed'
                    ? collection.mode === 'incremental'
                      ? '继续更新'
                      : '继续采集'
                    : collection?.mode === 'incremental' && collection.backfillCursor !== null
                      ? '继续历史采集'
                      : '采集喜欢'}
                </button>
                {collection && !(collection.mode === 'incremental' && collection.status !== 'completed') && (
                  <button
                    disabled={busy}
                    onClick={() => startCollection('incremental')}
                    title="从列表头部检查新增点赞，保留历史采集断点"
                  >
                    更新
                  </button>
                )}
                {collection?.status === 'completed' &&
                  collection.tailCursor != null &&
                  (collection.phase === 'backfill' || collection.backfillCursor === null) && (
                    <button
                      className="task-text-button"
                      disabled={busy}
                      onClick={() => startCollection('recheck')}
                      title="从上次确认结束的位置重新读取，检查平台是否恢复了更多内容"
                    >
                      复查末尾
                    </button>
                  )}
              </>
            )}
          </TaskCard>
          <TaskCard
            title="收藏同步"
            label="收藏同步"
            icon={Bookmark}
            status={favorites?.status}
            summary={
              favorites
                ? `新增 ${favorites.added} 条 · 收藏夹 ${favorites.foldersDone}/${favorites.foldersTotal}`
                : '收录收藏作品，并同步收藏夹分组'
            }
            activity={
              favorites?.status === 'running'
                ? `${favorites.stage === 'all' ? '收藏作品' : favorites.stage === 'folders' ? '收藏夹列表' : '收藏夹作品'} · ${runningActivity(snapshot?.favoritesActivity ?? null)}`
                : undefined
            }
            reason={favorites?.errorCode || favorites?.status === 'completed' ? favorites.reason : null}
            attention={!!favorites?.errorCode}
          >
            {favorites?.status === 'running' ? (
              <>
                <button disabled={operationBusy} onClick={() => control('favorites', 'pause')}>
                  <Pause size={15} />
                  暂停同步
                </button>
                <button
                  className="task-text-button"
                  disabled={operationBusy}
                  onClick={() => control('favorites', 'stop')}
                >
                  停止同步
                </button>
              </>
            ) : (
              <button
                disabled={!accountId || busy}
                onClick={() => {
                  if (favorites && favorites.status !== 'completed') control('favorites', 'resume')
                  else if (accountId)
                    void perform('同步收藏', () =>
                      call(window.mylike.invoke('favoritesStart', { accountId }))
                    )
                }}
              >
                <Play size={15} />
                {favorites && favorites.status !== 'completed' ? '继续同步收藏' : '同步收藏'}
              </button>
            )}
          </TaskCard>
        </div>

        <UnlikePanel
          key={accountId ?? 'no-account'}
          accountId={accountId}
          latest={unlike}
          busy={operationBusy}
          resumeDisabled={busy}
          perform={perform}
        />

        <details className="task-tools">
          <summary>诊断与运行记录</summary>
          <div className="task-tools-content">
            <p className="task-note">单页检查仅用于诊断，开始前先暂停自动任务。</p>
            <div className="task-tool-actions">
              <button disabled={!accountId || busy} onClick={() => collect(false)}>
                采集一页
              </button>
              <button disabled={!accountId || busy} onClick={() => collect(true)}>
                继续下一页
              </button>
              <button
                disabled={!snapshot?.busy}
                onClick={() =>
                  void call(window.mylike.invoke('stopRequest', {})).catch((error) => setError(error.message))
                }
              >
                <Square size={14} />
                停止当前请求
              </button>
              <button
                onClick={() =>
                  void perform('释放引擎', () => call(window.mylike.invoke('releaseEngine', {})))
                }
              >
                <Unplug size={15} />
                释放页面引擎
              </button>
            </div>
            <RuntimeHistory accountId={accountId} revision={snapshot} />
          </div>
        </details>
      </div>
    </div>
  )
}
