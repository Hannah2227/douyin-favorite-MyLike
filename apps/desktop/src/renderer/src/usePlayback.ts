import { useEffect, useRef, useState } from 'react'
import type { Media, PlaybackPosition, QueueCreate, QueueState } from '../../shared/contracts'
import { call, CommandError } from './api'

const key = (queue: QueueState) => `${queue.accountId}:${queue.queueId}:${queue.revision}`
type View = { queue: QueueState; media: Media | null; error: string }
type Cache = { scope: string; expires: number; media?: Media; promise?: Promise<Media> }
export function usePlayback(
  accountId: string | null,
  onError: (message: string) => void,
  onExited: () => void
) {
  const [view, setView] = useState<View | null>(null)
  const current = useRef<View | null>(null),
    intent = useRef(0),
    cache = useRef(new Map<string, Cache>())
  const activeIntent = useRef(0)
  const wheelAt = useRef(0)
  const position = useRef<{ key: string; value: PlaybackPosition } | null>(null),
    reader = useRef<{ key: string; read: () => PlaybackPosition; suspend: () => void } | null>(null)
  const sequence = useRef(0),
    lastSave = useRef(0),
    saving = useRef<Promise<unknown> | null>(null)
  const set = (next: View | null) => {
    current.current = next
    setView(next)
  }
  const readPosition = () => {
    const queue = current.current?.queue
    if (!queue) return null
    const scope = key(queue)
    return reader.current?.key === scope
      ? reader.current.read()
      : position.current?.key === scope
        ? position.current.value
        : queue.position
  }
  const flush = async () => {
    const queue = current.current?.queue,
      value = readPosition()
    if (!queue || !value || queue.completed) return
    const seq = ++sequence.current,
      scope = key(queue)
    const request = call(
      window.mylike.invoke('queueProgress', {
        accountId: queue.accountId,
        queueId: queue.queueId,
        revision: queue.revision,
        sequence: seq,
        position: value
      })
    )
    saving.current = request
    try {
      await request
    } catch (error) {
      if (
        !(
          error instanceof CommandError &&
          ['QUEUE_CHANGED', 'ACCOUNT_CHANGED', 'CLOSING'].includes(error.code)
        ) &&
        current.current &&
        key(current.current.queue) === scope
      )
        onError(error instanceof Error ? error.message : '播放位置未保存。')
    } finally {
      if (saving.current === request) saving.current = null
    }
  }
  const flushRef = useRef(flush)
  flushRef.current = flush
  useEffect(
    () =>
      window.mylike.onBeforeQuit(async () => {
        reader.current?.suspend()
        await flushRef.current()
      }),
    []
  )
  useEffect(() => {
    intent.current++
    current.current = null
    setView(null)
    reader.current = null
    cache.current.clear()
  }, [accountId])
  const getMedia = (queue: QueueState, workId: string): Promise<Media> => {
    const cacheKey = `${queue.accountId}:${workId}`,
      scope = key(queue),
      old = cache.current.get(cacheKey)
    if (old && old.expires > Date.now()) {
      if (old.media) return Promise.resolve(old.media)
      if (old.scope === scope && old.promise) return old.promise
    }
    const entry: Cache = { scope, expires: Date.now() + 120000 }
    cache.current.set(cacheKey, entry)
    while (cache.current.size > 2) cache.current.delete(cache.current.keys().next().value!)
    entry.promise = call(
      window.mylike.invoke('media', {
        accountId: queue.accountId,
        workId,
        playback: { queueId: queue.queueId, revision: queue.revision }
      })
    )
      .then((media) => {
        entry.media = media
        return media
      })
      .catch((error) => {
        if (cache.current.get(cacheKey) === entry) cache.current.delete(cacheKey)
        throw error
      })
    return entry.promise
  }
  const load = async (queue: QueueState, seq: number) => {
    if (seq !== intent.current) return
    activeIntent.current = seq
    if (position.current?.key !== key(queue)) sequence.current = 0
    lastSave.current = 0
    position.current = { key: key(queue), value: queue.position }
    set({ queue, media: null, error: '' })
    try {
      let media: Media | undefined
      for (let retry = 0; retry < 2; retry++) {
        try {
          media = await getMedia(queue, queue.work.id)
          break
        } catch (error) {
          if (seq !== intent.current) return
          if (
            retry ||
            !(error instanceof CommandError) ||
            !['NETWORK_ERROR', 'TIMEOUT', 'PAGE_CHANGED'].includes(error.code)
          )
            throw error
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }
      }
      if (seq !== intent.current || !media) return
      set({ queue, media, error: '' })
      if (queue.next && !queue.completed) void getMedia(queue, queue.next.id).catch(() => {})
    } catch (error) {
      if (seq === intent.current)
        set({ queue, media: null, error: error instanceof Error ? error.message : '未能取得播放地址。' })
    }
  }
  const start = async (source: QueueCreate['source'], mode: QueueCreate['mode'], startWorkId?: string) => {
    if (!accountId) return
    const seq = ++intent.current
    const queue = await call(window.mylike.invoke('queueCreate', { accountId, source, mode, startWorkId }))
    if (seq === intent.current) await load(queue, seq)
  }
  const resume = async (queue: QueueState) => {
    const seq = ++intent.current
    const next = await call(
      window.mylike.invoke('queueResume', { accountId: queue.accountId, queueId: queue.queueId })
    )
    if (seq === intent.current) await load(next, seq)
  }
  const move = async (target: 'next' | 'previous' | number) => {
    const queue = current.current?.queue
    if (!queue) return
    const seq = ++intent.current
    try {
      const next = await call(
        window.mylike.invoke('queueMove', { accountId: queue.accountId, queueId: queue.queueId, target })
      )
      if (seq === intent.current) await load(next, seq)
    } catch (error) {
      if (seq === intent.current) {
        try {
          const snapshot = await call(window.mylike.invoke('snapshot', {}))
          if (seq === intent.current && snapshot.playback?.accountId === queue.accountId)
            await load(snapshot.playback, seq)
        } catch {
          activeIntent.current = seq
        }
        onError(error instanceof Error ? error.message : '未能切换作品。')
      }
    }
  }
  const ended = async (value: PlaybackPosition, advance: boolean, expectedScope: string) => {
    const queue = current.current?.queue
    if (!queue || key(queue) !== expectedScope || activeIntent.current !== intent.current) return
    const seq = ++intent.current
    try {
      const next = await call(
        window.mylike.invoke('queueEnd', {
          accountId: queue.accountId,
          queueId: queue.queueId,
          revision: queue.revision,
          position: value,
          advance
        })
      )
      if (seq === intent.current) await load(next, seq)
    } catch (error) {
      if (seq === intent.current) {
        activeIntent.current = seq
        onError(error instanceof Error ? error.message : '播放结果未保存。')
      }
    }
  }
  const replay = async () => {
    const queue = current.current?.queue
    if (!queue) return
    const seq = ++intent.current
    try {
      const next = await call(
        window.mylike.invoke('queueReplay', {
          accountId: queue.accountId,
          queueId: queue.queueId,
          revision: queue.revision
        })
      )
      if (seq === intent.current) await load(next, seq)
    } catch (error) {
      if (seq === intent.current) onError(error instanceof Error ? error.message : '未能重新播放。')
    }
  }
  const retry = () => {
    const currentView = current.current
    if (!currentView) return
    const value = readPosition() ?? currentView.queue.position,
      queue = { ...currentView.queue, position: value }
    cache.current.delete(`${queue.accountId}:${queue.work.id}`)
    void load(queue, ++intent.current)
  }
  const exit = async () => {
    const queue = current.current?.queue
    const seq = ++intent.current
    reader.current?.suspend()
    await flush()
    if (queue)
      try {
        await call(
          window.mylike.invoke('cancelMedia', {
            accountId: queue.accountId,
            queueId: queue.queueId,
            revision: queue.revision
          })
        )
      } catch (error) {
        if (!(
          error instanceof CommandError &&
          ['QUEUE_CHANGED', 'ACCOUNT_CHANGED', 'CLOSING'].includes(error.code)
        ))
          onError(error instanceof Error ? error.message : '旧取链未能取消。')
      }
    if (seq === intent.current) {
      set(null)
      reader.current = null
      onExited()
    }
  }
  const report = (scope: string, value: PlaybackPosition) => {
    if (!current.current || key(current.current.queue) !== scope || activeIntent.current !== intent.current)
      return
    position.current = { key: scope, value }
    if (!saving.current && Date.now() - lastSave.current >= 2000) {
      lastSave.current = Date.now()
      void flush()
    }
  }
  const registerReader = (scope: string, read: () => PlaybackPosition, suspend: () => void) => {
    const entry = { key: scope, read, suspend }
    reader.current = entry
    return () => {
      if (reader.current === entry) reader.current = null
    }
  }
  const original = async (expectedScope: string) => {
    const queue = current.current?.queue
    if (!queue || key(queue) !== expectedScope || activeIntent.current !== intent.current) return
    await flush()
    if (!current.current || key(current.current.queue) !== key(queue)) return
    await call(
      window.mylike.invoke('original', {
        accountId: queue.accountId,
        workId: queue.work.id,
        playback: { queueId: queue.queueId, revision: queue.revision }
      })
    )
  }
  return {
    view,
    start,
    resume,
    move,
    ended,
    replay,
    retry,
    exit,
    suspend: () => reader.current?.suspend(),
    report,
    registerReader,
    original,
    acceptWheel: () => {
      if (Date.now() - wheelAt.current < 700) return false
      wheelAt.current = Date.now()
      return true
    },
    isCurrent: (scope: string) =>
      !!current.current && key(current.current.queue) === scope && activeIntent.current === intent.current,
    key: view ? key(view.queue) : ''
  }
}
export type Playback = ReturnType<typeof usePlayback>
