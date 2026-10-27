import { call } from './api'

let transition: Promise<void> = Promise.resolve()
function changeFullscreen(change: () => Promise<void>): Promise<void> {
  const next = transition.then(async () => {
    await call(window.mylike.invoke('fullscreenReady', {}))
    await change()
    await call(window.mylike.invoke('fullscreenReady', {}))
  })
  transition = next.catch(() => {})
  return next
}

export function exitPlayerFullscreen(): Promise<void> {
  return changeFullscreen(async () => {
    if (document.fullscreenElement) await document.exitFullscreen()
  })
}

export function togglePlayerFullscreen(root: HTMLElement | null): Promise<void> {
  return changeFullscreen(async () => {
    if (document.fullscreenElement) await document.exitFullscreen()
    else if (root?.isConnected) await root.requestFullscreen()
  })
}
