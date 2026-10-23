import { useEffect, useRef, type RefObject } from 'react'
import type { PlaybackPreferences } from '../../shared/contracts'
import type { ShortcutAction } from '../../shared/preferences'

export function usePlayerShortcuts(
  shortcuts: PlaybackPreferences['shortcuts'],
  actions: Record<ShortcutAction, () => void>,
  root: RefObject<HTMLElement | null>,
  back: () => void
) {
  const current = useRef(actions)
  const exit = useRef(back)
  current.current = actions
  exit.current = back
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        root.current?.closest('[inert]') ||
        document.querySelector('dialog[open]') ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        event.repeat ||
        (event.target instanceof HTMLElement &&
          (event.target.isContentEditable ||
            ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) ||
            !!event.target.closest('[role=combobox], [role=listbox], [role=menu]') ||
            (['Space', 'Enter'].includes(event.code) && !!event.target.closest('button,summary'))))
      )
        return
      if (event.code === 'Escape') {
        event.preventDefault()
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
        else exit.current()
        return
      }
      const action =
        event.code === 'PageUp'
          ? 'previous'
          : event.code === 'PageDown'
            ? 'next'
            : (Object.keys(shortcuts) as ShortcutAction[]).find((id) => shortcuts[id] === event.code)
      if (action) {
        event.preventDefault()
        current.current[action]()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [shortcuts, root])
}
