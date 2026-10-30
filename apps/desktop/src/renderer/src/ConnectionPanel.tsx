import './tasks.css'
import type { Snapshot } from '../../shared/contracts'
import { CollectionActions } from './CollectionActions'
import { HealthPanel } from './HealthPanel'
import { UnlikePanel } from './UnlikePanel'
import { RuntimeHistory } from './RuntimeHistory'
import { FavoriteIssues } from './FavoritesPanel'
import type { Perform } from './api'
export function ConnectionPanel({
  snapshot,
  accountId,
  busy,
  operationBusy,
  login,
  probe,
  perform
}: {
  snapshot: Snapshot | null
  accountId: string | null
  busy: boolean
  operationBusy: boolean
  login: () => void
  probe: () => void
  perform: Perform
}) {
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
                      {current
                        ? '本次新增 ' + current.added + ' 条'
                        : source === 'likes'
                          ? '将喜欢的作品收录到本机'
                          : '收录收藏作品，并同步收藏夹分组'}
                    </p>
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
                {running && <div className="task-working" role="progressbar" aria-label={title + '进度'} />}
              </section>
            )
          })}
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
