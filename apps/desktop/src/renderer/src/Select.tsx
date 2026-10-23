import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import './select.css'

type Option = { value: string; label: string; disabled?: boolean }
type Props = {
  label: string
  value: string
  options: Option[]
  onChange: (value: string) => void
  disabled?: boolean
}

/** Shared select-only combobox. The popover's top layer avoids clipping by scroll containers. */
export function Select({ label, value, options, onChange, disabled }: Props) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const typed = useRef({ text: '', at: 0 })
  const selected = options.findIndex((option) => option.value === value)
  const signature = options.map((option) => `${option.value}:${!!option.disabled}`).join('|')
  const choose = (index: number) => {
    const option = options[index]
    if (!option || option.disabled) return
    setOpen(false)
    trigger.current?.focus()
    if (option.value !== value) onChange(option.value)
  }
  useEffect(() => {
    if (disabled || !options.length) setOpen(false)
  }, [disabled, options.length])
  useEffect(() => {
    if (open) setActive(selected >= 0 ? selected : options.findIndex((option) => !option.disabled))
  }, [open, value, signature])
  useLayoutEffect(() => {
    const node = popup.current
    if (!open || !node) return
    node.showPopover()
    const position = () => {
      const rect = trigger.current!.getBoundingClientRect()
      const overlay = (
        navigator as Navigator & {
          windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect: () => DOMRect }
        }
      ).windowControlsOverlay
      const safeTop = Math.max(8, overlay?.visible ? overlay.getTitlebarAreaRect().bottom + 8 : 8)
      const above = rect.top - safeTop - 6
      const below = innerHeight - rect.bottom - 14
      const up = below < Math.min(180, options.length * 36 + 12) && above > below
      const height = Math.max(36, Math.min(320, up ? above : below))
      const width = Math.min(Math.max(rect.width, 180), innerWidth - 16)
      Object.assign(node.style, {
        width: `${width}px`,
        maxHeight: `${height}px`,
        left: `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`,
        top: `${up ? Math.max(safeTop, rect.top - Math.min(node.scrollHeight, height) - 6) : rect.bottom + 6}px`
      })
    }
    position()
    const outside = (event: Event) => {
      if (!node.contains(event.target as Node) && !trigger.current?.contains(event.target as Node))
        setOpen(false)
    }
    const scroll = (event: Event) => {
      if (!node.contains(event.target as Node)) position()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    window.addEventListener('resize', position)
    document.addEventListener('scroll', scroll, true)
    return () => {
      node.hidePopover()
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      window.removeEventListener('resize', position)
      document.removeEventListener('scroll', scroll, true)
    }
  }, [open, signature])
  useEffect(() => {
    if (open) popup.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active])
  const keydown = (event: KeyboardEvent) => {
    const enabled = options
      .map((option, index) => (option.disabled ? -1 : index))
      .filter((index) => index >= 0)
    if (!enabled.length) return
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      event.stopPropagation()
      if (!open) setOpen(true)
      else if (event.key === 'Home') setActive(enabled[0]!)
      else if (event.key === 'End') setActive(enabled.at(-1)!)
      else {
        const offset = event.key === 'ArrowDown' ? 1 : -1
        setActive(enabled[(enabled.indexOf(active) + offset + enabled.length) % enabled.length]!)
      }
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      event.stopPropagation()
      if (open) choose(active)
      else setOpen(true)
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    } else if (event.key === 'Tab') setOpen(false)
    else if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      typed.current.text = Date.now() - typed.current.at > 700 ? event.key : typed.current.text + event.key
      typed.current.at = Date.now()
      const index = options.findIndex(
        (option) =>
          !option.disabled &&
          option.label.toLocaleLowerCase().startsWith(typed.current.text.toLocaleLowerCase())
      )
      if (index >= 0) {
        event.preventDefault()
        if (!open) choose(index)
        else setActive(index)
      }
    }
  }
  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        className="select-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-controls={open ? id : undefined}
        aria-expanded={open}
        aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
        disabled={disabled || !options.length}
        onClick={() => setOpen(!open)}
        onKeyDown={keydown}
        title={options[selected]?.label}
      >
        <span>{options[selected]?.label ?? '请选择'}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div
          ref={popup}
          id={id}
          popover="manual"
          role="listbox"
          aria-label={label}
          className="select-popup"
          onPointerDown={(event) => event.preventDefault()}
        >
          {options.map((option, index) => (
            <div
              key={option.value}
              role="option"
              id={`${id}-${index}`}
              data-index={index}
              aria-selected={option.value === value}
              aria-disabled={!!option.disabled}
              className={`select-option${index === active ? ' is-active' : ''}`}
              onPointerMove={() => {
                if (!option.disabled) setActive(index)
              }}
              onClick={() => choose(index)}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={14} />}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
