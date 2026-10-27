import type { BrowserWindow } from 'electron'

/** Chromium can report HTML fullscreen before macOS finishes its Space animation.
 * Exiting during that animation can leave document.exitFullscreen() pending forever. */
export function trackMacFullscreen(win: BrowserWindow): () => Promise<void> {
  const events: NodeJS.EventEmitter = win
  let nativeFullscreen = win.isFullScreen()
  let htmlChangesWindow = false
  let pending = Promise.resolve()
  let finish: (() => void) | null = null
  const waitFor = (event: 'enter-full-screen' | 'leave-full-screen') => {
    finish?.()
    pending = new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        events.removeListener(event, done)
        events.removeListener('closed', done)
        finish = null
        resolve()
      }
      const timer = setTimeout(done, 5000)
      timer.unref()
      finish = done
      events.once(event, done)
      events.once('closed', done)
    })
  }
  win.on('enter-full-screen', () => {
    nativeFullscreen = true
  })
  win.on('leave-full-screen', () => {
    nativeFullscreen = false
  })
  win.on('enter-html-full-screen', () => {
    htmlChangesWindow = !nativeFullscreen
    if (htmlChangesWindow) waitFor('enter-full-screen')
  })
  win.on('leave-html-full-screen', () => {
    if (htmlChangesWindow) waitFor('leave-full-screen')
    htmlChangesWindow = false
  })
  return async () => {
    if (!finish && win.isFullScreen() !== nativeFullscreen)
      waitFor(win.isFullScreen() ? 'enter-full-screen' : 'leave-full-screen')
    await pending
  }
}
