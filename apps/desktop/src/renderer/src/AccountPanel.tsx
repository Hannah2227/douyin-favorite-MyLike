import { AccountManagementDialog } from './AccountManagementDialog'
import { useEffect, useState } from 'react'
import type { Account } from '../../shared/contracts'
import { call, type Perform } from './api'
import { ConfirmDialog } from './ConfirmDialog'

export function AccountPanel({
  account,
  busy,
  perform,
  login,
  probe,
  notice
}: {
  account: Account | undefined
  busy: boolean
  perform: Perform
  login: () => void
  probe: () => void
  notice: (message: string) => void
}) {
  const [name, setName] = useState(account?.name ?? ''),
    [confirm, setConfirm] = useState<'logout' | 'remove' | null>(null),
    [error, setError] = useState('')
  useEffect(() => {
    setName(account?.name ?? '')
    setConfirm(null)
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
          本地名称<small>抖音昵称：{account.nickname || '尚未核验'}</small>
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
          ? `最近核验：${new Date(account.lastVerifiedAt).toLocaleString('zh-CN')}`
          : '尚无最近核验记录；已有本地内容仍可浏览。'}
      </p>
      <div className="panel-actions">
        <button disabled={busy} onClick={login}>
          打开抖音登录
        </button>
        <button className="primary verify-login" disabled={busy} onClick={probe}>
          核验登录
        </button>
        <button
          disabled={busy}
          onClick={() => {
            setError('')
            setConfirm('logout')
          }}
        >
          退出当前登录
        </button>
        <button
          className="danger-button"
          disabled={busy}
          onClick={() => {
            setError('')
            setConfirm('remove')
          }}
        >
          删除当前账号
        </button>
      </div>
      {confirm === 'remove' && (
        <AccountManagementDialog
          account={account}
          mode="remove"
          busy={busy}
          perform={perform}
          close={() => setConfirm(null)}
        />
      )}
      {confirm === 'logout' && (
        <ConfirmDialog
          title="退出当前登录"
          busy={busy}
          cancel={() => setConfirm(null)}
          confirmLabel="确认退出登录"
          confirm={() =>
            void perform('清理登录会话', async () => {
              try {
                await call(window.mylike.invoke('logoutAccount', { accountId: account.id }))
                setConfirm(null)
                notice('当前账号登录会话已清理，本地内容保留。')
              } catch (error) {
                setError(error instanceof Error ? error.message : '账号操作未完成。')
                throw error
              }
            })
          }
        >
          <p>
            将停止“{account.name}
            ”的页面请求并关闭抖音窗口，清理其登录会话。本地内容保留，下次连接时需要重新登录。
          </p>
          {error && (
            <p className="task-error" role="alert">
              {error}
            </p>
          )}
        </ConfirmDialog>
      )}
    </section>
  )
}
