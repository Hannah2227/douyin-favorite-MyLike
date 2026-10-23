import { useState, type Dispatch, type SetStateAction } from 'react'

import {
  Activity,
  LayoutDashboard,
  Library,
  Bookmark,
  Plus,
  Settings2,
  Sun,
  Moon,
  CircleHelp,
  BookOpen,
  Pencil,
  Trash2
} from 'lucide-react'
import type { Account, Snapshot } from '../../shared/contracts'
import { call, type Tab, type Perform } from './api'
import { Select } from './Select'
import { accountLabel } from '../../shared/account-label'
import { AccountManagementDialog } from './AccountManagementDialog'
import { BrandMark, GitHubMark } from './BrandMark'

type Props = {
  snapshot: Snapshot | null
  tab: Tab
  setTab: Dispatch<SetStateAction<Tab>>
  back: () => Promise<void>
  busy: boolean
  account: Account | undefined
  setAdding: Dispatch<SetStateAction<boolean>>
  perform: Perform
}
export function Sidebar({ snapshot, tab, setTab, back, busy, account, setAdding, perform }: Props) {
  const [manage, setManage] = useState<'rename' | 'remove' | null>(null)
  return (
    <aside className="sidebar">
      <div className="brand">
        <BrandMark />
        <span>MyLike</span>
      </div>
      <nav>
        {(
          [
            { id: 'dashboard', icon: LayoutDashboard, text: '仪表盘' },
            { id: 'library', icon: Library, text: '喜欢的内容' },
            { id: 'favorites', icon: Bookmark, text: '收藏的内容' },
            { id: 'tasks', icon: Activity, text: '连接与任务' },
            { id: 'settings', icon: Settings2, text: '设置' }
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            className={tab === item.id ? 'nav-item active' : 'nav-item'}
            aria-current={tab === item.id ? 'page' : undefined}
            onClick={() => {
              void back().then(() => setTab(item.id))
            }}
          >
            <item.icon size={18} />
            {item.text}
            {item.id === 'tasks' && snapshot?.busy && <span className="activity-dot" />}
          </button>
        ))}
      </nav>
      <div className="sidebar-account-area">
        <button
          className="sidebar-utility sidebar-theme"
          aria-label="切换主题"
          disabled={!snapshot}
          onClick={() =>
            void perform('切换主题', () =>
              call(
                window.mylike.invoke('theme', {
                  theme: snapshot?.theme === 'dark' ? 'light' : 'dark'
                })
              )
            )
          }
        >
          {snapshot?.theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
          {snapshot?.theme === 'dark' ? '白天模式' : '黑夜模式'}
        </button>
        {(
          [
            { id: 'faq', text: '常见问题', icon: CircleHelp },
            { id: 'guide', text: '使用教程', icon: BookOpen }
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            className={`sidebar-utility${tab === item.id ? ' active' : ''}`}
            onClick={() => void back().then(() => setTab(item.id))}
          >
            <item.icon size={17} />
            {item.text}
          </button>
        ))}
        <button
          className="sidebar-utility"
          onClick={() => void perform('打开项目地址', () => call(window.mylike.invoke('openProject', {})))}
        >
          <GitHubMark />
          项目地址
        </button>
        <div className="account-section">
          <div className="section-label">
            抖音账号
            <span className="account-actions">
              {account && (
                <>
                  <button
                    aria-label="修改账号名称"
                    title="修改账号名称"
                    disabled={busy}
                    onClick={() => setManage('rename')}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    aria-label="删除账号及本地数据"
                    title="删除当前账号"
                    disabled={busy}
                    onClick={() => setManage('remove')}
                  >
                    <Trash2 size={14} />
                  </button>
                </>
              )}
              <button aria-label="添加账号" title="添加账号" onClick={() => setAdding(true)} disabled={busy}>
                <Plus size={16} />
              </button>
            </span>
          </div>
          {account ? (
            <>
              <div className="account-avatar">{account.name.slice(0, 1)}</div>
              <Select
                label="当前账号"
                disabled={busy}
                value={account.id}
                options={
                  snapshot?.accounts.map((a) => ({
                    value: a.id,
                    label: accountLabel(a)
                  })) ?? []
                }
                onChange={(nextId) => {
                  void perform('切换账号', async () => {
                    await back()
                    return call(window.mylike.invoke('switchAccount', { accountId: nextId }))
                  })
                }}
              />
            </>
          ) : (
            <button className="account-empty" onClick={() => setAdding(true)}>
              <Plus size={17} />
              添加第一个账号
            </button>
          )}
        </div>
      </div>
      {manage && account && (
        <AccountManagementDialog
          key={account.id + manage}
          account={account}
          mode={manage}
          busy={busy}
          perform={perform}
          close={() => setManage(null)}
          beforeRemove={back}
        />
      )}
    </aside>
  )
}
