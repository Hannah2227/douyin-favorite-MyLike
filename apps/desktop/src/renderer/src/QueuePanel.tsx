import { useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { QueueState, Work } from '../../shared/contracts'
import { call } from './api'
import { Film, ImageIcon, ListVideo, Play, X } from 'lucide-react'

export function QueuePanel({
  queue,
  jump,
  close
}: {
  queue: QueueState
  jump: (index: number) => void
  close: () => void
}) {
  const scroll = useRef<HTMLDivElement>(null),
    scope = useRef(queue.queueId),
    pending = useRef(new Set<string>())
  const [cache, setCache] = useState(new Map<number, Work>()),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0)
  scope.current = queue.queueId
  const virtual = useVirtualizer({
    count: queue.total,
    getScrollElement: () => scroll.current,
    estimateSize: () => 72,
    overscan: 4
  })
  const rows = virtual.getVirtualItems(),
    first = rows[0]?.index ?? queue.index,
    last = rows.at(-1)?.index ?? queue.index
  const center = useRef(Math.floor(first / 50))
  center.current = Math.floor(first / 50)
  useEffect(() => {
    setCache(new Map())
    setError('')
  }, [queue.queueId])
  useEffect(() => {
    virtual.scrollToIndex(queue.index, { align: 'auto' })
  }, [queue.queueId, queue.index])
  useEffect(() => {
    const queueId = queue.queueId
    for (let page = Math.floor(first / 50); page <= Math.floor(last / 50); page++) {
      const requestKey = `${queueId}:${page}`
      if (pending.current.has(requestKey) || cache.has(page * 50)) continue
      pending.current.add(requestKey)
      void call(
        window.mylike.invoke('queueItems', {
          accountId: queue.accountId,
          queueId,
          offset: page * 50,
          limit: 50
        })
      )
        .then((result) => {
          if (scope.current !== queueId) return
          setCache((old) => {
            const next = new Map(old)
            for (const item of result.items) next.set(item.index, item.work)
            for (const index of next.keys())
              if (Math.abs(Math.floor(index / 50) - center.current) > 1) next.delete(index)
            return next
          })
        })
        .catch((e) => {
          if (scope.current === queueId) setError(e.message)
        })
        .finally(() => pending.current.delete(requestKey))
    }
  }, [queue.queueId, first, last, retry, cache])
  return (
    <aside className="queue-panel" aria-label="播放队列">
      <div className="queue-heading">
        <ListVideo size={17} />
        <h2>
          {queue.mode === 'shuffle' ? '洗牌列表' : '播放列表'}
          <span>{queue.total}</span>
        </h2>
        <button className="quiet" aria-label="收起播放队列" title="关闭播放列表" onClick={close}>
          <X size={17} />
        </button>
      </div>
      {error && (
        <div className="queue-error" role="alert">
          {error}
          <button
            onClick={() => {
              setError('')
              setRetry((n) => n + 1)
            }}
          >
            重新读取
          </button>
        </div>
      )}
      <div ref={scroll} className="queue-scroll">
        <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
          {rows.map((row) => {
            const work = cache.get(row.index)
            return (
              <button
                key={row.index}
                className={`queue-row ${row.index === queue.index ? 'current' : ''}`}
                style={{ height: row.size, transform: `translateY(${row.start}px)` }}
                onClick={() => jump(row.index)}
                aria-label={`播放队列第 ${row.index + 1} 条`}
                aria-current={row.index === queue.index ? 'true' : undefined}
              >
                <span className="queue-number">
                  {row.index === queue.index ? <Play size={11} fill="currentColor" /> : row.index + 1}
                </span>
                <span className="queue-thumb">
                  {work?.coverUrl ? (
                    <img src={work.coverUrl} alt="" loading="lazy" />
                  ) : work?.mediaType === 'gallery' ? (
                    <ImageIcon size={17} />
                  ) : (
                    <Film size={17} />
                  )}
                </span>
                <span>
                  <strong>{work?.title || (work ? '未命名作品' : '正在读取…')}</strong>
                  <small>
                    {work?.author ? `@${work.author}` : ''}
                    {work && (
                      <span>
                        {' '}
                        · {work.mediaType === 'gallery' ? (work.isLive ? '实况' : '图集') : '视频'}
                      </span>
                    )}
                  </small>
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </aside>
  )
}
