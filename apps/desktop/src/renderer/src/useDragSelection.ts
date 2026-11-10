import { useEffect, useRef, type MouseEvent, type PointerEvent, type RefObject } from 'react'

type Point = { x: number; y: number }
type Gesture = {
  pointerId: number
  grid: HTMLDivElement
  start: Point
  last: Point
  firstId: string
  visited: Set<string>
}

const workId = (target: Element | null) => target?.closest<HTMLElement>('[data-work-id]')?.dataset.workId

export function useDragSelection(
  enabled: boolean,
  add: (ids: string[]) => void,
  scroll: RefObject<HTMLDivElement | null>,
  toolbar: RefObject<HTMLDivElement | null>
) {
  const gesture = useRef<Gesture | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const suppressClick = useRef(false)
  const addCurrent = useRef(add)
  addCurrent.current = add

  const finish = () => {
    const drag = gesture.current
    gesture.current = null
    clearInterval(timer.current)
    timer.current = undefined
    if (drag?.grid.hasPointerCapture(drag.pointerId)) drag.grid.releasePointerCapture(drag.pointerId)
  }
  const stop = (event: PointerEvent) => {
    if (gesture.current?.pointerId === event.pointerId) finish()
  }
  useEffect(() => {
    if (!enabled) return
    window.addEventListener('blur', finish)
    return () => {
      window.removeEventListener('blur', finish)
      finish()
    }
  }, [enabled])

  const mark = (drag: Gesture, id: string | undefined, ids: string[]) => {
    if (id && !drag.visited.has(id)) {
      drag.visited.add(id)
      ids.push(id)
    }
  }
  const hit = (drag: Gesture, x: number, y: number, ids: string[]) => {
    const target = document.elementFromPoint(x, y)
    if (target && drag.grid.contains(target)) mark(drag, workId(target), ids)
  }
  const autoScroll = () => {
    const drag = gesture.current
    const root = scroll.current
    if (!drag || !root) return
    const bounds = root.getBoundingClientRect()
    const top = Math.max(bounds.top, toolbar.current?.getBoundingClientRect().bottom ?? bounds.top)
    const { x, y } = drag.last
    if (
      x >= bounds.left &&
      x < bounds.right &&
      top < bounds.bottom &&
      y >= top - 80 &&
      y <= bounds.bottom + 80
    ) {
      const edge = Math.min(68, (bounds.bottom - top) / 2)
      const direction = y < top + edge ? -1 : y > bounds.bottom - edge ? 1 : 0
      if (direction) {
        const ids: string[] = []
        hit(drag, x, Math.max(top + 2, Math.min(bounds.bottom - 2, y)), ids)
        if (ids.length) addCurrent.current(ids)
        const distance = direction < 0 ? top + edge - y : y - bounds.bottom + edge
        root.scrollTop += direction * Math.min(24, Math.max(2, distance * 0.36))
      }
    }
  }

  return {
    onPointerDown(event: PointerEvent<HTMLDivElement>) {
      suppressClick.current = false
      if (!enabled || event.pointerType !== 'mouse' || event.button !== 0) return
      const id = workId(event.target instanceof Element ? event.target : null)
      if (!id) return
      const point = { x: event.clientX, y: event.clientY }
      gesture.current = {
        pointerId: event.pointerId,
        grid: event.currentTarget,
        start: point,
        last: point,
        firstId: id,
        visited: new Set()
      }
    },
    onPointerMove(event: PointerEvent<HTMLDivElement>) {
      const drag = gesture.current
      if (!drag || drag.pointerId !== event.pointerId) return
      if (!enabled || !(event.buttons & 1)) {
        finish()
        return
      }
      const point = { x: event.clientX, y: event.clientY }
      const ids: string[] = []
      if (!suppressClick.current) {
        if (Math.hypot(point.x - drag.start.x, point.y - drag.start.y) < 5) return
        suppressClick.current = true
        drag.grid.setPointerCapture(event.pointerId)
        mark(drag, drag.firstId, ids)
        timer.current = setInterval(autoScroll, 16)
      }
      const dx = point.x - drag.last.x
      const dy = point.y - drag.last.y
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 24))
      for (let step = 1; step <= steps; step++)
        hit(drag, drag.last.x + (dx * step) / steps, drag.last.y + (dy * step) / steps, ids)
      drag.last = point
      if (ids.length) add(ids)
    },
    onPointerUp: stop,
    onPointerCancel: stop,
    onLostPointerCapture: stop,
    onPointerLeave(event: PointerEvent<HTMLDivElement>) {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) stop(event)
    },
    onClickCapture(event: MouseEvent) {
      if (suppressClick.current && event.detail > 0) {
        suppressClick.current = false
        event.preventDefault()
        event.stopPropagation()
      }
    }
  }
}
