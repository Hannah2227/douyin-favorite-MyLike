import { useLayoutEffect, useRef, type RefObject, type VideoHTMLAttributes } from 'react'

const events = {
  click: 'onClick',
  dblclick: 'onDoubleClick',
  loadedmetadata: 'onLoadedMetadata',
  play: 'onPlay',
  playing: 'onPlaying',
  pause: 'onPause',
  timeupdate: 'onTimeUpdate',
  ended: 'onEnded',
  error: 'onError'
} as const
type EventProp = (typeof events)[keyof typeof events]
type Props = Omit<VideoHTMLAttributes<HTMLVideoElement>, EventProp> & {
  [K in EventProp]?: (event: { currentTarget: HTMLVideoElement }) => void
} & {
  element?: HTMLVideoElement
  videoRef: RefObject<HTMLVideoElement | null>
  volume: number
  speed: number
}

/** Adopt the very same decoded element; assigning its src again would lose the warmup. */
export function PreparedVideo({ element, videoRef, volume, speed, ...props }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const latest = useRef(props)
  latest.current = props
  useLayoutEffect(() => {
    // Development StrictMode replays setup after disposal. Restore only a cleared
    // source; a live prepared element must retain its original buffered resource.
    const node = element ?? videoRef.current
    if (node && !node.getAttribute('src') && latest.current.src) {
      node.src = latest.current.src
      node.load()
    }
    if (!element) return
    const listeners = Object.entries(events).map(([event, prop]) => {
      const listener = () => latest.current[prop]?.({ currentTarget: element })
      element.addEventListener(event, listener)
      return () => element.removeEventListener(event, listener)
    })
    videoRef.current = element
    host.current!.append(element)
    if (element.readyState >= 1) latest.current.onLoadedMetadata?.({ currentTarget: element })
    if (element.error) latest.current.onError?.({ currentTarget: element })
    return () => {
      listeners.forEach((remove) => remove())
      element.pause()
      element.removeAttribute('src')
      element.load()
      element.remove()
      if (videoRef.current === element) videoRef.current = null
    }
  }, [element, videoRef])
  useLayoutEffect(() => {
    if (!element) return
    element.setAttribute('aria-label', props['aria-label'] ?? '当前视频')
    element.loop = !!props.loop
    element.volume = volume
    element.muted = false
    element.playbackRate = speed
    if (props.autoPlay) void element.play().catch(() => {})
  }, [element, props.autoPlay, props.loop, volume, speed])
  return element ? <div className="prepared-video" ref={host} /> : <video {...props} ref={videoRef} />
}
