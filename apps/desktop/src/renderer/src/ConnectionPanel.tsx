import { FolderPlus, ScanSearch, Sparkles, Square } from 'lucide-react'
import './tasks.css'
import type { FavoritesTask, Snapshot } from '../../shared/contracts'
import { CollectionActions } from './CollectionActions'
import { HealthPanel } from './HealthPanel'
import { UnlikePanel } from './UnlikePanel'
import { RuntimeHistory } from './RuntimeHistory'
import { FavoriteIssues } from './FavoritesPanel'
import type { Perform } from './api'

function formatRemainingTime(progress: { current: number; total: number; startedAt: number }): string {
  const elapsed = Date.now() - progress.startedAt
  const remaining = Math.ceil(((elapsed / progress.current) * (progress.total - progress.current)) / 60_000)
  return remaining < 1 ? '不到 1 分钟' : `约 ${remaining} 分钟`
}

const activityText: Record<
  NonNullable<Snapshot['favoritesActivity']> | NonNullable<Snapshot['collectionActivity']>,
  string
> = {
  requesting: '正在读取数据…',
  waiting: '等待下一次请求…',
  recycling: '正在更换页面会话…',
  confirming: '正在确认列表末尾…',
  cooling: '正在冷却…',
  probing: '正在探查空页…'
}

export function ConnectionPanel({
  snapshot,
  accountId,
  busy,
  operationBusy,
  login,
  probe,
  scanTextWorks,
  textScanStatus,
  textScan,
  stopTextScan,
  perform,
  openClassification
}: {
  snapshot: Snapshot | null
  accountId: string | null
  busy: boolean
  operationBusy: boolean
  login: () => void
  probe: () => void
  scanTextWorks: (source: 'likes' | 'favorites') => void
  textScanStatus?: 'running' | 'completed' | 'stopped'
  textScan: Snapshot['textScan']
  stopTextScan: () => void
  perform: Perform
  openClassification: (source: 'likes' | 'favorites') => void
}) {
  const aiProgress = snapshot?.aiClassification
  const aiRunning = aiProgress?.status === 'running'
  const aiPercent =
    aiProgress && aiProgress.total > 0
      ? Math.min(100, Math.round((aiProgress.current / aiProgress.total) * 100))
      : 0
  const aiHasProgress = !!aiProgress && aiProgress.total > 0
  return (
    <div className="panel-scroll task-center">
      <div className="task-content">
        <HealthPanel snapshot={snapshot} accountId={accountId} login={login} probe={probe} />
        <div className="collection-tasks" aria-label="采集任务">
          {(['likes', 'favorites'] as const).map((source) => {
            const task = source === 'likes' ? snapshot?.collection : snapshot?.favorites
            const top = source === 'favorites' ? snapshot?.favoritesUpdate : null
            const running = task?.status === 'running' || top?.status === 'running'
            const title = source === 'likes' ? '喜欢列表采集' : '收藏同步'
            const label = source === 'likes' ? '自动采集任务' : '收藏同步'
            const current =
              top && (top.status === 'running' || top.updatedAt > (task?.updatedAt ?? 0)) ? top : task
            const favoritesTask = source === 'favorites' ? (current as FavoritesTask | null) : null
            const activity = source === 'likes' ? snapshot?.collectionActivity : snapshot?.favoritesActivity
            const percent =
              favoritesTask && favoritesTask.foldersTotal > 0
                ? Math.min(100, Math.round((favoritesTask.foldersDone / favoritesTask.foldersTotal) * 100))
                : 0
            return (
              <section key={source} className="simple-task" aria-label={label}>
                <div className="simple-task-heading">
                  <h2>{title}</h2>
                  <span className="task-badge">
                    {running
                      ? '进行中'
                      : current?.status === 'completed'
                        ? '已完成'
                        : current?.status === 'partial'
                          ? '部分完成'
                          : current
                            ? '已停止'
                            : '未开始'}
                  </span>
                </div>
                <div className="simple-task-body">
                  <div className="simple-task-copy">
                    <p>
                      {current ? (
                        <>
                          {'本次新增 ' + current.added + ' 条'}
                          {favoritesTask
                            ? favoritesTask.mode === 'update'
                              ? ' · 更新顶部'
                              : ' · 收藏夹 ' + favoritesTask.foldersDone + '/' + favoritesTask.foldersTotal
                            : ''}
                        </>
                      ) : source === 'likes' ? (
                        '将喜欢的作品收录到本机'
                      ) : (
                        '收录收藏作品，并同步收藏夹分组'
                      )}
                    </p>
                    {running && (activity || favoritesTask?.folderTitle) && (
                      <span className="task-activity">
                        {favoritesTask?.folderTitle
                          ? `正在同步收藏夹「${favoritesTask.folderTitle}」`
                          : activity
                            ? activityText[activity]
                            : ''}
                      </span>
                    )}
                  </div>
                  <CollectionActions
                    snapshot={snapshot}
                    accountId={accountId}
                    source={source}
                    busy={busy}
                    perform={perform}
                  />
                </div>
                {source === 'favorites' && <FavoriteIssues task={snapshot?.favorites ?? null} />}
                {running ? (
                  favoritesTask && favoritesTask.foldersTotal > 0 ? (
                    <div
                      className="task-progress"
                      role="progressbar"
                      aria-label="收藏夹同步进度"
                      aria-valuemin={0}
                      aria-valuemax={favoritesTask.foldersTotal}
                      aria-valuenow={favoritesTask.foldersDone}
                    >
                      <span style={{ width: `${percent}%` }} />
                    </div>
                  ) : (
                    <div className="task-working" role="progressbar" aria-label={title + '进度'} />
                  )
                ) : null}
              </section>
            )
          })}
          <section className="simple-task" aria-label="AI 自动分类进度">
            <div className="simple-task-heading">
              <h2>AI 自动分类</h2>
              <span className={`task-badge${aiRunning ? ' running' : ''}`}>
                {aiRunning
                  ? '进行中'
                  : aiProgress?.status === 'completed'
                    ? '已完成'
                    : aiProgress?.status === 'failed'
                      ? '失败'
                      : aiProgress?.status === 'stopped'
                        ? '已停止'
                        : '未开始'}
              </span>
            </div>
            <div className="simple-task-body">
              <div className="simple-task-copy">
                <p>
                  {aiProgress
                    ? `${aiProgress.phase}${
                        aiHasProgress
                          ? ` · ${aiProgress.current}/${aiProgress.total} 条（${aiPercent}%）`
                          : ''
                      }`
                    : '选择喜欢或收藏作品，分析后添加到勾选的收藏夹'}
                </p>
                {aiProgress?.status === 'failed' && aiProgress.error && (
                  <p className="task-problem" role="alert">
                    {aiProgress.error}
                  </p>
                )}
              </div>
              <div className="simple-task-actions">
                <button
                  disabled={!accountId || busy || aiRunning}
                  onClick={() => openClassification('likes')}
                  title="分析喜欢的作品，并添加到选中的收藏夹"
                >
                  <FolderPlus size={15} />
                  添加喜欢
                </button>
                <button
                  disabled={!accountId || busy || aiRunning}
                  onClick={() => openClassification('favorites')}
                  title="分析已收藏的作品，并分类到选中的收藏夹"
                >
                  <Sparkles size={15} />
                  收藏分类
                </button>
              </div>
            </div>
            {aiHasProgress ? (
              <div
                className={`task-progress${aiProgress?.status === 'failed' ? ' failed' : ''}`}
                role="progressbar"
                aria-label="AI 自动分类进度"
                aria-valuemin={0}
                aria-valuemax={aiProgress.total}
                aria-valuenow={aiProgress.current}
              >
                <span style={{ width: `${aiPercent}%` }} />
              </div>
            ) : aiRunning ? (
              <div className="task-working" role="progressbar" aria-label="AI 自动分类进度" />
            ) : null}
          </section>
          <section className="simple-task" aria-label="扫描文字作品">
            <div className="simple-task-heading">
              <h2>扫描文字作品</h2>
              <span className="task-badge">
                {textScanStatus === 'running'
                  ? '进行中'
                  : textScanStatus === 'completed'
                    ? '已完成'
                    : textScanStatus === 'stopped'
                      ? '已停止'
                      : '未开始'}
              </span>
            </div>
            <div className="simple-task-body">
              <div className="simple-task-copy">
                <p>批量读取已保存作品详情，识别并标记文字作品</p>
                {textScanStatus === 'running' && (
                  <span className="task-activity">
                    正在扫描 {textScan?.current ?? 0}/{textScan?.total ?? '…'} 条
                    {textScan && textScan.current > 0 && textScan.total > textScan.current
                      ? `，预计剩余 ${formatRemainingTime(textScan)}`
                      : ''}
                  </span>
                )}
              </div>
              <div className="simple-task-actions">
                <button disabled={!accountId || busy} onClick={() => scanTextWorks('likes')}>
                  <ScanSearch size={15} />
                  扫描喜欢
                </button>
                <button disabled={!accountId || busy} onClick={() => scanTextWorks('favorites')}>
                  <ScanSearch size={15} />
                  扫描收藏
                </button>
                {textScanStatus === 'running' && (
                  <button className="task-text-button" disabled={!accountId} onClick={stopTextScan}>
                    <Square size={15} />
                    停止扫描
                  </button>
                )}
              </div>
            </div>
            {textScanStatus === 'running' && (
              <div className="task-working" role="progressbar" aria-label="扫描文字作品进度" />
            )}
          </section>
        </div>
        <UnlikePanel
          key={accountId ?? 'no-account'}
          accountId={accountId}
          latest={snapshot?.unlike ?? null}
          busy={operationBusy}
          resumeDisabled={busy}
          perform={perform}
          recovery={snapshot?.recovery}
          accessChecks={snapshot?.accessChecks}
          login={login}
        />
        <details className="task-tools">
          <summary>诊断与运行记录</summary>
          <div className="task-tools-content">
            <RuntimeHistory accountId={accountId} revision={snapshot} />
          </div>
        </details>
      </div>
    </div>
  )
}
