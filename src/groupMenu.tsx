/**
 * The group menu shared by the contact page and the edit form, drawn like
 * Calendar's group select (23 Nov): No group, then the main groups with their
 * colour dot, a group with subgroups opening a submenu of them. A contact can
 * carry several groups, so a pick adds or removes that group and No group clears
 * them all.
 */
import type { ReactElement } from 'react'
import type { UiMenuItem } from '@valley/plugin-sdk'
import { paletteCssValue } from '@valley/plugin-sdk/palette'
import { React, api } from './runtime'
import { normalizeGroupName } from './data'
import { getContactGroups } from './groups'
import { uiText } from './localization'
import { Plus } from './icons'

function menuDot(color: string): ReactElement {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      <circle cx="5" cy="5" r="5" style={{ fill: paletteCssValue(color) }} />
    </svg>
  )
}

export async function openGroupMenu(anchor: HTMLElement, selected: readonly string[], onChange: (groups: string[]) => void): Promise<void> {
  const groups = getContactGroups(api)
  const chosen = new Set(selected.map(normalizeGroupName))
  const toggle = (name: string): void => {
    const key = normalizeGroupName(name)
    onChange(chosen.has(key) ? selected.filter((group) => normalizeGroupName(group) !== key) : [...selected, name])
  }
  const item = (group: { id: string; name: string; color: string }): UiMenuItem => ({
    id: `group:${group.id}`,
    label: group.name,
    icon: menuDot(group.color),
    type: 'checkbox',
    checked: chosen.has(normalizeGroupName(group.name)),
    onSelect: () => toggle(group.name)
  })
  const mainGroups = groups.filter((group) => !group.parent || !groups.some((candidate) => candidate.id === group.parent))
  const items: UiMenuItem[] = [
    { id: 'group:none', label: uiText('contacts.group.none'), type: 'checkbox', checked: chosen.size === 0, onSelect: () => onChange([]) },
    ...mainGroups.map((group): UiMenuItem => {
      const subgroups = groups.filter((candidate) => candidate.parent === group.id)
      return { ...item(group), ...(subgroups.length > 0 ? { submenu: subgroups.map(item) } : {}) }
    })
  ]
  await api.ui.openMenu(items, { anchor, align: 'start' })
}

/** The quiet `+ Group` text button that opens the group menu. */
export function GroupMenuButton({ selected, disabled, onChange }: { selected: readonly string[]; disabled?: boolean; onChange: (groups: string[]) => void }): ReactElement {
  const ref = React.useRef<HTMLButtonElement>(null)
  const openRef = React.useRef(false)
  const swallowClick = React.useRef(false)
  const [open, setOpen] = React.useState(false)
  const show = async (): Promise<void> => {
    const anchor = ref.current
    if (!anchor || disabled || openRef.current) return
    openRef.current = true
    setOpen(true)
    try { await openGroupMenu(anchor, selected, onChange) } finally { openRef.current = false; setOpen(false) }
  }
  return (
    <button
      ref={ref}
      type="button"
      className="ct-chip-add"
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={disabled}
      onMouseDown={() => { swallowClick.current = openRef.current }}
      onClick={() => { const swallow = swallowClick.current; swallowClick.current = false; if (!swallow) void show() }}
      onKeyDown={(event) => { if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return; event.preventDefault(); void show() }}
    >
      <Plus /> {uiText('auto.171a0606f7c7')}
    </button>
  )
}

