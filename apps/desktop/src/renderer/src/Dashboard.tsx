import { Film, Heart, ImageIcon, Database, Plus, CalendarDays, TrendingUp, Users } from 'lucide-react'
import type { Account, LibraryOverview } from '../../shared/contracts'
import './dashboard.css'
import './dashboard-extra.css'
import { BrandMark } from './BrandMark'

type Props = {
  account: Account | undefined
  overview: { data: LibraryOverview | null; error: string; retry: () => void }
  add: () => void
}
const number = (value: number | undefined) => (value === undefined ? '—' : String(value))

function DashboardBars({
  items,
  empty
}: {
  items: { label: string; count: number }[] | undefined
  empty: string
}) {
  if (!items) return <div className="dashboard-empty">正在读取收录记录…</div>
  if (!items.length) return <div className="dashboard-empty">{empty}</div>
  const max = Math.max(...items.map((item) => item.count))
  return (
    <div
      className="collection-chart"
      role="img"
      aria-label={items.map((item) => item.label + '：' + item.count + ' 条').join('，')}
    >
      {items.map((item) => (
        <div
          className="chart-column"
          key={item.label}
          tabIndex={0}
          title={item.label + ' · ' + item.count + ' 条'}
        >
          <strong>{item.count}</strong>
          <div>
            <i style={{ height: Math.max(4, (100 * item.count) / max) + '%' }} />
          </div>
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  )
}

export function Dashboard({ account, overview, add }: Props) {
  const data = overview.data
  if (!account)
    return (
      <div className="dashboard-scroll">
        <section className="dashboard-welcome">
          <div className="welcome-mark">
            <Heart size={30} fill="currentColor" />
          </div>
          <h2>开始整理你的喜欢</h2>
          <p>连接抖音账号，收录后随时回看。</p>
          <button className="primary" onClick={add}>
            <Plus size={16} />
            添加账号
          </button>
        </section>
      </div>
    )
  return (
    <div className="dashboard-scroll" role="region" aria-label="仪表盘内容">
      <section className="dashboard-hero">
        <div>
          <span className="dashboard-eyebrow">YOUR PERSONAL COLLECTION</span>
          <h2>你好，{account.name}</h2>
          <p>喜欢与收藏，都在这里。</p>
        </div>
        <div className="dashboard-hero-date">
          <CalendarDays size={14} />
          <span>
            {new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}
          </span>
        </div>
        <div className="dashboard-hero-art" aria-hidden="true">
          <i />
          <i />
          <BrandMark size={106} />
        </div>
      </section>
      {overview.error && (
        <div className="overview-error" role="alert">
          <span>概览读取失败：{overview.error}</span>
          <button onClick={overview.retry}>重新读取</button>
        </div>
      )}
      <section className="dashboard-metrics" aria-label="内容与数据统计">
        {[
          { label: '本地内容', value: data?.total, icon: Heart },
          { label: '视频', value: data?.videos, icon: Film },
          { label: '图集', value: data?.galleries, icon: ImageIcon },
          {
            label: '数据占用',
            value: data ? `${Math.round(data.metadataBytes / 1_000_000)} MB` : '—',
            icon: Database,
            title: '本机全部账号的元数据数据库及日志，不含媒体缓存和备份'
          }
        ].map((item) => (
          <div
            className="overview-metric"
            role="group"
            aria-label={item.label}
            key={item.label}
            title={'title' in item ? item.title : undefined}
          >
            <span>
              <item.icon size={16} />
              {item.label}
            </span>
            <strong>{typeof item.value === 'string' ? item.value : number(item.value)}</strong>
          </div>
        ))}
      </section>
      <section className="dashboard-chart-card" aria-label="作品年份分布">
        <div className="dashboard-section-title">
          <TrendingUp size={16} />
          <h2>收录足迹</h2>
          <span>按作品发布年份</span>
        </div>
        <DashboardBars
          items={data?.years.map(({ year, count }) => ({
            label: year === null ? '未知年份' : String(year),
            count
          }))}
          empty="暂无收录作品"
        />
      </section>
      <section className="dashboard-chart-card" aria-label="作者收录排行">
        <div className="dashboard-section-title">
          <Users size={16} />
          <h2>作者榜</h2>
          <span>按作者昵称</span>
        </div>
        <DashboardBars
          items={data?.authors.map(({ nickname, count }) => ({ label: nickname, count }))}
          empty="暂无作者统计"
        />
      </section>
    </div>
  )
}
