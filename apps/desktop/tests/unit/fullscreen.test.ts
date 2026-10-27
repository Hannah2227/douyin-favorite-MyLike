import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { trackMacFullscreen } from '../../src/main/fullscreen'

function windowFixture(initial = false) {
  let fullscreen = initial
  const events = Object.assign(new EventEmitter(), { isFullScreen: () => fullscreen })
  return {
    events,
    ready: trackMacFullscreen(events as unknown as BrowserWindow),
    native(value: boolean) {
      fullscreen = value
    }
  }
}

afterEach(() => vi.useRealTimers())

describe('macOS fullscreen transition synchronization', () => {
  it('waits for native entry and exit after Chromium announces its HTML state', async () => {
    const { events, ready, native } = windowFixture()
    events.emit('enter-html-full-screen')
    native(true)
    let entered = false
    const entry = ready().then(() => {
      entered = true
    })
    await Promise.resolve()
    expect(entered).toBe(false)
    events.emit('enter-full-screen')
    await entry
    expect(entered).toBe(true)

    events.emit('leave-html-full-screen')
    native(false)
    let exited = false
    const exit = ready().then(() => {
      exited = true
    })
    await Promise.resolve()
    expect(exited).toBe(false)
    events.emit('leave-full-screen')
    await exit
    expect(exited).toBe(true)
    expect(events.listenerCount('closed')).toBe(0)
  })

  it('does not wait for an extra native transition when the window was already fullscreen', async () => {
    const { events, ready } = windowFixture(true)
    events.emit('enter-html-full-screen')
    await ready()
    events.emit('leave-html-full-screen')
    await ready()
    expect(events.listenerCount('closed')).toBe(0)
  })

  it('also waits for a native titlebar transition that is already in progress', async () => {
    const { events, ready, native } = windowFixture()
    native(true)
    let settled = false
    const wait = ready().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    events.emit('enter-full-screen')
    await wait
    expect(settled).toBe(true)
  })

  it('releases pending requests on window destruction or a missing system event', async () => {
    vi.useFakeTimers()
    const closed = windowFixture()
    closed.events.emit('enter-html-full-screen')
    const onClose = closed.ready()
    closed.events.emit('closed')
    await onClose
    expect(closed.events.listenerCount('enter-full-screen')).toBe(1)

    const timed = windowFixture()
    timed.events.emit('enter-html-full-screen')
    const timeout = timed.ready()
    await vi.advanceTimersByTimeAsync(5000)
    await timeout
    expect(timed.events.listenerCount('closed')).toBe(0)
  })
})
