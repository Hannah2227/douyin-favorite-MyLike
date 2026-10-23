// The engine needs the page SDK, not the site's feed playback. Do not wrap fetch or XHR.
function quietMediaInPage() {
  const pause = (node: EventTarget | null) => {
    if (node instanceof HTMLMediaElement) {
      node.muted = true
      node.pause()
    }
  }
  document.querySelectorAll('video, audio').forEach(pause)
  document.addEventListener('play', (event) => pause(event.target), true)
}

export const quietMediaScript = `(${quietMediaInPage.toString()})()`
