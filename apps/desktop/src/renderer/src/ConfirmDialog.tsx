import { useEffect, useRef, type ReactNode } from 'react'

export function ConfirmDialog({
  title,
  children,
  busy,
  confirm,
  cancel,
  confirmLabel = '确认删除本地条目',
  danger = true
}: {
  title: string
  children: ReactNode
  busy: boolean
  confirm: () => void
  cancel: () => void
  confirmLabel?: string
  danger?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  return (
    <dialog
      ref={ref}
      className="modal confirm-dialog"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) cancel()
      }}
    >
      <h2>{title}</h2>
      {children}
      <div className="panel-actions">
        <button autoFocus disabled={busy} onClick={cancel}>
          取消
        </button>
        <button className={danger ? 'danger-button' : 'primary'} disabled={busy} onClick={confirm}>
          {busy ? '正在处理…' : confirmLabel}
        </button>
      </div>
    </dialog>
  )
}
