import { CollectionActions } from './CollectionActions'
import { FavoritesPanel, useFavoriteFolders } from './FavoritesPanel'
import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { Diagnostics, Snapshot, Work } from '../../shared/contracts'
import { Player } from './Player'

import { call, type Tab } from './api'
import { Sidebar } from './Sidebar'
import { LibraryView } from './LibraryView'
import { LibrarySearch } from './LibrarySearch'
import { ConnectionPanel } from './ConnectionPanel'
import { SettingsPanel } from './SettingsPanel'
import { AccountDialog } from './AccountDialog'
import { ConfirmDialog } from './ConfirmDialog'
import { useLibrary } from './useLibrary'
import { usePlayback } from './usePlayback'
import { usePlayerPresentation } from './usePlayerPresentation'
import { usePlaybackPreferences } from './usePlaybackPreferences'
import { Dashboard } from './Dashboard'
import { useOverview } from './useOverview'
import { HelpPage } from './HelpPage'

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [tab, setTab] = useState<Tab>('library')
  const [folderId, setFolderId] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [operation, setOperation] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)
  const [name, setName] = useState('')
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ accountId: string; ids: string[] } | null>(null)
  const [unlikeTarget, setUnlikeTarget] = useState<{
    accountId: string
    ids: string[]
    source: 'likes' | 'favorites'
    mode: 'single' | 'batch'
  } | null>(null)
  const snapshotSequence = useRef(0)
  const dataKey = useRef('')
  const startupApplied = useRef(false)
  const accountId = snapshot?.activeAccountId ?? null
  const account = snapshot?.accounts.find((a) => a.id === accountId)
  const playback = usePlayback(accountId, setError, () => void refresh().catch((e) => setError(e.message)))
  const presentation = usePlayerPresentation(playback)
  const overview = useOverview(
    accountId,
    revision,
    tab === 'dashboard' && (!playback.view || presentation.leaving)
  )
  const preferences = usePlaybackPreferences(snapshot?.playbackPreferences, setError)
  const likesLibrary = useLibrary(
    accountId,
    (!playback.view || presentation.leaving) && tab === 'library',
    revision,
    setError
  )
  const favoritesLibrary = useLibrary(
    accountId,
    (!playback.view || presentation.leaving) && tab === 'favorites',
    revision,
    setError,
    { source: 'favorites', folderId }
  )
  const favoriteFolders = useFavoriteFolders(accountId, revision)
  const library = tab === 'favorites' ? favoritesLibrary : likesLibrary
  useEffect(() => setFolderId(null), [accountId])
  useEffect(() => {
    if (
      favoriteFolders.loaded &&
      folderId &&
      !favoriteFolders.folders.some((folder) => folder.id === folderId)
    )
      setFolderId(null)
  }, [favoriteFolders.loaded, favoriteFolders.folders, folderId])
  const startFavorites = () =>
    accountId &&
    void perform('向下采集', () =>
      call(window.mylike.invoke('collectionAction', { accountId, source: 'favorites', action: 'down' }))
    )
  const collecting =
    snapshot?.collection?.status === 'running' ||
    !!snapshot?.collectionActivity ||
    snapshot?.favorites?.status === 'running' ||
    snapshot?.favoritesUpdate?.status === 'running' ||
    !!snapshot?.favoritesActivity
  const unliking = snapshot?.unlike?.status === 'running'
  const busy = !!operation || !!snapshot?.busy || collecting || unliking
  const refresh = useCallback(async () => {
    const seq = ++snapshotSequence.current
    const next = await call(window.mylike.invoke('snapshot', {}))
    if (seq === snapshotSequence.current) {
      setSnapshot(next)
      const key = `${next.activeAccountId}:${next.libraryRevision}`
      if (dataKey.current !== key) {
        dataKey.current = key
        setRevision((n) => n + 1)
      }
    }
  }, [])
  useEffect(() => {
    void refresh().catch((e) => setError(e.message))
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = window.mylike.onChanged(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void refresh().catch((e) => setError(e.message)), 100)
    })
    return () => {
      off()
      clearTimeout(timer)
    }
  }, [refresh])
  useEffect(() => {
    document.documentElement.dataset.theme = snapshot?.theme ?? 'dark'
  }, [snapshot?.theme])
  useEffect(() => {
    document.documentElement.dataset.motion = snapshot?.appPreferences.motion ?? 'system'
    if (snapshot && !startupApplied.current) {
      startupApplied.current = true
      setTab(snapshot.appPreferences.startupPage)
    }
  }, [snapshot?.appPreferences])
  useEffect(() => {
    void call(
      window.mylike.invoke('windowPresentation', {
        player: !!playback.view && !presentation.leaving
      })
    ).catch((error) => setError(error.message))
  }, [!!playback.view, presentation.leaving])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 8000)
    return () => clearTimeout(timer)
  }, [notice])
  async function perform(label: string, fn: () => Promise<unknown>) {
    setOperation(label)
    setError('')
    setNotice('')
    try {
      await fn()
      await refresh()
    } catch (e) {
      const message = e instanceof Error ? e.message : '操作未完成'
      setError(message)
    } finally {
      setOperation('')
    }
  }
  const login = () =>
    accountId &&
    void perform('打开抖音窗口', async () => {
      await call(window.mylike.invoke('login', { accountId }))
      setNotice('完成登录后，抖音窗口会自动收起。')
    })
  const probe = () => {
    if (!accountId) return
    setTab('tasks')
    void perform('核验状态', async () => {
      await call(window.mylike.invoke('checkHealth', { accountId }))
    })
  }
  const startCollection = () =>
    accountId &&
    void perform('向下采集', () =>
      call(window.mylike.invoke('collectionAction', { accountId, source: 'likes', action: 'down' }))
    )
  const back = presentation.exit
  const startQueue = (mode: 'sequence' | 'shuffle', work?: Work) => {
    presentation.rememberFocus()
    void perform('准备播放队列', () =>
      playback.start(
        !work && library.selection.ids.size
          ? {
              type: 'ids',
              ids: [...library.selection.ids],
              sort: library.sort,
              source: tab === 'favorites' ? 'favorites' : 'likes'
            }
          : { type: 'filter', filter: library.filter },
        mode,
        work?.id
      )
    )
  }
  const startFromDashboard = (work?: Work) => {
    presentation.rememberFocus()
    void perform('准备播放队列', () =>
      playback.start(
        {
          type: 'filter',
          filter: { search: '', mediaType: 'all', year: null, month: null, sort: 'published', source: 'all' }
        },
        work ? 'sequence' : 'shuffle',
        work?.id
      )
    )
  }
  const resumePlayback = () => {
    presentation.rememberFocus()
    if (snapshot?.playback) void perform('恢复播放', () => playback.resume(snapshot.playback!))
  }
  return (
    <div
      className={`app-shell${playback.view && !presentation.leaving ? ' player-mode sidebar-collapsed' : ''}`}
    >
      <div className="sidebar-region" inert={!!playback.view} aria-hidden={!!playback.view}>
        <Sidebar
          snapshot={snapshot}
          tab={tab}
          setTab={setTab}
          back={back}
          busy={busy}
          account={account}
          setAdding={setAdding}
          perform={perform}
        />
      </div>
      <main
        className={`main-area${playback.view && !presentation.leaving ? ' is-obscured' : ''}`}
        inert={!!playback.view}
        aria-hidden={!!playback.view}
      >
        <div className="window-bar">
          <span className="window-drag-space" />
        </div>
        <header className="page-header">
          <h1>
            {
              {
                dashboard: '仪表盘',
                library: '喜欢的内容',
                favorites: '收藏的内容',
                tasks: '连接与任务',
                settings: '应用设置',
                faq: '常见问题',
                guide: '使用教程'
              }[tab]
            }
          </h1>
          {(tab === 'library' || tab === 'favorites') && (
            <LibrarySearch value={library.search} change={library.setSearch} />
          )}
          {tab === 'library' && (
            <div className="header-actions">
              <CollectionActions
                snapshot={snapshot}
                accountId={accountId}
                source="likes"
                busy={busy}
                perform={perform}
              />
            </div>
          )}
        </header>
        {(error || notice) && (
          <div className={`notice ${error ? 'error' : 'success toast'}`} role={error ? 'alert' : 'status'}>
            <span>{error || notice}</span>
            <button
              aria-label="关闭提示"
              onClick={() => {
                setError('')
                setNotice('')
              }}
            >
              <X size={15} />
            </button>
          </div>
        )}
        {tab === 'dashboard' && (
          <Dashboard
            account={account}
            snapshot={snapshot}
            overview={overview}
            busy={!!operation}
            browse={() => setTab('library')}
            add={() => setAdding(true)}
            play={startFromDashboard}
            resume={resumePlayback}
          />
        )}
        {(tab === 'faq' || tab === 'guide') && <HelpPage kind={tab} />}
        {tab === 'favorites' && (
          <FavoritesPanel
            snapshot={snapshot}
            compact
            accountId={accountId}
            task={snapshot?.favorites ?? null}
            recovery={snapshot?.recovery}
            accessChecks={snapshot?.accessChecks}
            login={login}
            updateTask={snapshot?.favoritesUpdate ?? null}
            busy={
              !!operation ||
              !!snapshot?.busy ||
              (collecting && snapshot?.favorites?.status !== 'running') ||
              !!unliking
            }
            perform={perform}
            start={startFavorites}
            folders={favoriteFolders.folders}
            error={favoriteFolders.error}
            folderId={folderId}
            setFolderId={setFolderId}
          />
        )}
        {(tab === 'library' || tab === 'favorites') && (
          <LibraryView
            key={tab}
            readOnly={tab === 'favorites'}
            library={library}
            account={account}
            busy={!!operation}
            mutationBusy={!!operation || unliking}
            collection={{
              start: tab === 'favorites' ? startFavorites : () => startCollection(),
              running:
                tab === 'favorites'
                  ? snapshot?.favorites?.status === 'running' || !!snapshot?.favoritesActivity
                  : snapshot?.collection?.status === 'running' || !!snapshot?.collectionActivity,
              busy: busy || !!snapshot?.authentication
            }}
            play={(work) => startQueue('sequence', work)}
            playRange={startQueue}
            resume={snapshot?.playback && !snapshot.playback.completed ? snapshot.playback : null}
            continuePlayback={resumePlayback}
            dismissPlayback={() =>
              snapshot?.playback &&
              void perform('结束上次播放', () =>
                call(
                  window.mylike.invoke('queueDismiss', {
                    accountId: snapshot.playback!.accountId,
                    queueId: snapshot.playback!.queueId,
                    revision: snapshot.playback!.revision
                  })
                )
              )
            }
            login={login}
            setAdding={setAdding}
            selectAll={() => void perform('选择筛选结果', library.selection.all)}
            unlike={() => {
              setError('')
              if (accountId)
                setUnlikeTarget({
                  accountId,
                  ids: [...library.selection.ids],
                  mode: 'batch',
                  source: tab === 'favorites' ? 'favorites' : 'likes'
                })
            }}
            remove={() => {
              setError('')
              if (accountId) setDeleteTarget({ accountId, ids: [...library.selection.ids] })
            }}
          />
        )}
        {tab === 'tasks' && (
          <ConnectionPanel
            operationBusy={!!operation}
            snapshot={snapshot}
            accountId={accountId}
            busy={busy}
            login={login}
            probe={probe}
            perform={perform}
          />
        )}
        {tab === 'settings' && (
          <SettingsPanel
            snapshot={snapshot}
            diagnostics={diagnostics}
            setDiagnostics={setDiagnostics}
            perform={perform}
            preferences={preferences.value}
            updatePreferences={preferences.update}
            account={account}
            busy={!!operation}
            login={login}
            probe={probe}
            notice={setNotice}
          />
        )}
      </main>
      <div
        ref={presentation.frame}
        className={`player-shell${playback.view && !presentation.leaving ? ' is-active' : ''}`}
        inert={!playback.view || presentation.leaving}
        aria-hidden={!playback.view || presentation.leaving}
      >
        {playback.view && (
          <Player
            key={playback.key}
            playback={playback}
            fullscreenRoot={presentation.frame}
            fullscreenActive={presentation.fullscreen}
            clean={presentation.clean}
            setClean={presentation.setClean}
            exit={back}
            preferences={preferences.value}
            updatePreferences={preferences.update}
            operationError={error}
            clearError={() => setError('')}
            login={login}
            unlikeBusy={!!operation || unliking}
            libraryRevision={snapshot?.libraryRevision ?? 0}
            unlike={() => {
              setError('')
              if (playback.view)
                setUnlikeTarget({
                  accountId: playback.view.queue.accountId,
                  ids: [playback.view.queue.work.id],
                  source: playback.view.queue.source === 'favorites' ? 'favorites' : 'likes',
                  mode: 'single'
                })
            }}
            queueOpen={queueOpen}
            setQueueOpen={setQueueOpen}
          />
        )}
      </div>
      {adding && (
        <AccountDialog
          busy={busy}
          name={name}
          setName={setName}
          setAdding={setAdding}
          setNotice={setNotice}
          perform={perform}
        />
      )}
      {unlikeTarget && (
        <ConfirmDialog
          title={unlikeTarget.source === 'favorites' ? '取消抖音收藏' : '取消抖音点赞'}
          busy={!!operation}
          cancel={() => setUnlikeTarget(null)}
          confirmLabel={unlikeTarget.source === 'favorites' ? '确认取消抖音收藏' : '确认取消抖音点赞'}
          confirm={() =>
            void perform(
              unlikeTarget.source === 'favorites' ? '启动取消收藏任务' : '启动取消点赞任务',
              async () => {
                await call(
                  window.mylike.invoke('unlikeStart', {
                    accountId: unlikeTarget.accountId,
                    workIds: unlikeTarget.ids,
                    source: unlikeTarget.source,
                    mode: unlikeTarget.mode
                  })
                )
                library.selection.clear()
                setUnlikeTarget(null)
                if (!playback.view) setTab('tasks')
              }
            )
          }
        >
          <p>
            将以“{account?.name}”（抖音昵称：{account?.nickname || '尚未核验'}）取消 {unlikeTarget.ids.length}{' '}
            条作品的抖音{unlikeTarget.source === 'favorites' ? '收藏' : '点赞'}。
          </p>
          {unlikeTarget.source === 'favorites' && <p>取消后会从默认收藏及所有收藏夹中移除，喜欢列表保留。</p>}
          <p>
            这会修改抖音账号。每条成功后移除对应本地条目；未知结果保留条目。采集将先暂停，一次最多 1000
            条，任务详情可停止后续未发送项。
          </p>
          {error && (
            <p className="task-error" role="alert">
              {error}
            </p>
          )}
        </ConfirmDialog>
      )}
      {deleteTarget && (
        <ConfirmDialog
          title="删除本地条目"
          busy={!!operation}
          cancel={() => setDeleteTarget(null)}
          confirm={() =>
            void perform('删除本地条目', async () => {
              const result = await call(
                window.mylike.invoke('deleteLocal', {
                  accountId: deleteTarget.accountId,
                  workIds: deleteTarget.ids
                })
              )
              library.selection.clear()
              setDeleteTarget(null)
              setNotice(`已删除 ${result.removed} 条本地记录。`)
            })
          }
        >
          <p>
            将从“{account?.nickname || account?.name}”的本地列表移除 {deleteTarget.ids.length}{' '}
            条记录，抖音点赞保持原样。再次采集到这些作品时会重新收录。
          </p>
          {collecting && <p>采集仍在进行，条目可能再次被收录。</p>}
          {error && (
            <p className="task-error" role="alert">
              {error}
            </p>
          )}
        </ConfirmDialog>
      )}
    </div>
  )
}
