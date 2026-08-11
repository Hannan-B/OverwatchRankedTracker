'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

// ============================================================
// <MultiSelect> — themed multi-select dropdown (v1.1.0 Phase 2)
// ------------------------------------------------------------
// The multi-value sibling of <Select>. Same visual language, same keyboard
// model, same ow-* tokens — but the panel STAYS OPEN while you tick, because
// picking several things is the whole point:
//
//   <MultiSelect<string>
//     value={value.maps}
//     onChange={maps => onChange({ ...value, maps })}
//     options={mapOptions.map(m => ({ value: m.name, label: m.name }))}
//     allLabel="All Maps"
//     noun="maps"
//     searchable
//   />
//
// WHY A SEPARATE COMPONENT rather than a mode on <Select>. The two differ in
// their value type (T vs T[]), their onChange signature, their trigger label,
// their close-on-commit behaviour, and whether they hold a search box. Merging
// them would make the props a UNION, and a union of prop shapes is the exact
// pattern TypeScript pinned to its first branch during the Phase 1 Supabase
// work. <Select> is untouched by this file; single-value dropdowns (Queue, the
// two threshold knobs) keep working exactly as before.
//
// EMPTY MEANS ALL. `value: []` is not "nothing selected", it is "no filter" —
// every consumer reads it that way. That is why the panel carries an explicit
// "All …" row: it gives the empty state a name, and it gives you one click back
// to the default instead of unticking your way there. The row is always visible,
// including while a search is active, so the escape hatch never hides.
//
// The trigger SUMMARISES rather than lists: nothing → the All label, one → that
// option's label, more → "3 maps". Listing them overflows a pill control at
// three or four items and turns a filter into a scrollbar.
//
// EVERY row keeps the panel open, including "All". One rule, no surprises about
// which click dismisses. Esc, Tab and an outside click close it; Esc returns
// focus to the trigger.
//
// ACCESSIBILITY: button + aria-multiselectable listbox. Keyboard: Enter / Space /
// ArrowDown / ArrowUp open; arrows move the active row; Enter toggles it; Home /
// End jump; Esc closes. When searchable, focus moves into the search box on open
// and the same handler serves both elements — with one exception, documented at
// the Space case: inside the box, Space must type a space.
// ============================================================

export interface MultiSelectOption<T> {
  value: T
  label: string
  disabled?: boolean
}

export interface MultiSelectProps<T> {
  /** Selected values. `[]` = All (no filter) — see the note above. */
  value: T[]
  onChange: (value: T[]) => void
  options: MultiSelectOption<T>[]
  /** Names the empty state: the clearing row's label AND the trigger's label. */
  allLabel: string
  /** Plural noun for the summary label, e.g. 'maps' → "3 maps". */
  noun: string
  /** Show a type-ahead box inside the panel. For long lists only. */
  searchable?: boolean
  searchPlaceholder?: string
  /**
   * Trigger width. FIXED by default, not content-sized: the label changes as you
   * select ("All Heroes" → "Wrecking Ball" → "3 heroes"), and a control that
   * resizes under the cursor shoves its neighbours along the filter row every
   * time you tick something. Long labels truncate; the panel is free to be wider
   * than the trigger (`min-w-full`), so nothing becomes unreadable.
   */
  widthClass?: string
  /** Extra classes on the trigger button. */
  className?: string
  disabled?: boolean
  'aria-label'?: string
}

export default function MultiSelect<T extends string | number>({
  value,
  onChange,
  options,
  allLabel,
  noun,
  searchable = false,
  searchPlaceholder = 'Search…',
  widthClass = 'w-44',
  className = '',
  disabled = false,
  'aria-label': ariaLabel,
}: MultiSelectProps<T>) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const baseId = useId()

  const selected = useMemo(() => new Set<T>(value), [value])

  // Type-ahead narrows the OPTIONS only. The All row is not part of this list
  // and so is never filtered away.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!searchable || q === '') return options
    return options.filter(o => o.label.toLowerCase().includes(q))
  }, [options, query, searchable])

  // Row 0 is always "All …"; rows 1..n are the filtered options. Every index in
  // this component is a ROW index, not an option index — hence the ±1.
  const rowCount = filtered.length + 1

  const rowDisabled = useCallback(
    (i: number) => (i === 0 ? false : filtered[i - 1]?.disabled === true),
    [filtered],
  )

  const triggerLabel =
    value.length === 0
      ? allLabel
      : value.length === 1
        ? (options.find(o => o.value === value[0])?.label ?? `1 ${noun}`)
        : `${value.length} ${noun}`

  const close = useCallback(() => {
    setOpen(false)
    setActiveIndex(0)
    setQuery('')
  }, [])

  const openMenu = useCallback(() => {
    if (disabled) return
    setActiveIndex(0)
    setQuery('')
    setOpen(true)
  }, [disabled])

  // Move focus into the search box on open, so typing works without a second
  // click. Without a box, focus stays on the trigger and the same handler runs.
  useEffect(() => {
    if (open && searchable) searchRef.current?.focus()
  }, [open, searchable])

  // Outside click closes.
  useEffect(() => {
    if (!open) return
    function onDocPointer(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close()
    }
    document.addEventListener('pointerdown', onDocPointer)
    return () => document.removeEventListener('pointerdown', onDocPointer)
  }, [open, close])

  // A narrowed list can be shorter than the active row — reset to the top
  // rather than leave the highlight pointing past the end.
  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  // Keep the active row scrolled into view.
  useEffect(() => {
    if (!open || !listRef.current) return
    const node = listRef.current.children[activeIndex] as HTMLElement | undefined
    node?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  function moveActive(delta: number) {
    let i = activeIndex
    for (let step = 0; step < rowCount; step++) {
      i = (i + delta + rowCount) % rowCount
      if (!rowDisabled(i)) {
        setActiveIndex(i)
        return
      }
    }
  }

  /** Toggle one row. Never closes the panel — see the header note. */
  function commit(i: number) {
    if (i === 0) {
      onChange([])
      return
    }
    const opt = filtered[i - 1]
    if (!opt || opt.disabled) return
    onChange(
      selected.has(opt.value)
        ? value.filter(v => v !== opt.value)
        : [...value, opt.value],
    )
  }

  function onKeyDown(e: React.KeyboardEvent, inSearch: boolean) {
    if (disabled) return
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        openMenu()
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        moveActive(1)
        break
      case 'ArrowUp':
        e.preventDefault()
        moveActive(-1)
        break
      case 'Home':
        e.preventDefault()
        setActiveIndex(0)
        break
      case 'End':
        e.preventDefault()
        for (let i = rowCount - 1; i >= 0; i--) {
          if (!rowDisabled(i)) {
            setActiveIndex(i)
            break
          }
        }
        break
      case 'Enter':
        e.preventDefault()
        commit(activeIndex)
        break
      case ' ':
        // Inside the search box Space is a character, not a command. Everywhere
        // else it toggles, matching <Select>.
        if (inSearch) break
        e.preventDefault()
        commit(activeIndex)
        break
      case 'Escape':
        e.preventDefault()
        close()
        triggerRef.current?.focus()
        break
      case 'Tab':
        close()
        break
    }
  }

  const listboxId = `${baseId}-listbox`
  const activeOptId = `${baseId}-opt-${activeIndex}`

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={e => onKeyDown(e, false)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && !searchable ? activeOptId : undefined}
        aria-label={ariaLabel}
        className={`inline-flex items-center justify-between gap-2 rounded-lg border
          border-ow-line bg-ow-panel px-3 py-2 text-sm text-ow-fg font-display tracking-wider
          hover:border-ow-orange/60 focus:border-ow-orange focus:outline-none
          disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${widthClass} ${className}`}
      >
        <span className={`truncate ${value.length > 0 ? 'text-ow-orange' : ''}`}>{triggerLabel}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          aria-hidden="true"
          className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path
            d="M2 4l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div
          // ⚠️ CANCEL THE CLICK'S DEFAULT ACTION FOR THE WHOLE PANEL.
          //
          // Every call site wraps this control in a <label>. Clicking anywhere
          // inside a <label> forwards the click to its first labelable
          // descendant — here, the trigger button — so ticking an option fired a
          // second click on the trigger and SHUT THE PANEL. (The browser skips
          // that forwarding when you click the button itself, which is why
          // opening always worked and only the options misbehaved.) <Select>
          // never showed the bug because it closes on commit anyway.
          //
          // preventDefault here cancels the label activation for everything in
          // the panel, including the search box. It does NOT break typing:
          // focus and caret placement happen on mousedown, not click, so the
          // input still behaves normally. The row handlers below still run —
          // this cancels the browser's default action, not our own listeners.
          onClick={e => e.preventDefault()}
          className="absolute z-50 mt-1 min-w-full rounded-lg border border-ow-line
            bg-ow-panel shadow-2xl"
        >
          {searchable && (
            <div className="border-b border-ow-line p-2">
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => onKeyDown(e, true)}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                aria-controls={listboxId}
                aria-activedescendant={activeOptId}
                className="w-full rounded-md border border-ow-line bg-ow-dark px-2 py-1.5
                  text-sm text-ow-fg font-display tracking-wider placeholder-ow-faint
                  focus:border-ow-orange focus:outline-none"
              />
            </div>
          )}

          <ul
            ref={listRef}
            role="listbox"
            id={listboxId}
            aria-multiselectable="true"
            tabIndex={-1}
            className="max-h-64 overflow-auto py-1"
          >
            {/* Row 0 — the named empty state. Always present, never searched away. */}
            <li
              id={`${baseId}-opt-0`}
              role="option"
              aria-selected={value.length === 0}
              onPointerEnter={() => setActiveIndex(0)}
              onClick={() => commit(0)}
              className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-sm
                font-display tracking-wider whitespace-nowrap
                ${activeIndex === 0 ? 'bg-ow-orange/15' : ''}
                ${value.length === 0 ? 'text-ow-orange font-bold' : 'text-ow-fg'}`}
            >
              <TickBox checked={value.length === 0} />
              {allLabel}
            </li>

            {filtered.map((opt, i) => {
              const row = i + 1
              const isSelected = selected.has(opt.value)
              const isActive = row === activeIndex
              return (
                <li
                  key={`${String(opt.value)}-${i}`}
                  id={`${baseId}-opt-${row}`}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={opt.disabled || undefined}
                  onPointerEnter={() => !opt.disabled && setActiveIndex(row)}
                  onClick={() => commit(row)}
                  className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-sm
                    font-display tracking-wider whitespace-nowrap
                    ${opt.disabled ? 'opacity-40 cursor-not-allowed' : ''}
                    ${isActive ? 'bg-ow-orange/15' : ''}
                    ${isSelected ? 'text-ow-orange font-bold' : 'text-ow-fg'}`}
                >
                  <TickBox checked={isSelected} />
                  {opt.label}
                </li>
              )
            })}

            {searchable && filtered.length === 0 && (
              <li className="px-3 py-2 text-sm text-ow-faint font-display tracking-wider">
                No matches
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  )
}

/** The tick indicator. Drawn rather than a real <input type="checkbox"> so the
 *  row keeps role="option" and the listbox stays a listbox — the checkbox would
 *  put a second focusable control inside every row.
 *
 *  The tick stroke is a fixed dark literal, not a token: it only ever sits on a
 *  solid ow-orange fill, which is the same colour in both themes. That is the
 *  documented exception the v41 migration already makes for text on solid
 *  bg-ow-defeat / bg-black fills. */
function TickBox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px]
        border transition-colors
        ${checked ? 'border-ow-orange bg-ow-orange' : 'border-ow-line bg-transparent'}`}
    >
      {checked && (
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path
            d="M2 5.2l2 2L8 3"
            fill="none"
            stroke="#12141a"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </span>
  )
}
