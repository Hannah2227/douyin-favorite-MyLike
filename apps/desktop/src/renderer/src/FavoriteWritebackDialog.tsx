import { useEffect, useRef, useState } from 'react'
import { FolderHeart, Star, X } from 'lucide-react'
import type { FavoriteFolder } from '../../shared/contracts'
import { call, type Perform } from './api'
import './favorite-dialog.css'

export function FavoriteWritebackDialog({
  accountId,
  folders,
  pendingWrites,
  busy,
  perform,
  close,
  notice
}: {
  accountId: string
  folders: FavoriteFolder[]
  pendingWrites: number
  busy: boolean
  perform: Perform
  close: () => void
  notice?: (message: string) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [selectedFolders, setSelectedFolders] = useState<string[]>([])
  const [includeDefault, setIncludeDefault] = useState(false)
  const changedFolders = folders.filter(
    (folder) =>
      folder.localOnly || folder.localCount !== folder.remoteCount || (folder.pendingWrites ?? 0) > 0
  )
  const visibleSelected = selectedFolders.filter((id) => changedFolders.some((folder) => folder.id === id))
  const selectedCount = visibleSelected.length + Number(includeDefault)

  useEffect(() => {
    dialog.current?.showModal()
    return () => {
      if (dialog.current?.open) dialog.current.close()
    }
  }, [])

  const submit = () => {
    if (!selectedCount || busy) return
    const folderIds = [...visibleSelected]
    close()
    void perform('写回云端收藏夹', async () => {
      const result = await call(
        window.mylike.invoke('favoriteSyncToCloud', {
          accountId,
          folderIds,
          includeDefault
        })
      )
      notice?.(
        [
          `写回完成：已写回 ${result.synced} 项`,
          result.skipped ? `跳过 ${result.skipped} 项不可见作品` : '',
          `仍有 ${result.remaining} 项待写回。`
        ]
          .filter(Boolean)
          .join('，')
      )
    })
  }

  return (
    <dialog
      ref={dialog}
      className="favorite-dialog favorite-writeback-dialog"
      aria-labelledby="favorite-writeback-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) close()
      }}
    >
      <header className="favorite-dialog-heading">
        <h2 id="favorite-writeback-title">选择写回范围</h2>
        <button
          type="button"
          className="favorite-close"
          aria-label="关闭写回范围"
          disabled={busy}
          onClick={close}
        >
          <X size={18} />
        </button>
      </header>
      <p className="favorite-writeback-note">
        当前有 {pendingWrites}{' '}
        项本地改动待写回。只显示本地与云端数量不一致或仍有待写回改动的收藏夹；云端数量为最近一次同步结果。
        只处理下方所选范围，未选择的改动会保留。已同步收藏夹会核对作品，并将本地有、云端缺少的作品加入写回；这项核对本身不会删除云端作品。
        写回只把本机新增内容写到云端，不会把云端的新增或删除带回本机；要获取云端变化请使用“同步收藏夹”。必要的默认收藏状态会一并写回。
      </p>
      <div className="favorite-writeback-selection">
        <button
          type="button"
          disabled={busy || (!changedFolders.length && !pendingWrites)}
          onClick={() => {
            setSelectedFolders(changedFolders.map((folder) => folder.id))
            setIncludeDefault(true)
          }}
        >
          全选
        </button>
        <button
          type="button"
          disabled={busy || (!changedFolders.length && !includeDefault)}
          onClick={() => {
            setSelectedFolders([])
            setIncludeDefault(false)
          }}
        >
          全不选
        </button>
      </div>
      <div className="favorite-folder-list" aria-label="可写回的收藏夹">
        <label className="favorite-folder-row favorite-writeback-row">
          <span className="favorite-folder-cover">
            <Star size={20} />
          </span>
          <span className="favorite-folder-name">
            <span>默认收藏列表</span>
            <small>尚未同步的默认收藏作品</small>
          </span>
          <input
            type="checkbox"
            aria-label="写回默认收藏列表"
            checked={includeDefault}
            disabled={busy}
            onChange={(event) => setIncludeDefault(event.target.checked)}
          />
        </label>
        {changedFolders.length ? (
          changedFolders.map((folder) => (
            <label className="favorite-folder-row favorite-writeback-row" key={folder.id}>
              <span className="favorite-folder-cover">
                {folder.coverUrl ? <img src={folder.coverUrl} alt="" /> : <FolderHeart size={20} />}
              </span>
              <span className="favorite-folder-name">
                <span>{folder.title}</span>
                <small>
                  {folder.localOnly || !folder.remoteId
                    ? `仅本地 · ${folder.localCount} 条`
                    : `本地 ${folder.localCount} 条 · 最近云端 ${folder.remoteCount} 条${
                        folder.localCount === folder.remoteCount ? ' · 有本地改动' : ''
                      }`}
                </small>
              </span>
              <input
                type="checkbox"
                aria-label={`写回收藏夹 ${folder.title}`}
                checked={selectedFolders.includes(folder.id)}
                disabled={busy}
                onChange={(event) =>
                  setSelectedFolders((selected) =>
                    event.target.checked
                      ? [...selected, folder.id]
                      : selected.filter((id) => id !== folder.id)
                  )
                }
              />
            </label>
          ))
        ) : (
          <p className="favorite-writeback-empty">本地与云端收藏夹内容一致，暂无可写回的收藏夹。</p>
        )}
      </div>
      <button
        type="button"
        className="favorite-save"
        disabled={busy || selectedCount === 0}
        onClick={() => void submit()}
      >
        写回所选范围（{selectedCount}）
      </button>
    </dialog>
  )
}
