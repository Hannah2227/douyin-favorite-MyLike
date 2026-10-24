/** Keep just one silent, detached next video, including its decoded first frame. */
export class VideoWarmup {
  private next: { source: string; element: HTMLVideoElement; timer: ReturnType<typeof setTimeout> } | null =
    null

  constructor(private readonly create = () => document.createElement('video')) {}

  prepare(source: string) {
    if (this.next?.source === source) return
    this.clear()
    const element = this.create()
    element.preload = 'auto'
    element.muted = true
    element.volume = 0
    element.playsInline = true
    const entry = {
      source,
      element,
      timer: setTimeout(() => {
        if (this.next === entry) this.clear()
      }, 120000)
    }
    this.next = entry
    element.addEventListener(
      'loadeddata',
      () => {
        // The prepared element never plays. Reduce buffering after the first frame;
        // the browser may still finish a request it has already issued.
        element.preload = 'metadata'
      },
      { once: true }
    )
    element.addEventListener(
      'error',
      () => {
        if (this.next === entry) this.clear()
      },
      { once: true }
    )
    element.src = source
    element.load()
  }

  take(source: string): HTMLVideoElement | undefined {
    const entry = this.next
    if (!entry || entry.source !== source) {
      this.clear()
      return
    }
    clearTimeout(entry.timer)
    this.next = null
    return entry.element
  }

  clear() {
    const entry = this.next
    this.next = null
    if (!entry) return
    clearTimeout(entry.timer)
    entry.element.pause()
    entry.element.removeAttribute('src')
    entry.element.load()
  }
}
