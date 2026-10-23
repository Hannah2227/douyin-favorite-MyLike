import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

const rates = [0.75, 1, 1.25, 1.5, 1.75, 2, 3]
const rateLabel = (rate: number) => `${Number.isInteger(rate) ? rate.toFixed(1) : rate}x`

export function SpeedMenu({
  value,
  change,
  hint
}: {
  value: number
  change: (value: number) => void
  hint?: string
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    const focus = (event: FocusEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', focus)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', focus)
    }
  }, [open])
  return (
    <div
      className="speed-control"
      ref={root}
      onKeyDown={(event) => {
        if (!open) return
        event.stopPropagation()
        if (event.key === 'Escape') {
          event.preventDefault()
          setOpen(false)
          trigger.current?.focus()
        } else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          const options = Array.from(
            root.current!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
          )
          const index = options.indexOf(document.activeElement as HTMLButtonElement)
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? options.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
          options[next]?.focus()
        }
      }}
    >
      <button
        ref={trigger}
        className="speed-trigger"
        aria-label="倍速"
        title={hint}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (['ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault()
            event.stopPropagation()
            setOpen(true)
          }
        }}
      >
        {value === 1 ? '倍速' : rateLabel(value)}
      </button>
      {open && (
        <div id={id} role="menu" aria-label="播放倍速" className="speed-menu">
          {(rates.includes(value) ? rates : [...rates, value].sort((a, b) => a - b)).map((rate) => (
            <button
              key={rate}
              role="menuitemradio"
              tabIndex={-1}
              aria-checked={rate === value}
              onClick={() => {
                change(rate)
                setOpen(false)
                trigger.current?.focus()
              }}
            >
              {rateLabel(rate)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function SeekBar({
  label,
  value,
  duration,
  disabled,
  change
}: {
  label: string
  value: number
  duration: number
  disabled?: boolean
  change: (value: number) => void
}) {
  const progress = duration ? Math.max(0, Math.min(100, (value / duration) * 100)) : 0
  return (
    <div className="seek-bar" style={{ '--progress': `${progress}%` } as CSSProperties}>
      <div className="seek-track" />
      <input
        aria-label={label}
        type="range"
        min="0"
        max={duration || 1}
        step=".1"
        value={Math.min(value, duration || 1)}
        disabled={disabled || !duration}
        onChange={(event) => change(Number(event.target.value))}
      />
    </div>
  )
}

export function MediaCaption({
  author,
  title,
  publishedAt,
  gallery,
  expanded,
  toggle,
  hint
}: {
  author: string
  title: string
  publishedAt: number
  gallery: boolean
  expanded: boolean
  toggle: () => void
  hint: string
}) {
  const [overflow, setOverflow] = useState(false)
  const text = useRef<HTMLParagraphElement>(null)
  const id = useId()
  useLayoutEffect(() => {
    const node = text.current
    if (!node || expanded) return
    node.scrollTop = 0
    const measure = () => setOverflow(node.scrollHeight > node.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [title, expanded])
  const date = publishedAt > 0 ? new Date(publishedAt * 1000) : null
  return (
    <div className="media-caption">
      <div className="caption-author">
        <strong>@{author || '未知作者'}</strong>
        {date && Number.isFinite(date.getTime()) && (
          <time dateTime={date.toISOString()}>
            · {date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })}
          </time>
        )}
        {gallery && <span className="gallery-badge">图文</span>}
      </div>
      <div className={`caption-text${expanded ? ' expanded' : ''}`}>
        <p ref={text} id={id}>
          {title || '未命名作品'}
        </p>
        {(overflow || expanded) && (
          <button title={hint} aria-expanded={expanded} aria-controls={id} onClick={toggle}>
            {expanded ? '收起' : '展开'}
          </button>
        )}
      </div>
    </div>
  )
}
