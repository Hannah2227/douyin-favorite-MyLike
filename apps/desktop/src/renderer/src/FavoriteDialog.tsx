import { useEffect, useRef, useState } from 'react'
import { FolderHeart, LoaderCircle, LockKeyhole, PlusCircle, Star, X } from 'lucide-react'
import type { FavoriteEditor, PlaybackScope } from '../../shared/contracts'
import { call, CommandError } from './api'
import './favorite-dialog.css'

export function FavoriteDialog({
  scope,
  close,
  login,
  saved
}: {
  scope: PlaybackScope & { workId: string }
  close: () => void
  login: () => void
  saved: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const mounted = useRef(false),
    pending = useRef(false),
    sequence = useRef(0)
  const [editor, setEditor] = useState<FavoriteEditor | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false)
  const [error, setError] = useState(''),
    [needsReload, setNeedsReload] = useState(false)
  const [creating, setCreating] = useState(false),
    [name, setName] = useState(''),
    [secret, setSecret] = useState(true)

  const reload = async () => {
    if (pending.current) return
    const seq = ++sequence.current
    setLoading(true)
    setError('')
    try {
      const next = await call(window.mylike.invoke('favoriteEditor', scope))
      if (!mounted.current || seq !== sequence.current) return
      setEditor(next)
      setSelected([])
      setNeedsReload(false)
      setCreating(false)
    } catch (error) {
      if (mounted.current && seq === sequence.current) {
        setError(error instanceof Error ? error.message : '收藏夹读取失败，请重试。')
        setNeedsReload(true)
      }
    } finally {
      if (mounted.current && seq === sequence.current) setLoading(false)
    }
  }
  useEffect(() => {
    mounted.current = true
    dialog.current?.showModal()
    void reload()
    return () => {
      mounted.current = false
      sequence.current++
    }
  }, [])
  const save = async () => {
    if (!editor || loading || needsReload || pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await call(
        window.mylike.invoke('favoriteSave', {
          accountId: scope.accountId,
          token: editor.token,
          folderIds: selected
        })
      )
      if (mounted.current) {
        saved()
        close()
      }
    } catch (error) {
      if (mounted.current) {
        setError(error instanceof Error ? error.message : '收藏未完成，请重新读取后核对。')
        setNeedsReload(true)
      }
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const create = async () => {
    if (!editor || !name.trim() || pending.current || needsReload) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      const folder = await call(
        window.mylike.invoke('favoriteCreateFolder', {
          accountId: scope.accountId,
          token: editor.token,
          name: name.trim(),
          private: secret
        })
      )
      if (!mounted.current) return
      setEditor({ ...editor, folders: [folder, ...editor.folders] })
      setSelected((ids) => [...new Set([...ids, folder.id])])
      setName('')
      setCreating(false)
    } catch (error) {
      if (mounted.current) {
        setError(error instanceof Error ? error.message : '新建收藏夹未完成。')
        if (!(error instanceof CommandError && error.code === 'FOLDER_EXISTS')) setNeedsReload(true)
      }
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      className="favorite-dialog"
      aria-labelledby="favorite-dialog-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!pending.current) close()
      }}
    >
      <header className="favorite-dialog-heading">
        <h2 id="favorite-dialog-title">选择收藏夹</h2>
        <button
          type="button"
          className="favorite-create-trigger"
          disabled={loading || busy || needsReload}
          onClick={() => {
            setCreating(!creating)
            setError('')
          }}
        >
          <PlusCircle size={16} />
          新建
        </button>
        <button
          type="button"
          className="favorite-close"
          aria-label="关闭收藏夹选择"
          disabled={busy}
          onClick={close}
          autoFocus
        >
          <X size={18} />
        </button>
      </header>
      {creating && (
        <form
          className="favorite-create-form"
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <input
            aria-label="收藏夹名称"
            placeholder="收藏夹名称"
            maxLength={30}
            value={name}
            disabled={busy || needsReload}
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
          <div>
            <label>
              <input
                type="checkbox"
                checked={secret}
                disabled={busy || needsReload}
                onChange={(event) => setSecret(event.target.checked)}
              />
              设为私密
            </label>
            <button type="submit" disabled={busy || !name.trim() || needsReload}>
              创建
            </button>
          </div>
        </form>
      )}
      {loading ? (
        <div className="favorite-loading" role="status">
          <LoaderCircle size={22} className="spin" />
          正在读取收藏夹…
        </div>
      ) : (
        editor && (
          <div className="favorite-folder-list" aria-label="可选收藏夹" aria-busy={busy}>
            <label className="favorite-folder-row favorite-default" title="收藏的作品都会保留在默认收藏列表">
              <span className="favorite-folder-cover">
                <Star size={24} fill="currentColor" />
              </span>
              <span className="favorite-folder-name">
                默认收藏列表 <small>{editor.localCount}</small>
              </span>
              <input type="checkbox" aria-label="默认收藏列表" checked disabled />
            </label>
            {editor.folders.map((folder) => (
              <label className="favorite-folder-row" key={folder.id}>
                <span className="favorite-folder-cover">
                  {folder.coverUrl ? (
                    <img src={folder.coverUrl} alt="" referrerPolicy="no-referrer" />
                  ) : (
                    <FolderHeart size={24} />
                  )}
                </span>
                <span className="favorite-folder-name" title={folder.title}>
                  <span>{folder.title}</span>
                  {folder.private && <LockKeyhole size={12} aria-label="私密收藏夹" />}
                  <small>{folder.remoteCount}</small>
                </span>
                <input
                  type="checkbox"
                  aria-label={folder.title}
                  checked={selected.includes(folder.id)}
                  disabled={busy || needsReload}
                  onChange={(event) =>
                    setSelected((ids) =>
                      event.target.checked ? [...ids, folder.id] : ids.filter((id) => id !== folder.id)
                    )
                  }
                />
              </label>
            ))}
          </div>
        )
      )}
      {error && (
        <div className="favorite-error" role="alert">
          {error}
        </div>
      )}
      {needsReload && !loading && (
        <div className="favorite-recovery">
          <button disabled={busy} onClick={() => void reload()}>
            重新读取
          </button>
          <button disabled={busy} onClick={login}>
            打开抖音登录 / 验证
          </button>
        </div>
      )}
      <button
        className="favorite-save"
        disabled={loading || busy || !editor || needsReload || creating}
        onClick={() => void save()}
      >
        {busy ? (
          <>
            <LoaderCircle size={17} className="spin" />
            正在保存…
          </>
        ) : (
          '保存'
        )}
      </button>
    </dialog>
  )
}
