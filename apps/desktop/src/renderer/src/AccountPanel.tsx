import { AccountManagementDialog } from './AccountManagementDialog'
import { useEffect, useState } from 'react'
import type { Account } from '../../shared/contracts'
import { call, type Perform } from './api'

export function AccountPanel({
  account,
  busy,
  perform,
  notice
}: {
  account: Account | undefined
  busy: boolean
  perform: Perform
  notice: (message: string) => void
}) {
  const [name, setName] = useState(account?.name ?? ''),
    [confirmRemove, setConfirmRemove] = useState(false)
  useEffect(() => {
    setName(account?.name ?? '')
    setConfirmRemove(false)
  }, [account?.id, account?.name])
  if (!account)
    return (
      <section className="panel">
        <h2>账号管理</h2>
        <p>在左侧添加账号后，可管理名称和登录会话。</p>
      </section>
    )
  return (
    <section className="panel">
      <h2>当前账号</h2>
      <div className="setting-row">
        <span>
          本地名称<small>抖音昵称：{account.nickname || '尚未检查'}</small>
        </span>
        <div className="account-name-editor">
          <input
            aria-label="本地账号名称"
            value={name}
            maxLength={40}
            onChange={(event) => setName(event.target.value)}
          />
          <button
            disabled={busy || !name.trim() || name.trim() === account.name}
            onClick={() =>
              void perform('保存账号名称', async () => {
                await call(window.mylike.invoke('renameAccount', { accountId: account.id, name }))
                notice('本地名称已更新。')
              })
            }
          >
            保存名称
          </button>
        </div>
      </div>
      <p className="muted">
        {account.lastVerifiedAt
          ? `最近检查：${new Date(account.lastVerifiedAt).toLocaleString('zh-CN')}`
          : '尚无最近检查记录；已有本地内容仍可浏览。'}
      </p>
      <div className="panel-actions">
        <button className="danger-button" disabled={busy} onClick={() => setConfirmRemove(true)}>
          删除当前账号
        </button>
      </div>
      {confirmRemove && (
        <AccountManagementDialog
          account={account}
          mode="remove"
          busy={busy}
          perform={perform}
          close={() => setConfirmRemove(false)}
        />
      )}
    </section>
  )
}
