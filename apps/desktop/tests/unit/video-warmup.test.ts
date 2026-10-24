import { afterEach, expect, it, vi } from 'vitest'
import { VideoWarmup } from '../../src/renderer/src/video-warmup'

function setup() {
  const videos: HTMLVideoElement[] = []
  const pool = new VideoWarmup(() => {
    const node = Object.assign(new EventTarget(), {
      src: '',
      preload: '',
      muted: false,
      volume: 1,
      playsInline: false,
      load: vi.fn(),
      pause: vi.fn(),
      removeAttribute: vi.fn()
    }) as unknown as HTMLVideoElement
    videos.push(node)
    return node
  })
  return { pool, videos }
}
afterEach(() => vi.useRealTimers())
it('promotes the same silent decoded element without assigning src or loading again', () => {
  const { pool, videos } = setup()
  pool.prepare('https://media/next.mp4')
  const video = videos[0]!
  expect(video).toMatchObject({ muted: true, volume: 0, preload: 'auto' })
  video.dispatchEvent(new Event('loadeddata'))
  expect(video.preload).toBe('metadata')
  pool.prepare('https://media/next.mp4')
  expect(videos).toHaveLength(1)
  expect(pool.take('https://media/next.mp4')).toBe(video)
  pool.clear()
  expect(video.load).toHaveBeenCalledTimes(1)
  expect(video.removeAttribute).not.toHaveBeenCalled()
})
it('bounds warmup to one item and disposes jumps, errors, expiry and explicit exits', () => {
  vi.useFakeTimers()
  const { pool, videos } = setup()
  pool.prepare('one')
  pool.prepare('two')
  expect(videos[0]!.removeAttribute).toHaveBeenCalledWith('src')
  expect(pool.take('jump')).toBeUndefined()
  expect(videos[1]!.pause).toHaveBeenCalled()
  pool.prepare('error')
  videos[2]!.dispatchEvent(new Event('error'))
  expect(pool.take('error')).toBeUndefined()
  pool.prepare('expired')
  vi.advanceTimersByTime(120000)
  expect(videos[3]!.removeAttribute).toHaveBeenCalledWith('src')
  expect(pool.take('expired')).toBeUndefined()
  pool.prepare('exit')
  pool.clear()
  expect(videos[4]!.removeAttribute).toHaveBeenCalledWith('src')
  expect(vi.getTimerCount()).toBe(0)
})
