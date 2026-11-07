import { useEffect, useRef, useState, type RefObject } from 'react'
import { Heart, MessageCircle, X } from 'lucide-react'
import type { CommentMediaSource, WorkComment } from '../../shared/contracts'
import { call, CommandError } from './api'
import './comments.css'

type Scope = { accountId: string; queueId: string; revision: number; workId: string }
type FeedProps = {
  scope: Scope
  isCurrent: () => boolean
  login: () => void
  scroll: RefObject<HTMLDivElement | null>
  commentId?: string
}
type Failure = { cursor: string; message: string; login: boolean }

function CommentAttachment({ sources }: { sources: CommentMediaSource[] }) {
  const [index, setIndex] = useState(0)
  const source = sources[index]
  const fallback = () => setIndex((current) => (current === index ? current + 1 : current))
  if (!source) return <span className="comment-attachment comment-attachment-failed">图片暂不可用</span>
  return source.type === 'video' ? (
    <video
      className="comment-attachment"
      key={source.url}
      src={source.url}
      muted
      loop
      playsInline
      autoPlay
      preload="metadata"
      aria-label="动态表情"
      onError={fallback}
    />
  ) : (
    <img
      className="comment-attachment"
      key={source.url}
      src={source.url}
      alt="评论图片"
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={fallback}
    />
  )
}

function CommentFeed({ scope, isCurrent, login, scroll, commentId }: FeedProps) {
  const [items, setItems] = useState<WorkComment[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const active = useRef(false)
  const pending = useRef(false)
  const consumed = useRef(new Set<string>())
  const seen = useRef(new Set<string>())
  const sentinel = useRef<HTMLDivElement>(null)
  const load = async (cursor: string) => {
    if (!active.current || pending.current || !isCurrent()) return
    pending.current = true
    setLoading(true)
    setFailure(null)
    try {
      const page = await call(window.mylike.invoke('comments', { ...scope, commentId, cursor }))
      if (!active.current || !isCurrent()) return
      if (page.nextCursor && (page.nextCursor === cursor || consumed.current.has(page.nextCursor)))
        throw new Error('评论分页重复，请重试。')
      const fresh = page.items.filter((item) => !seen.current.has(item.id))
      if (page.nextCursor && !fresh.length) throw new Error('这页评论重复，请重试。')
      consumed.current.add(cursor)
      for (const item of fresh) seen.current.add(item.id)
      setItems((previous) => [...previous, ...fresh])
      setNext(page.nextCursor)
    } catch (error) {
      if (active.current && isCurrent())
        setFailure({
          cursor,
          message: error instanceof Error ? error.message : '评论暂时无法加载。',
          login:
            error instanceof CommandError &&
            ['AUTH_REQUIRED', 'VERIFICATION_REQUIRED', 'IDENTITY_MISMATCH'].includes(error.code)
        })
    } finally {
      pending.current = false
      if (active.current && isCurrent()) setLoading(false)
    }
  }
  useEffect(() => {
    active.current = true
    const timer = setTimeout(() => void load('0'), 0)
    return () => {
      active.current = false
      clearTimeout(timer)
    }
  }, [])
  useEffect(() => {
    const root = scroll.current,
      target = sentinel.current
    if (!root || !target || loading || failure || !next || commentId) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void load(next)
      },
      { root }
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [next, loading, failure, commentId, scroll])
  return (
    <>
      {!!items.length && (
        <ul className="comment-list" aria-label={commentId ? '回复列表' : '评论列表'}>
          {items.map((item) => (
            <li key={item.id}>
              <div className="comment-item">
                <span className="comment-avatar" aria-hidden="true">
                  {item.avatarUrl ? (
                    <img src={item.avatarUrl} alt="" loading="lazy" />
                  ) : (
                    item.author.slice(0, 1)
                  )}
                </span>
                <div className="comment-content">
                  <strong>{item.author}</strong>
                  {item.text && <p>{item.text}</p>}
                  {!!item.attachments.length && (
                    <div className="comment-images">
                      {item.attachments.map((sources) => (
                        <CommentAttachment key={sources[0]!.url} sources={sources} />
                      ))}
                    </div>
                  )}
                  {!item.text && !item.attachments.length && (
                    <p className="comment-meta">此评论没有可显示的文字或图片</p>
                  )}
                  <div className="comment-meta">
                    {item.publishedAt && (
                      <time dateTime={new Date(item.publishedAt * 1000).toISOString()}>
                        {new Date(item.publishedAt * 1000).toLocaleDateString('zh-CN')}
                      </time>
                    )}
                    {!!item.likes && (
                      <span aria-label={'获赞 ' + item.likes}>
                        <Heart size={12} /> {item.likes}
                      </span>
                    )}
                  </div>
                  {!commentId && !!item.replies && (
                    <button
                      className="comment-replies-toggle"
                      aria-expanded={expanded.has(item.id)}
                      onClick={() =>
                        setExpanded((previous) => {
                          const updated = new Set(previous)
                          if (updated.has(item.id)) updated.delete(item.id)
                          else updated.add(item.id)
                          return updated
                        })
                      }
                    >
                      {expanded.has(item.id) ? '收起回复' : '查看回复 · ' + item.replies}
                    </button>
                  )}
                  {expanded.has(item.id) && (
                    <div className="comment-thread">
                      <CommentFeed
                        scope={scope}
                        isCurrent={isCurrent}
                        login={login}
                        scroll={scroll}
                        commentId={item.id}
                      />
                    </div>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {loading && (
        <p className="comment-status" role="status">
          {commentId ? '正在加载回复…' : '正在加载评论…'}
        </p>
      )}
      {failure && (
        <div className="comment-status" role="alert">
          <p>{failure.message}</p>
          <div className="comment-actions">
            {failure.login && <button onClick={login}>登录 / 验证</button>}
            <button onClick={() => void load(failure.cursor)}>重试</button>
          </div>
        </div>
      )}
      {!loading &&
        !failure &&
        (next ? (
          commentId ? (
            <button className="comment-more" onClick={() => void load(next)}>
              加载更多回复
            </button>
          ) : (
            <div className="comment-sentinel" ref={sentinel} aria-hidden="true" />
          )
        ) : (
          <p className="comment-status">
            {items.length ? '已加载全部' : commentId ? '暂无可显示的回复' : '暂无可显示的评论'}
          </p>
        ))}
    </>
  )
}

export function CommentsPanel({
  close,
  ...feed
}: Omit<FeedProps, 'commentId' | 'scroll'> & { close: () => void }) {
  const closeButton = useRef<HTMLButtonElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  useEffect(() => closeButton.current?.focus(), [])
  return (
    <aside className="comments-panel" aria-label="作品评论">
      <header className="comments-heading">
        <MessageCircle size={16} aria-hidden="true" />
        <h2>评论</h2>
        <button ref={closeButton} onClick={close} aria-label="关闭评论">
          <X size={16} />
        </button>
      </header>
      <div className="comments-scroll" ref={scroll}>
        <CommentFeed {...feed} scroll={scroll} />
      </div>
    </aside>
  )
}
