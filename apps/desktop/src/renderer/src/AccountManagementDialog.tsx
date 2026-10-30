import { useState } from 'react'
import type { Account } from '../../shared/contracts'
import { accountLabel } from '../../shared/account-label'
import { ConfirmDialog } from './ConfirmDialog'
import { call, type Perform } from './api'

export function AccountManagementDialog({
  account,
  mode,
  busy,
  perform,
  close,
  beforeRemove = async () => {}
}: {
  account: Account
  mode: 'rename' | 'remove'
  busy: boolean
  perform: Perform
  close: () => void
  beforeRemove?: () => Promise<void>
}) {
  const [name, setName] = useState(account.name)
  const [error, setError] = useState('')
  const rename = mode === 'rename'
  return (
    <ConfirmDialog
      title={rename ? '修改账号名称' : '删除账号及本地数据'}
      danger={!rename}
      busy={busy}
      cancel={close}
      confirmLabel={rename ? '保存名称' : '确认删除账号'}
      confirm={() => {
        if (rename && !name.trim()) {
          setError('请输入本地名称。')
          return
        }
        void perform(rename ? '保存账号名称' : '删除账号数据', async () => {
          try {
            if (!rename) await beforeRemove()
            await call(
              window.mylike.invoke(rename ? 'renameAccount' : 'removeAccount', {
                accountId: account.id,
                ...(rename ? { name } : {})
              })
            )
            close()
          } catch (error) {
            setError(error instanceof Error ? error.message : '账号操作未完成。')
            throw error
          }
        })
      }}
    >
      <p className="account-dialog-name">{accountLabel(account)}</p>
      {rename ? (
        <label className="account-dialog-input">
          本地自定义名称
          <input
            aria-label="本地账号名称"
            autoFocus
            value={name}
            maxLength={40}
            onChange={(event) => setName(event.target.value)}
          />
          <small>只修改本地名称，抖音昵称保持不变。</small>
        </label>
      ) : (
        <p>
          将清除这个账号的本地内容、任务、播放记录、登录态和缓存，并从应用历史备份中清除该账号记录。其他账号的数据保留，不修改抖音上的点赞或收藏。此操作无法通过应用内备份恢复。
        </p>
      )}
      {error && (
        <p role="alert" className="task-error">
          {error}
        </p>
      )}
    </ConfirmDialog>
  )
}
