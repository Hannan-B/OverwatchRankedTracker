'use client'

import { useEffect, useId, useRef, useState, useCallback } from 'react'

// ============================================================
// <Select> — custom themed dropdown (NEXT-STEPS #16)
// ------------------------------------------------------------
// Replaces native <select> app-wide. Generic over the value type so unions stay
// type-safe end to end (no `as ChartType` casts at call sites):
//
//   <Select<QueueFilter>
//     value={value.queue}
//     onChange={q => changeQueue(q)}
//     options={[
//       { value: 'all', label: 'All Queues' },
//       { value: 'tank', label: 'Tank' }, ...
//     ]}
//   />
//
// Numeric values work the same: <Select<number> options={[{value:5,label:'5+'}]} … />.
//
// VISUAL: matches the in-game career dropdown (image 3) — pill-ish control with a
// chevron; on open, a panel of rows with the selected row highlighted. Fully
// themed via the ow-* tokens (works in light + dark automatically).
//
// ACCESSIBILITY: button + listbox pattern. Keyboard: Enter/Space/ArrowDown opens;
// ArrowUp/Down move the active row; Enter/Space selects; Esc closes; Home/End
// jump. Closes on outside click and on blur out of the widget. aria-activedescendant
// tracks the active option; roles are listbox/option.
//
// NOTE: deliberately NOT inside a <form>; uses onClick/keydown, no submit.
// ============================================================

export interface SelectOption<T> {
  value: T
  label: string
  disabled?: boolean
}

export interface SelectProps<T> {
  value: T
  onChange: (value: T) => void
  options: SelectOption<T>[]
  /** Shown when no option matches `value` (shouldn't normally happen). */
  placeholder?: string
  /** Extra classes on the trigger button (e.g. width). */
  className?: string
  disabled?: boolean
  'aria-label'?: string
}

export default function Select<T extends string | number>({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  className = '',
  disabled = false,
  'aria-label': ariaLabel,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState<number>(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const baseId = useId()

  const selectedIndex = options.findIndex(o => o.value === value)
  const selectedLabel = selectedIndex >= 0 ? options[selectedIndex].label : placeholder

  const close = useCallback(() => {
    setOpen(false)
    setActiveIndex(-1)
  }, [])

  // Open: seed the active row to the current selection (or first enabled).
  const openMenu = useCallback(() => {
    if (disabled) return
    const seed = selectedIndex >= 0 ? selectedIndex : options.findIndex(o => !o.disabled)
    setActiveIndex(seed)
    setOpen(true)
  }, [disabled, selectedIndex, options])

  // Outside click closes.
  useEffect(() => {
    if (!open) return
    function onDocPointer(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close()
    }
    document.addEventListener('pointerdown', onDocPointer)
    return () => document.removeEventListener('pointerdown', onDocPointer)
  }, [open, close])

  // Keep the active row scrolled into view.
  useEffect(() => {
    if (!open || activeIndex < 0 || !listRef.current) return
    const node = listRef.current.children[activeIndex] as HTMLElement | undefined
    node?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  function moveActive(delta: number) {
    if (options.length === 0) return
    let i = activeIndex
    for (let step = 0; step < options.length; step++) {
      i = (i + delta + options.length) % options.length
      if (!options[i]?.disabled) { setActiveIndex(i); return }
    }
  }

  function commit(i: number) {
    const opt = options[i]
    if (!opt || opt.disabled) return
    onChange(opt.value)
    close()
  }

  function onTriggerKeyDown(e: React.KeyboardEvent) {
    if (disabled) return
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        openMenu()
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); moveActive(1); break
      case 'ArrowUp': e.preventDefault(); moveActive(-1); break
      case 'Home': e.preventDefault(); setActiveIndex(options.findIndex(o => !o.disabled)); break
      case 'End': e.preventDefault(); {
        for (let i = options.length - 1; i >= 0; i--) if (!options[i].disabled) { setActiveIndex(i); break }
      } break
      case 'Enter':
      case ' ': e.preventDefault(); if (activeIndex >= 0) commit(activeIndex); break
      case 'Escape': e.preventDefault(); close(); break
      case 'Tab': close(); break
    }
  }

  const listboxId = `${baseId}-listbox`
  const activeOptId = activeIndex >= 0 ? `${baseId}-opt-${activeIndex}` : undefined

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onTriggerKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={`inline-flex items-center justify-between gap-2 rounded-lg border
          border-ow-line bg-ow-panel px-3 py-2 text-sm text-ow-fg font-display tracking-wider
          hover:border-ow-orange/60 focus:border-ow-orange focus:outline-none
          disabled:opacity-40 disabled:cursor-not-allowed transition-colors min-w-[8rem] ${className}`}
      >
        <span className="truncate">{selectedLabel}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"
          className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5"
            strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <ul
          ref={listRef}
          role="listbox"
          id={listboxId}
          tabIndex={-1}
          aria-activedescendant={activeOptId}
          className="absolute z-50 mt-1 max-h-64 min-w-full overflow-auto rounded-lg border
            border-ow-line bg-ow-panel py-1 shadow-2xl"
        >
          {options.map((opt, i) => {
            const isSelected = opt.value === value
            const isActive = i === activeIndex
            return (
              <li
                key={`${String(opt.value)}-${i}`}
                id={`${baseId}-opt-${i}`}
                role="option"
                aria-selected={isSelected}
                aria-disabled={opt.disabled || undefined}
                onPointerEnter={() => !opt.disabled && setActiveIndex(i)}
                onClick={() => commit(i)}
                className={`cursor-pointer px-3 py-2 text-sm font-display tracking-wider whitespace-nowrap
                  ${opt.disabled ? 'opacity-40 cursor-not-allowed' : ''}
                  ${isActive ? 'bg-ow-orange/15' : ''}
                  ${isSelected ? 'text-ow-orange font-bold' : 'text-ow-fg'}`}
              >
                {opt.label}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
