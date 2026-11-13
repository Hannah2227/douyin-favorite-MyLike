import { useEffect, useRef, useState, type FormEvent } from 'react'
import { FolderHeart, LockKeyhole, Pencil, PlusCircle, Trash2, X } from 'lucide-react'
import type { FavoriteFolder } from '../../shared/contracts'
import { ConfirmDialog } from './ConfirmDialog'
import { call, type Perform } from './api'
import './favorite-dialog.css'

export function LocalFoldersDialog({
  accountId,
  folders,
  busy,
  perform,
  close,
  notice
}: {
  accountId: string
  folders: FavoriteFolder[]
  busy: boolean
  perform: Perform
  close: () => void
  notice: (message: string) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<FavoriteFolder | null>(null)
  const [name, setName] = useState('')
  const [privateFolder, setPrivateFolder] = useState(true)
  const managedFolders = folders.filter((folder) => folder.managedLocally)

  useEffect(() => {
    dialog.current?.showModal()
    return () => {
      if (dialog.current?.open) dialog.current.close()
    }
  }, [])

  const resetForm = () => {
    setEditingId(null)
    setName('')
    setPrivateFolder(true)
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    const title = name.trim()
    if (!title) return
    const editing = editingId !== null
    const succeeded = await perform(editing ? '改名本地收藏夹' : '新建本地收藏夹', async () => {
      await call(
        window.mylike.invoke(
          editing ? 'favoriteFolderEditLocal' : 'favoriteFolderCreateLocal',
          editing ? { accountId, folderId: editingId!, title } : { accountId, title, private: privateFolder }
        )
      )
    })
    if (!succeeded) return
    notice(editing ? '收藏夹名称已更新；已写回云端的收藏夹会同步到云端。' : '本地收藏夹已创建。')
    resetForm()
  }
  const remove = async () => {
    if (!deleteTarget) return
    const target = deleteTarget
    const succeeded = await perform('删除本地收藏夹', async () => {
      await call(window.mylike.invoke('favoriteFolderDeleteLocal', { accountId, folderId: target.id }))
    })
    if (!succeeded) return
    setDeleteTarget(null)
    if (editingId === target.id) resetForm()
    notice(
      `已删除本地收藏夹“${target.title}”；其中 ${target.localCount} 条夹内关联已移除，作品仍保留在默认收藏。云端收藏夹未删除。`
    )
  }

  return (
    <>
      <dialog
        ref={dialog}
        className="favorite-dialog local-folders-dialog"
        aria-labelledby="local-folders-title"
        onCancel={(event) => {
          event.preventDefault()
          if (!busy) close()
        }}
      >
        <header className="favorite-dialog-heading">
          <h2 id="local-folders-title">管理本地收藏夹</h2>
          <button
            type="button"
            className="favorite-create-trigger"
            disabled={busy}
            onClick={() => {
              setEditingId(null)
              setName('')
              setPrivateFolder(true)
            }}
          >
            <PlusCircle size={16} />
            新建
          </button>
          <button
            type="button"
            className="favorite-close"
            aria-label="关闭本地收藏夹管理"
            disabled={busy}
            onClick={close}
          >
            <X size={18} />
          </button>
        </header>
        <p className="local-folders-note">
          仅显示本地创建的收藏夹。新建可在开启写回后手动同步；已写回云端的收藏夹改名会同步到云端，删除只在本机隐藏，云端内容不变。
        </p>
        <form className="favorite-create-form" onSubmit={(event) => void save(event)}>
          <label htmlFor="local-folder-name">{editingId ? '修改名称' : '新收藏夹名称'}</label>
          <input
            id="local-folder-name"
            aria-label={editingId ? '修改本地收藏夹名称' : '新本地收藏夹名称'}
            placeholder="收藏夹名称"
            maxLength={30}
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
          {editingId === null && (
            <label className="local-folder-private">
              <input
                type="checkbox"
                checked={privateFolder}
                disabled={busy}
                onChange={(event) => setPrivateFolder(event.target.checked)}
              />
              设为私密
            </label>
          )}
          <div className="local-folder-form-actions">
            {editingId !== null && (
              <button type="button" disabled={busy} onClick={resetForm}>
                取消改名
              </button>
            )}
            <button type="submit" disabled={busy || !name.trim()}>
              {editingId ? '保存名称' : '创建本地收藏夹'}
            </button>
          </div>
        </form>
        <div className="favorite-folder-list" aria-label="本地创建的收藏夹">
          {managedFolders.length ? (
            managedFolders.map((folder) => (
              <div className="favorite-folder-row local-folder-row" key={folder.id}>
                <span className="favorite-folder-cover">
                  <FolderHeart size={22} />
                </span>
                <span className="favorite-folder-name" title={folder.title}>
                  <span>{folder.title}</span>
                  {folder.private && <LockKeyhole size={12} aria-label="私密收藏夹" />}
                  <small>
                    {folder.localCount} 条{folder.localOnly ? ' · 仅本地' : ' · 已关联云端'}
                  </small>
                </span>
                <button
                  type="button"
                  aria-label={`编辑 ${folder.title}`}
                  title="本地改名"
                  disabled={busy}
                  onClick={() => {
                    setEditingId(folder.id)
                    setName(folder.title)
                  }}
                >
                  <Pencil size={15} />
                </button>
                <button
                  type="button"
                  className="danger-button"
                  aria-label={`删除 ${folder.title}`}
                  title="删除本地收藏夹"
                  disabled={busy}
                  onClick={() => setDeleteTarget(folder)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))
          ) : (
            <p className="local-folders-empty">还没有本地创建的收藏夹。</p>
          )}
        </div>
      </dialog>
      {deleteTarget && (
        <ConfirmDialog
          title="删除本地收藏夹"
          busy={busy}
          confirmLabel="确认删除本地收藏夹"
          cancel={() => setDeleteTarget(null)}
          confirm={() => void remove()}
        >
          <p>
            将从本机删除“{deleteTarget.title}”及其 {deleteTarget.localCount} 条夹内关联。
            {deleteTarget.localOnly
              ? '该收藏夹尚未写回云端。'
              : '该收藏夹已关联云端，删除后只在本机隐藏，不会删除云端收藏夹或其作品。'}
          </p>
          <p>
            <strong>作品仍保留在默认收藏列表中，不会取消抖音收藏或点赞。</strong>
          </p>
        </ConfirmDialog>
      )}
    </>
  )
}
