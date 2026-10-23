import { useEffect, useRef, useState } from 'react'
import type { Playback } from './usePlayback'

/** The fullscreen node outlives individual tracks; only opacity/transform animate. */
export function usePlayerPresentation(playback: Playback) {
  const frame = useRef<HTMLDivElement>(null)
  const latest = useRef(playback)
  latest.current = playback
  const [leaving, setLeaving] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const pending = useRef<Promise<void> | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === frame.current)
    document.addEventListener('fullscreenchange', changed)
    return () => document.removeEventListener('fullscreenchange', changed)
  }, [])
  useEffect(() => {
    if (!playback.view && document.fullscreenElement === frame.current)
      void document.exitFullscreen().catch(() => {})
  }, [!!playback.view])
  const exit = (): Promise<void> => {
    if (pending.current) return pending.current
    if (!latest.current.view) return Promise.resolve()
    const scope = latest.current.key
    latest.current.suspend()
    const request = (async () => {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {})
      setLeaving(true)
      if (
        document.documentElement.dataset.motion !== 'reduce' &&
        !window.matchMedia('(prefers-reduced-motion: reduce)').matches
      )
        await new Promise((resolve) => setTimeout(resolve, 180))
      if (latest.current.key === scope) await latest.current.exit()
    })().finally(() => {
      pending.current = null
      setLeaving(false)
      requestAnimationFrame(() => {
        if (!latest.current.view) {
          const target = returnFocus.current?.isConnected
            ? returnFocus.current
            : document.querySelector<HTMLElement>('[aria-label="搜索内容"]')
          target?.focus({ preventScroll: true })
        }
      })
    })
    pending.current = request
    return request
  }
  return {
    frame,
    leaving,
    fullscreen,
    exit,
    rememberFocus: () => {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    }
  }
}
