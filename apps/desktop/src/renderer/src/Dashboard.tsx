import {
  ArrowRight,
  Film,
  Heart,
  ImageIcon,
  Database,
  Play,
  Plus,
  Shuffle,
  CalendarDays,
  TrendingUp
} from 'lucide-react'
import type { Account, LibraryOverview, Snapshot, Work } from '../../shared/contracts'
import './dashboard.css'
import './dashboard-extra.css'
import { formatBytes as size } from './format'
import { BrandMark } from './BrandMark'

type Props = {
  account: Account | undefined
  snapshot: Snapshot | null
  overview: { data: LibraryOverview | null; error: string; retry: () => void }
  busy: boolean
  browse: () => void
  add: () => void
  play: (work?: Work) => void
  resume: () => void
}
const number = (value: number | undefined) => (value === undefined ? '—' : value.toLocaleString('zh-CN'))

export function Dashboard({ account, snapshot, overview, busy, browse, add, play, resume }: Props) {
  const data = overview.data
  const playback = snapshot?.playback && !snapshot.playback.completed ? snapshot.playback : null
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
            value: data ? size(data.metadataBytes) : '—',
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
      <div className="dashboard-middle">
        <section className="dashboard-play-card">
          <div className="dashboard-section-title">
            <Play size={15} />
            <h2>{playback ? '继续回看' : '开始回看'}</h2>
          </div>
          {playback ? (
            <div className="dashboard-resume">
              <div className="resume-cover">
                {playback.work.coverUrl ? <img src={playback.work.coverUrl} alt="" /> : <Play size={26} />}
              </div>
              <div>
                <h3>{playback.work.title || '未命名作品'}</h3>
                <p>@{playback.work.author || '未知作者'}</p>
                <span>
                  第 {playback.index + 1} / {number(playback.total)} 条
                </span>
              </div>
            </div>
          ) : (
            <div className="dashboard-play-empty">
              <div className="play-orbit">
                <Shuffle size={27} />
              </div>
              <h3>{data?.total ? '从喜欢的内容开始' : '内容库还没有作品'}</h3>
              <p>{data?.total ? '洗牌回看，或进入内容库挑选。' : '到“喜欢的内容”采集作品。'}</p>
            </div>
          )}
          <div className="dashboard-play-actions">
            {playback && (
              <button className="primary" disabled={busy} onClick={resume}>
                <Play size={15} />
                继续播放
              </button>
            )}
            <button
              className={playback ? '' : 'primary'}
              disabled={busy || !data?.total}
              onClick={() => play()}
            >
              <Shuffle size={15} />
              洗牌回看
            </button>
            <button className="text-action" onClick={browse}>
              浏览内容
              <ArrowRight size={15} />
            </button>
          </div>
        </section>
        <section className="dashboard-chart-card" aria-label="作品年份分布">
          <div className="dashboard-section-title">
            <TrendingUp size={16} />
            <h2>收录足迹</h2>
            <span>按作品发布年份</span>
          </div>
          {data ? (
            <div
              className="collection-chart"
              role="img"
              aria-label={
                data.years.length
                  ? data.years.map((item) => `${item.year ?? '未知年份'}：${item.count} 条`).join('，')
                  : '暂无收录作品'
              }
            >
              {data.years.map((item) => (
                <div
                  className="chart-column"
                  key={item.year ?? 'unknown'}
                  tabIndex={0}
                  title={`${item.year ?? '未知年份'} · ${item.count} 条`}
                >
                  <strong>{number(item.count)}</strong>
                  <div>
                    <i
                      style={{
                        height: `${Math.max(4, (100 * item.count) / Math.max(1, ...data.years.map((v) => v.count)))}%`
                      }}
                    />
                  </div>
                  <span>{item.year ?? '未知'}</span>
                </div>
              ))}
              {!data.years.length && <div className="recent-empty">暂无收录作品</div>}
            </div>
          ) : (
            <div className="recent-empty">正在读取收录记录…</div>
          )}
        </section>
      </div>
      <section className="dashboard-recent">
        <div className="dashboard-section-title">
          <h2>最近收录</h2>
          <button className="text-action" onClick={browse}>
            查看全部
            <ArrowRight size={14} />
          </button>
        </div>
        {data?.recent.length ? (
          <div className="recent-grid">
            {data.recent.map((work) => (
              <button
                className="recent-work"
                key={work.id}
                disabled={busy}
                onClick={() => play(work)}
                title={work.title}
              >
                <span className="recent-cover">
                  {work.coverUrl ? (
                    <img src={work.coverUrl} alt="" loading="lazy" />
                  ) : work.mediaType === 'gallery' ? (
                    <ImageIcon size={22} />
                  ) : (
                    <Film size={22} />
                  )}
                </span>
                <span className="recent-work-text">
                  <strong>{work.title || '未命名作品'}</strong>
                  <small>@{work.author || '未知作者'}</small>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="recent-empty">{data ? '采集后，最近收录的作品会显示在这里。' : '正在读取…'}</div>
        )}
      </section>
    </div>
  )
}
