import { FavoritesPanel, useFavoriteFolders } from './FavoritesPanel'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, LoaderCircle, X } from 'lucide-react'
import type { Diagnostics, ImportPreview, Snapshot, Work } from '../../shared/contracts'
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
  const [history, setHistory] = useState<{ time: string; text: string }[]>([])
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null)
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ accountId: string; ids: string[] } | null>(null)
  const [unlikeTarget, setUnlikeTarget] = useState<{
    accountId: string
    ids: string[]
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
    void perform('启动收藏同步', () => call(window.mylike.invoke('favoritesStart', { accountId })))
  const collecting =
    snapshot?.collection?.status === 'running' ||
    !!snapshot?.collectionActivity ||
    snapshot?.favorites?.status === 'running' ||
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
  const record = (text: string) =>
    setHistory((old) =>
      [
        { time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), text },
        ...old
      ].slice(0, 30)
    )
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
      record(message)
    } finally {
      setOperation('')
    }
  }
  const login = () =>
    accountId &&
    void perform('打开抖音窗口', async () => {
      await call(window.mylike.invoke('login', { accountId }))
      setNotice('在弹出的抖音窗口完成登录，然后点击“核验登录”。')
    })
  const probe = () =>
    accountId &&
    void perform('核验登录', async () => {
      const value = await call(window.mylike.invoke('probe', { accountId }))
      setNotice(`已核验：${value.nickname || value.name}`)
      record(`身份核验成功：${value.nickname || value.name}`)
    })
  const collect = (resume: boolean) =>
    accountId &&
    void perform('读取喜欢列表', async () => {
      const result = await call(window.mylike.invoke('collectPage', { accountId, continue: resume }))
      const text = `本页接收 ${result.received} 条，新增 ${result.added} 条。${result.hasMore ? '还有更多内容，可继续验证下一页。' : '接口返回已到末尾。'}`
      setNotice(text)
      record(text)
    })
  const startCollection = (mode: 'update' | 'full' = 'update') =>
    accountId &&
    void perform('启动采集', async () => {
      await call(window.mylike.invoke('collectionStart', { accountId, mode }))
      setNotice('采集已启动，可在“连接与任务”查看进度或暂停；期间可以浏览和播放。')
    })
  const back = presentation.exit
  const startQueue = (mode: 'sequence' | 'shuffle', work?: Work) => {
    presentation.rememberFocus()
    void perform('准备播放队列', () =>
      playback.start(
        !work && library.selection.ids.size
          ? { type: 'ids', ids: [...library.selection.ids], sort: library.sort }
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
  const importFile = () =>
    accountId &&
    void perform('预览导入文件', async () => {
      setImportPreview(await call(window.mylike.invoke('importLibrary', { accountId })))
    })
  const exportFile = (all = false) =>
    accountId &&
    void perform('导出元数据', async () => {
      const result = await call(
        window.mylike.invoke('exportLibrary', {
          accountId,
          source: all
            ? {
                type: 'filter',
                filter: { search: '', mediaType: 'all', year: null, month: null, sort: 'published' }
              }
            : library.selection.ids.size
              ? { type: 'ids', ids: [...library.selection.ids], sort: library.sort }
              : { type: 'filter', filter: library.filter }
        })
      )
      if (result) setNotice(`已导出 ${result.count} 条元数据：${result.fileName}`)
    })
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
              <button className="primary" disabled={!accountId || busy} onClick={() => startCollection()}>
                {busy ? <LoaderCircle className="spin" size={16} /> : <ArrowDownToLine size={16} />}
                {operation ||
                  (collecting
                    ? '正在采集'
                    : snapshot?.collection && snapshot.collection.status !== 'completed'
                      ? '继续采集'
                      : '自动采集')}
              </button>
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
            compact
            accountId={accountId}
            task={snapshot?.favorites ?? null}
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
            exportFile={() => exportFile()}
            unlike={() => {
              setError('')
              if (accountId) setUnlikeTarget({ accountId, ids: [...library.selection.ids], mode: 'batch' })
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
            collect={collect}
            startCollection={startCollection}
            history={history}
            setError={setError}
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
            importFile={importFile}
            exportAll={() => exportFile(true)}
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
            exit={back}
            preferences={preferences.value}
            updatePreferences={preferences.update}
            operationError={error}
            clearError={() => setError('')}
            login={login}
            unlikeBusy={!!operation || unliking}
            unlike={() => {
              setError('')
              if (playback.view)
                setUnlikeTarget({
                  accountId: playback.view.queue.accountId,
                  ids: [playback.view.queue.work.id],
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
          title="取消抖音点赞"
          busy={!!operation}
          cancel={() => setUnlikeTarget(null)}
          confirmLabel="确认取消抖音点赞"
          confirm={() =>
            void perform('启动取消点赞任务', async () => {
              await call(
                window.mylike.invoke('unlikeStart', {
                  accountId: unlikeTarget.accountId,
                  workIds: unlikeTarget.ids,
                  mode: unlikeTarget.mode
                })
              )
              library.selection.clear()
              setUnlikeTarget(null)
              if (!playback.view) setTab('tasks')
            })
          }
        >
          <p>
            将以“{account?.name}”（抖音昵称：{account?.nickname || '尚未核验'}）取消 {unlikeTarget.ids.length}{' '}
            条作品的抖音点赞。
          </p>
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
      {importPreview && (
        <ConfirmDialog
          title="合并导入元数据"
          busy={!!operation}
          danger={false}
          confirmLabel="确认合并导入"
          cancel={() =>
            void perform('取消导入', async () => {
              await call(window.mylike.invoke('importCancel', { token: importPreview.token }))
              setImportPreview(null)
            })
          }
          confirm={() =>
            void perform('合并导入元数据', async () => {
              const result = await call(
                window.mylike.invoke('importCommit', {
                  accountId: importPreview.accountId,
                  token: importPreview.token
                })
              )
              setImportPreview(null)
              setNotice(`已导入 ${result.added} 条新记录，保留现有 ${result.received - result.added} 条。`)
            })
          }
        >
          <p>
            将“{importPreview.fileName}”合并到“{importPreview.accountName}”。
          </p>
          <p>
            共 {importPreview.total} 条，新增 {importPreview.newCount} 条，已存在{' '}
            {importPreview.existingCount} 条，文件内重复 {importPreview.duplicates} 条。
          </p>
          <p>合并前自动备份。现有元数据优先，不修改账号绑定或采集断点；导入内容不代表当前账号已点赞。</p>
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
