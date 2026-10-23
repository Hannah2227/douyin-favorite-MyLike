import { useEffect, useRef, useState } from 'react'
import { playbackPreferencesSchema, type PlaybackPreferences } from '../../shared/contracts'
import { call } from './api'

export function usePlaybackPreferences(
  server: PlaybackPreferences | undefined,
  onError: (message: string) => void
) {
  const [value, setValue] = useState(() => server ?? playbackPreferencesSchema.parse({}))
  const latest = useRef(value),
    dirty = useRef(false),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const saving = useRef<Promise<unknown> | null>(null)
  useEffect(() => {
    if (server && !dirty.current) {
      latest.current = server
      setValue(server)
    }
  }, [server])
  const flush = async () => {
    clearTimeout(timer.current)
    if (saving.current) await saving.current.catch(() => {})
    if (!dirty.current) return
    const preferences = latest.current
    const request = call(window.mylike.invoke('playbackPreferences', { preferences }))
    saving.current = request
    try {
      await request
      if (latest.current === preferences) dirty.current = false
    } catch (error) {
      onError(error instanceof Error ? error.message : '播放设置未保存。')
      throw error
    } finally {
      if (saving.current === request) saving.current = null
    }
  }
  const update = (patch: Partial<PlaybackPreferences>) => {
    const next = { ...latest.current, ...patch }
    latest.current = next
    dirty.current = true
    setValue(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush().catch(() => {}), 200)
  }
  const flushRef = useRef(flush)
  flushRef.current = flush
  useEffect(() => window.mylike.onBeforeQuit(() => flushRef.current()), [])
  useEffect(() => () => clearTimeout(timer.current), [])
  return { value, update, flush }
}
