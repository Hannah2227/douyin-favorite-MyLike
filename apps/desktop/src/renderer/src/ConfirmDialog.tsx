import { useEffect, useRef, type ReactNode } from 'react'

export function ConfirmDialog({
  title,
  children,
  busy,
  confirm,
  cancel,
  confirmDisabled = false,
  dialogClassName = '',
  stickyActions = false,
  open = true,
  confirmLabel = '确认删除本地条目',
  danger = true
}: {
  title: string
  children: ReactNode
  busy: boolean
  confirm: () => void
  cancel: () => void
  confirmDisabled?: boolean
  dialogClassName?: string
  stickyActions?: boolean
  open?: boolean
  confirmLabel?: string
  danger?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (open && dialog && !dialog.open) dialog.showModal()
    else if (!open && dialog?.open) dialog.close()
    return () => {
      if (dialog?.open) dialog.close()
    }
  }, [open])
  return (
    <dialog
      ref={ref}
      className={`modal confirm-dialog ${dialogClassName}`.trim()}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) cancel()
      }}
    >
      <h2>{title}</h2>
      {stickyActions ? <div className="confirm-dialog-scroll">{children}</div> : children}
      <div className={`panel-actions${stickyActions ? ' confirm-dialog-actions' : ''}`}>
        <button autoFocus disabled={busy} onClick={cancel}>
          取消
        </button>
        <button
          className={danger ? 'danger-button' : 'primary'}
          disabled={busy || confirmDisabled}
          onClick={confirm}
        >
          {busy ? '正在处理…' : confirmLabel}
        </button>
      </div>
    </dialog>
  )
}
