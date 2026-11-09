import type { Dispatch, ReactNode, SetStateAction } from 'react'
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
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
  header: ReactNode
  rebuildLikedOrder?: () => void
  rebuildBusy: boolean
  readOnly?: boolean
  exportMobileLibrary?: () => void
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
  header,
  rebuildLikedOrder,
  rebuildBusy,
  readOnly = false,
  exportMobileLibrary,
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
    setMonth,
    sort,
    setSort,
    page,
    querying,
    scroll,
    virtual,
    columns,
    selection,
    pendingChanges
  } = library
  const { author, year: activeYear, month } = library.filter
  const years =
    typeof activeYear === 'number' && !page.years.includes(activeYear)
      ? [activeYear, ...page.years]
      : page.years
  const filtered = !!(search || type !== 'all' || author || activeYear || month)
  const connected = !!account?.lastVerifiedAt
  return (
    <>
      <div className="library-scroll" ref={scroll}>
        <div ref={library.controls}>
          {header}
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
            {author && (
              <button
                className="author-filter"
                aria-label={`清除作者筛选：${author}`}
                onClick={library.clearAuthor}
              >
                <span>作者：{author}</span>
                <X size={14} />
              </button>
            )}
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
              disabled={sort === 'liked' || (!!page.yearsUnavailable && year === null)}
              value={String(activeYear ?? '')}
              options={[
                { value: '', label: '全部年份' },
                ...years.map((y) => ({ value: String(y), label: `${y} 年` })),
                ...(!readOnly ? [{ value: 'unknown', label: '未知年份' }] : [])
              ]}
              onChange={(value) => {
                setYear(value === 'unknown' ? value : value ? Number(value) : null)
                if (value === 'unknown') setMonth(null)
              }}
            />
            <Select
              label="月份筛选"
              disabled={sort === 'liked' || activeYear === 'unknown'}
              value={String(month ?? '')}
              options={[
                { value: '', label: '全部月份' },
                ...Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} 月` }))
              ]}
              onChange={(value) => setMonth(value ? Number(value) : null)}
            />
            {!readOnly && (
              <Select
                label="排序方式"
                value={sort}
                options={[
                  { value: 'published', label: '按发布时间' },
                  { value: 'liked', label: '按点赞时间' }
                ]}
                onChange={(value) => setSort(value === 'liked' ? 'liked' : 'published')}
              />
            )}
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
              {exportMobileLibrary && (
                <button disabled={busy} onClick={exportMobileLibrary}>
                  <ArrowDownToLine size={15} />
                  导出清单
                </button>
              )}
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
              {selection.ids.size > MAX_BATCH_SIZE && (
                <span>一次最多 {MAX_BATCH_SIZE} 条，请缩小选择范围。</span>
              )}
            </div>
          )}
          {sort !== 'liked' && page.yearsUnavailable && !library.loadError && (
            <div className="library-load-error" role="status" aria-label="年份筛选提示">
              <span>年份筛选暂时不可用，作品仍可浏览。</span>
              <button disabled={querying} onClick={library.retry}>
                重试
              </button>
            </div>
          )}
          {sort === 'liked' && !!page.unrankedLikes && (
            <div className="library-load-error" role="status">
              <span>有 {page.unrankedLikes} 条作品的点赞顺序待补齐，暂列在最后。</span>
              <button
                title="从头读取抖音喜欢列表，保留已有作品"
                onClick={rebuildLikedOrder}
                disabled={!rebuildLikedOrder || rebuildBusy || selection.enabled}
              >
                补齐点赞顺序
              </button>
            </div>
          )}
        </div>
        <div className="library-grid-area">
          {library.loadError && !page.items.length ? (
            <div className="empty-state" role="alert">
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
              <div className="virtual-grid" ref={library.grid} style={{ height: virtual.getTotalSize() }}>
                {virtual.getVirtualItems().map((row) => (
                  <div
                    className="grid-row"
                    key={`${row.index}-${columns}`}
                    style={{
                      transform: `translateY(${row.start - virtual.options.scrollMargin}px)`,
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
            </>
          )}
        </div>
      </div>
      {page.total > 0 && (
        <form
          className="library-pagination"
          aria-label="内容分页"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            const field = event.currentTarget.elements.namedItem('page')
            if (!(field instanceof HTMLInputElement)) return
            const value = field.valueAsNumber
            const number = Number.isFinite(value)
              ? Math.max(1, Math.min(Math.trunc(value), library.pageCount))
              : library.pageNumber
            field.value = String(number)
            library.goToPage(number)
          }}
        >
          <button
            type="button"
            aria-label="上一页"
            disabled={library.pageNumber <= 1}
            onClick={() => library.goToPage(library.pageNumber - 1)}
          >
            <ChevronLeft size={14} />
          </button>
          <label>
            第{' '}
            <input
              key={JSON.stringify(library.filter) + library.pageNumber}
              name="page"
              aria-label="页码"
              type="number"
              min={1}
              max={library.pageCount}
              defaultValue={library.pageNumber}
              onInput={({ currentTarget: field }) => {
                const value = field.valueAsNumber
                if (value < 1 || value > library.pageCount) {
                  field.value = String(Math.max(1, Math.min(value, library.pageCount)))
                }
              }}
            />{' '}
            / {library.pageCount} 页
          </label>
          <button
            type="button"
            aria-label="下一页"
            disabled={library.pageNumber >= library.pageCount}
            onClick={() => library.goToPage(library.pageNumber + 1)}
          >
            <ChevronRight size={14} />
          </button>
        </form>
      )}
    </>
  )
}
