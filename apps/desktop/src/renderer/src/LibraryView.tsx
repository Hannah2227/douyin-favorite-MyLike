import type { Dispatch, SetStateAction } from 'react'
import {
  ArrowRight,
  ArrowDownToLine,
  Heart,
  ImageIcon,
  LoaderCircle,
  LogIn,
  Play,
  Plus,
  X,
  CheckSquare,
  Trash2,
  Shuffle
} from 'lucide-react'
import { MAX_BATCH_SIZE, type Account, type Work, type QueueState } from '../../shared/contracts'
import type { Library } from './useLibrary'
import { Select } from './Select'

type Props = {
  readOnly?: boolean
  library: Library
  account: Account | undefined
  busy: boolean
  mutationBusy: boolean
  collection: { start: () => void; running: boolean; busy: boolean }
  play: (work: Work) => void
  login: () => void
  setAdding: Dispatch<SetStateAction<boolean>>
  selectAll: () => void
  remove: () => void
  unlike: () => void
  playRange: (mode: 'sequence' | 'shuffle') => void
  resume: QueueState | null
  continuePlayback: () => void
  dismissPlayback: () => void
}
export function LibraryView({
  library,
  readOnly = false,
  account,
  busy,
  mutationBusy,
  collection,
  play,
  login,
  setAdding,
  selectAll,
  remove,
  unlike,
  playRange,
  resume,
  continuePlayback,
  dismissPlayback
}: Props) {
  const {
    search,
    type,
    setType,
    year,
    setYear,
    month,
    setMonth,
    page,
    querying,
    scroll,
    virtual,
    columns,
    selection,
    pendingChanges
  } = library
  const filtered = !!(search || type !== 'all' || year || month)
  const connected = !!account?.lastVerifiedAt
  return (
    <>
      {resume && (
        <div className="resume-banner">
          <span>
            上次看到：{resume.work.title || '未命名作品'}
            <small>
              第 {resume.index + 1} / {resume.total} 条 · {Math.floor(resume.position.seconds)} 秒
            </small>
          </span>
          <button disabled={busy} onClick={continuePlayback}>
            <Play size={14} />
            继续回看
          </button>
          <button disabled={busy} aria-label="不再提示上次播放" onClick={dismissPlayback}>
            <X size={14} />
          </button>
        </div>
      )}
      <div className="filter-bar">
        <div className="segmented">
          {(['all', 'video', 'gallery'] as const).map((value, i) => (
            <button
              key={value}
              aria-pressed={type === value}
              className={type === value ? 'selected' : ''}
              onClick={() => setType(value)}
            >
              {['全部内容', '视频', '图集'][i]}
            </button>
          ))}
        </div>
        <div className="range-play-actions">
          <button disabled={!page.total || querying || busy} onClick={() => playRange('sequence')}>
            <Play size={14} />
            {selection.ids.size ? '播放所选' : '顺序播放'}
          </button>
          <button disabled={!page.total || querying || busy} onClick={() => playRange('shuffle')}>
            <Shuffle size={14} />
            {selection.ids.size ? '洗牌所选' : '洗牌播放'}
          </button>
        </div>
        <Select
          label="年份筛选"
          value={String(year ?? '')}
          options={[
            { value: '', label: '全部年份' },
            ...page.years.map((y) => ({ value: String(y), label: `${y} 年` }))
          ]}
          onChange={(value) => setYear(value ? Number(value) : null)}
        />
        <Select
          label="月份筛选"
          value={String(month ?? '')}
          options={[
            { value: '', label: '全部月份' },
            ...Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} 月` }))
          ]}
          onChange={(value) => setMonth(value ? Number(value) : null)}
        />
      </div>
      <div className="list-caption">
        <span>
          {querying
            ? '正在查询…'
            : library.loadError && !page.items.length
              ? '读取失败'
              : `${page.total} 条内容`}
        </span>
        <div className="list-actions">
          <button
            disabled={!page.total || busy}
            onClick={selection.enabled ? selection.clear : selection.enable}
          >
            <CheckSquare size={15} />
            {selection.enabled ? '退出选择' : '批量选择'}
          </button>
        </div>
      </div>
      {selection.enabled && (
        <div className="batch-bar" aria-label="批量操作">
          <strong aria-live="polite">已选 {selection.ids.size} 条</strong>
          <button disabled={busy || querying} onClick={selectAll}>
            {page.total > MAX_BATCH_SIZE ? `选择前 ${MAX_BATCH_SIZE} 条` : '选择全部筛选结果'}
          </button>
          <button disabled={!selection.ids.size || busy} onClick={selection.clear}>
            清空选择
          </button>
          {!readOnly && (
            <button disabled={!selection.ids.size || mutationBusy} onClick={remove}>
              <Trash2 size={14} />
              删除本地条目
            </button>
          )}
          {pendingChanges && <span>内容有更新，清空选择后刷新。</span>}
          <button
            className="danger-button"
            disabled={!selection.ids.size || selection.ids.size > MAX_BATCH_SIZE || mutationBusy}
            onClick={unlike}
          >
            {readOnly ? '取消抖音收藏' : '取消抖音点赞'}
          </button>
          {selection.ids.size > MAX_BATCH_SIZE && <span>一次最多 {MAX_BATCH_SIZE} 条，请缩小选择范围。</span>}
        </div>
      )}
      <div className="library-scroll" ref={scroll}>
        {library.loadError && !page.items.length ? (
          <div className="empty-state">
            <h2>内容读取失败</h2>
            <p>{library.loadError}</p>
            <button onClick={library.retry}>重新读取</button>
          </div>
        ) : querying && !page.items.length ? (
          <div className="empty-state">
            <h2>正在查询…</h2>
          </div>
        ) : !page.items.length ? (
          <div className="empty-state">
            {collection.running && !filtered ? (
              <LoaderCircle className="empty-icon spin" size={32} strokeWidth={1.5} />
            ) : (
              <Heart className="empty-icon" size={32} strokeWidth={1.5} />
            )}
            <h2>
              {filtered
                ? '没有匹配内容'
                : collection.running
                  ? '正在收录内容'
                  : connected
                    ? readOnly
                      ? '开始收录收藏'
                      : '开始收录喜欢'
                    : account
                      ? '暂无内容'
                      : '添加账号'}
            </h2>
            <p>
              {account
                ? filtered
                  ? '试试其他关键词或筛选条件。'
                  : collection.running
                    ? '作品将陆续出现在这里，采集途中也可以观看已收录的视频。'
                    : connected
                      ? `${readOnly ? '点击“向下采集”，收录收藏作品和收藏夹。' : '点击上方“向下采集”，收录喜欢的作品。'}\n采集途中也可以观看已收录的视频。`
                      : '登录抖音后开始采集。'
                : '添加抖音账号后开始采集。'}
            </p>
            {(!collection.running || filtered) && (
              <button
                className="primary"
                disabled={filtered ? busy : busy || collection.busy}
                onClick={() =>
                  filtered
                    ? library.resetFilters()
                    : connected
                      ? collection.start()
                      : account
                        ? login()
                        : setAdding(true)
                }
              >
                {filtered ? (
                  <X size={17} />
                ) : connected ? (
                  <ArrowDownToLine size={17} />
                ) : account ? (
                  <LogIn size={17} />
                ) : (
                  <Plus size={17} />
                )}
                {filtered
                  ? '清空筛选'
                  : connected
                    ? readOnly
                      ? '开始同步'
                      : '开始采集'
                    : account
                      ? '打开抖音登录'
                      : '添加抖音账号'}
                <ArrowRight size={16} />
              </button>
            )}
          </div>
        ) : (
          <>
            {library.loadError && (
              <div className="library-load-error" role="alert">
                <span>列表刷新失败：{library.loadError}</span>
                <button onClick={library.retry}>重新读取</button>
              </div>
            )}
            <div className="virtual-grid" style={{ height: virtual.getTotalSize() }}>
              {virtual.getVirtualItems().map((row) => (
                <div
                  className="grid-row"
                  key={`${row.index}-${columns}`}
                  style={{
                    transform: `translateY(${row.start}px)`,
                    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`
                  }}
                >
                  {page.items.slice(row.index * columns, (row.index + 1) * columns).map((work) => (
                    <div
                      key={work.id}
                      className={`work-item ${selection.ids.has(work.id) ? 'is-selected' : ''}`}
                    >
                      <button
                        className="work-card"
                        disabled={busy || (querying && selection.enabled)}
                        onClick={() => (selection.enabled ? selection.toggle(work.id) : play(work))}
                        title={work.title}
                      >
                        <div className="cover">
                          {work.coverUrl ? (
                            <img
                              loading="lazy"
                              src={work.coverUrl}
                              alt=""
                              onError={(e) => {
                                e.currentTarget.style.visibility = 'hidden'
                              }}
                            />
                          ) : (
                            <Heart size={36} />
                          )}
                          <span className="type-badge">
                            {work.mediaType === 'gallery' ? (
                              <ImageIcon size={12} />
                            ) : (
                              <Play size={11} fill="currentColor" />
                            )}
                            {work.isLive ? '实况' : work.mediaType === 'gallery' ? '图集' : '视频'}
                          </span>
                          <span className="play-hover">
                            <Play size={24} fill="currentColor" />
                          </span>
                        </div>
                        <h3>{work.title || '未命名作品'}</h3>
                        <p>
                          <span>@{work.author || '未知作者'}</span>
                          <time>
                            {work.publishedAt
                              ? new Date(work.publishedAt * 1000).toLocaleDateString('zh-CN')
                              : ''}
                          </time>
                        </p>
                      </button>
                      {selection.enabled && (
                        <input
                          className="work-select"
                          type="checkbox"
                          aria-label={`选择 ${work.title || work.id}`}
                          checked={selection.ids.has(work.id)}
                          disabled={busy}
                          onChange={() => selection.toggle(work.id)}
                        />
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <div className="library-load-status" ref={library.sentinel} aria-live="polite">
              {library.moreError ? (
                <div className="library-load-error" role="alert">
                  <span>加载失败：{library.moreError}</span>
                  <button onClick={library.retryMore}>重试加载</button>
                  <button onClick={library.retry}>刷新列表</button>
                </div>
              ) : library.loadingMore ? (
                '正在加载…'
              ) : library.hasMore ? (
                pendingChanges ? (
                  '内容有更新，清空选择后继续加载。'
                ) : null
              ) : (
                '已显示全部内容'
              )}
            </div>
          </>
        )}
      </div>
    </>
  )
}
