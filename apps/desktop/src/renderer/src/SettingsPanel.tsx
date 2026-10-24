import { useState, type Dispatch, type SetStateAction, type ReactNode } from 'react'
import {
  Settings2,
  Play,
  Keyboard,
  User,
  Database,
  Info,
  Search,
  RotateCcw,
  Copy,
  ExternalLink
} from 'lucide-react'
import {
  playbackPreferencesSchema,
  type Account,
  type Diagnostics,
  type Snapshot,
  type PlaybackPreferences
} from '../../shared/contracts'
import {
  appPreferencesSchema,
  shortcutKeys,
  shortcutActions,
  keyLabel,
  playbackRates,
  type AppPreferences,
  type ShortcutAction
} from '../../shared/preferences'
import { call, type Perform } from './api'
import { AccountPanel } from './AccountPanel'
import { DataPanel } from './DataPanel'
import { Select } from './Select'
import { ConfirmDialog } from './ConfirmDialog'
import { BrandMark, GitHubMark } from './BrandMark'
import './settings.css'

type Props = {
  snapshot: Snapshot | null
  diagnostics: Diagnostics | null
  setDiagnostics: Dispatch<SetStateAction<Diagnostics | null>>
  perform: Perform
  preferences: PlaybackPreferences
  updatePreferences: (patch: Partial<PlaybackPreferences>) => void
  account: Account | undefined
  busy: boolean
  login: () => void
  probe: () => void
  notice: (message: string) => void
  importFile: () => void
  exportAll: () => void
}
const groups = [
  {
    id: 'general',
    title: '通用',
    icon: Settings2,
    keywords: '通用 外观 主题 白天 黑夜 启动 默认 页面 界面 缩放 字体 窗口 记忆 位置 尺寸 动画'
  },
  {
    id: 'playback',
    title: '播放',
    icon: Play,
    keywords: '播放 自动 连播 音量 倍速 失焦 暂停 滚轮 快进 后退 图集 实况'
  },
  {
    id: 'shortcuts',
    title: '快捷键',
    icon: Keyboard,
    keywords:
      '快捷键 按键 绑定 恢复 默认 冲突' +
      Object.values(shortcutActions)
        .map((a) => a.label)
        .join(' ')
  },
  { id: 'account', title: '账号', icon: User, keywords: '账号 登录 抖音 核验 名称 改名 删除 退出' },
  {
    id: 'storage',
    title: '数据与存储',
    icon: Database,
    keywords: '数据 存储 备份 导入 导出 元数据 目录 路径 占用 缓存 清理 检查 完整性'
  },
  {
    id: 'about',
    title: '关于',
    icon: Info,
    keywords: '关于 版本 诊断 运行 环境 Electron Chromium Node SQLite 项目 GitHub 发布 更新'
  }
] as const
function Row({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <span>
        {label}
        {description && <small>{description}</small>}
      </span>
      <div className="setting-value">{children}</div>
    </div>
  )
}
function Toggle({
  label,
  value,
  change
}: {
  label: string
  value: boolean
  change: (value: boolean) => void
}) {
  return (
    <input
      className="setting-switch"
      type="checkbox"
      aria-label={label}
      checked={value}
      onChange={(e) => change(e.target.checked)}
    />
  )
}
export function SettingsPanel({
  snapshot,
  diagnostics,
  setDiagnostics,
  perform,
  preferences,
  updatePreferences,
  account,
  busy,
  login,
  probe,
  notice,
  importFile,
  exportAll
}: Props) {
  const [search, setSearch] = useState(''),
    [active, setActive] = useState('general'),
    [reset, setReset] = useState<'general' | 'playback' | 'shortcuts' | null>(null)
  const application = snapshot?.appPreferences ?? appPreferencesSchema.parse({})
  const updateApplication = (patch: Partial<AppPreferences>) =>
    void perform('保存通用设置', () => call(window.mylike.invoke('appPreferences', { preferences: patch })))
  const visible = (id: string) =>
    !search.trim() ||
    groups
      .find((g) => g.id === id)!
      .keywords.toLowerCase()
      .includes(search.trim().toLowerCase())
  const jump = (id: string) => {
    setSearch('')
    setActive(id)
    requestAnimationFrame(() =>
      document.getElementById(`settings-${id}`)?.scrollIntoView({
        block: 'start',
        behavior:
          application.motion === 'reduce' || window.matchMedia('(prefers-reduced-motion: reduce)').matches
            ? 'instant'
            : 'smooth'
      })
    )
  }
  return (
    <div className="panel-scroll settings-scroll">
      <div className="settings-top">
        <span>应用偏好</span>
        <label className="settings-search">
          <Search size={16} />
          <input
            aria-label="搜索设置"
            placeholder="搜索设置"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button aria-label="清空设置搜索" onClick={() => setSearch('')}>
              ×
            </button>
          )}
        </label>
      </div>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          {groups.map((g) => (
            <button key={g.id} className={active === g.id ? 'active' : ''} onClick={() => jump(g.id)}>
              <g.icon size={16} />
              {g.title}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          <section id="settings-general" className="panel settings-section" hidden={!visible('general')}>
            <div className="settings-section-heading">
              <Settings2 size={18} />
              <h2>通用</h2>
              <button title="恢复通用默认设置" onClick={() => setReset('general')}>
                <RotateCcw size={14} />
                恢复默认
              </button>
            </div>
            <Row label="外观主题" description="外观偏好独立于抖音账号">
              <Select
                label="外观主题"
                value={snapshot?.theme ?? 'dark'}
                options={[
                  { value: 'dark', label: '黑夜模式' },
                  { value: 'light', label: '白天模式' }
                ]}
                onChange={(value) =>
                  void perform('切换主题', () =>
                    call(window.mylike.invoke('theme', { theme: value as 'dark' | 'light' }))
                  )
                }
              />
            </Row>
            <Row label="启动时打开" description="后台任务始终等待手动继续">
              <Select
                label="启动时打开"
                value={application.startupPage}
                onChange={(value) =>
                  updateApplication({ startupPage: value as AppPreferences['startupPage'] })
                }
                options={[
                  { value: 'library', label: '喜欢的内容' },
                  { value: 'dashboard', label: '仪表盘' },
                  { value: 'favorites', label: '收藏的内容' },
                  { value: 'tasks', label: '连接与任务' }
                ]}
              />
            </Row>
            <Row label="界面缩放" description="同时调整文字和控件大小">
              <Select
                label="界面缩放"
                value={String(application.zoom)}
                onChange={(value) => updateApplication({ zoom: Number(value) as AppPreferences['zoom'] })}
                options={[0.9, 1, 1.1, 1.25, 1.5].map((v) => ({
                  value: String(v),
                  label: `${Math.round(v * 100)}%`
                }))}
              />
            </Row>
            <Row label="记住窗口位置与大小" description="再次打开时恢复，显示器变化时保持窗口可见">
              <Toggle
                label="记住窗口位置与大小"
                value={application.rememberWindow}
                change={(rememberWindow) => updateApplication({ rememberWindow })}
              />
            </Row>
            <Row label="界面动画">
              <Select
                label="界面动画"
                value={application.motion}
                options={[
                  { value: 'system', label: '跟随系统偏好' },
                  { value: 'reduce', label: '减少动画' }
                ]}
                onChange={(value) => updateApplication({ motion: value as AppPreferences['motion'] })}
              />
            </Row>
          </section>
          <section id="settings-playback" className="panel settings-section" hidden={!visible('playback')}>
            <div className="settings-section-heading">
              <Play size={18} />
              <h2>播放偏好</h2>
              <button title="恢复播放默认设置" onClick={() => setReset('playback')}>
                <RotateCcw size={14} />
                恢复默认
              </button>
            </div>
            <Row label="进入作品自动播放">
              <Toggle
                label="进入作品自动播放"
                value={preferences.autoplay}
                change={(autoplay) => updatePreferences({ autoplay })}
              />
            </Row>
            <Row label="自动连播" description="开启后播放下一条，关闭后循环当前作品">
              <Toggle
                label="自动连播"
                value={preferences.continuous}
                change={(continuous) => updatePreferences({ continuous })}
              />
            </Row>
            <Row label="滚轮切换作品">
              <Toggle
                label="滚轮切换作品"
                value={preferences.wheelNavigation}
                change={(wheelNavigation) => updatePreferences({ wheelNavigation })}
              />
            </Row>
            <Row label="失焦时暂停" description="切到其他窗口时暂停，回来后手动继续">
              <Toggle
                label="失焦时暂停"
                value={preferences.pauseOnBlur}
                change={(pauseOnBlur) => updatePreferences({ pauseOnBlur })}
              />
            </Row>
            <Row label="快进 / 后退步长">
              <Select
                label="快进后退步长"
                value={String(preferences.seekStep)}
                onChange={(value) => updatePreferences({ seekStep: Number(value) })}
                options={[5, 10, 15, 30, 60].map((v) => ({ value: String(v), label: `${v} 秒` }))}
              />
            </Row>
            <Row label="播放倍速">
              <Select
                label="默认播放倍速"
                value={String(preferences.speed)}
                onChange={(value) => updatePreferences({ speed: Number(value) })}
                options={[...new Set([...playbackRates, preferences.speed])]
                  .sort((a, b) => a - b)
                  .map((v) => ({ value: String(v), label: `${v}x` }))}
              />
            </Row>
            <Row label="播放音量">
              <input
                aria-label="默认音量"
                type="range"
                min="0"
                max="1"
                step=".05"
                value={preferences.volume}
                onChange={(e) => updatePreferences({ volume: Number(e.target.value) })}
              />
              <span className="setting-number">{Math.round(preferences.volume * 100)}%</span>
            </Row>
            <Row
              label="图集轮播"
              description="静态图 3 秒，实况播完显示照片 2 秒；手动翻图后停留，可恢复轮播"
            >
              <span className="setting-tag">自动保存播放进度</span>
            </Row>
          </section>
          <section id="settings-shortcuts" className="panel settings-section" hidden={!visible('shortcuts')}>
            <div className="settings-section-heading">
              <Keyboard size={18} />
              <h2>播放快捷键</h2>
              <button title="恢复默认快捷键" onClick={() => setReset('shortcuts')}>
                <RotateCcw size={14} />
                恢复默认
              </button>
            </div>
            <p className="settings-description">
              仅播放器中生效。PageUp / PageDown 也可切换作品，左右键在图集中翻页。 Esc
              依次退出清屏、全屏或返回；输入框、菜单和弹窗优先。取消点赞始终需要确认。
            </p>
            {(
              Object.entries(shortcutActions) as [ShortcutAction, (typeof shortcutActions)[ShortcutAction]][]
            ).map(([id, action]) => (
              <div key={id}>
                <Row label={action.label}>
                  <Select
                    label={`${action.label}快捷键`}
                    value={preferences.shortcuts[id]}
                    onChange={(value) =>
                      updatePreferences({
                        shortcuts: {
                          ...preferences.shortcuts,
                          [id]: value as PlaybackPreferences['shortcuts'][typeof id]
                        }
                      })
                    }
                    options={shortcutKeys.map((key) => ({
                      value: key,
                      label: keyLabel(key),
                      disabled:
                        key !== 'None' &&
                        key !== preferences.shortcuts[id] &&
                        Object.values(preferences.shortcuts).includes(key)
                    }))}
                  />
                </Row>
              </div>
            ))}
          </section>
          <div id="settings-account" className="settings-section" hidden={!visible('account')}>
            <AccountPanel
              account={account}
              busy={busy}
              perform={perform}
              login={login}
              probe={probe}
              notice={notice}
            />
          </div>
          <div id="settings-storage" className="settings-section" hidden={!visible('storage')}>
            <DataPanel
              accountId={account?.id ?? null}
              busy={busy}
              perform={perform}
              importFile={importFile}
              exportAll={exportAll}
              notice={notice}
            />
          </div>
          <section id="settings-about" className="panel settings-section" hidden={!visible('about')}>
            <div className="settings-about-brand">
              <BrandMark size={70} />
              <div>
                <h2>MyLike</h2>
                <p>版本 {snapshot?.version ?? '—'} · Windows x64</p>
              </div>
            </div>
            <p className="settings-description">
              喜欢与收藏的本地整理工具。内容和会话保存在本机，播放依赖网络；应用不收集遥测数据。
            </p>
            <Row label="项目与版本">
              <button
                onClick={() =>
                  void perform('打开项目地址', () => call(window.mylike.invoke('openProject', {})))
                }
              >
                <GitHubMark size={15} />
                项目地址
              </button>
              <button
                onClick={() =>
                  void perform('查看发布记录', () => call(window.mylike.invoke('openReleases', {})))
                }
              >
                <ExternalLink size={14} />
                查看发布记录
              </button>
            </Row>
            <Row label="运行环境" description="诊断仅含版本与进程占用，不含账号、登录凭据或媒体地址">
              <button
                onClick={() =>
                  void perform('读取诊断', async () =>
                    setDiagnostics(await call(window.mylike.invoke('diagnostics', {})))
                  )
                }
              >
                查看诊断
              </button>
              <button
                onClick={() =>
                  void perform('复制脱敏诊断', async () => {
                    await call(window.mylike.invoke('copyDiagnostics', {}))
                    notice('脱敏诊断已复制。')
                  })
                }
              >
                <Copy size={14} />
                复制诊断信息
              </button>
            </Row>
            {diagnostics && (
              <dl className="diagnostics">
                <dt>Electron / Chromium</dt>
                <dd>
                  {diagnostics.electron} / {diagnostics.chromium}
                </dd>
                <dt>Node / SQLite</dt>
                <dd>
                  {diagnostics.node} / {diagnostics.sqlite}
                </dd>
                <dt>运行方式</dt>
                <dd>{diagnostics.packaged ? '生产包' : '开发构建'}</dd>
                <dt>进程工作集之和</dt>
                <dd>
                  {diagnostics.processes.reduce((sum, p) => sum + p.memoryMB, 0)} MB（共享页可能重复计入）
                </dd>
              </dl>
            )}
          </section>
          {search && !groups.some((g) => visible(g.id)) && (
            <div className="settings-no-results">
              <Search size={27} />
              <h3>没有找到相关设置</h3>
              <p>试试“播放”“快捷键”或“数据”。</p>
            </div>
          )}
        </div>
      </div>
      {reset && (
        <ConfirmDialog
          title={
            reset === 'shortcuts'
              ? '恢复默认快捷键'
              : reset === 'playback'
                ? '恢复播放默认设置'
                : '恢复通用默认设置'
          }
          busy={busy}
          danger={false}
          confirmLabel="恢复默认"
          cancel={() => setReset(null)}
          confirm={() => {
            if (reset === 'general') updateApplication(appPreferencesSchema.parse({}))
            else if (reset === 'shortcuts')
              updatePreferences({ shortcuts: playbackPreferencesSchema.parse({}).shortcuts })
            else
              updatePreferences({ ...playbackPreferencesSchema.parse({}), shortcuts: preferences.shortcuts })
            setReset(null)
          }}
        >
          <p>只恢复这组偏好，不删除账号、内容或播放记录。</p>
        </ConfirmDialog>
      )}
    </div>
  )
}
