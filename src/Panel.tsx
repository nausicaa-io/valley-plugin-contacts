import type { ReactElement } from 'react'
import { React, api } from './runtime'
import { useContacts, getStore } from './store'
import { paletteCssValue } from '@valley/plugin-sdk/palette'
import { ALL, UNCATEGORIZED, filterBySelectedGroups, groupColorFor, pickGroup } from './data'
import type { Contact, ContactGroup, GroupNode } from './types'
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Plus, Search, User, X } from './icons'
import { contactSubtitle, initials, searchHaystack } from './util'
import { avatarSource } from './DetailView'
import { uiText } from './localization'
import { useCollapsedGroups, useGroupsSectionFolded, useShowGroupsInList } from './groups'

/** Group chips shown under a name; the rest fold into a +N chip. */
const MAX_TAGS = 3

/**
 * The Groups section of the sidebar (17 Nov), replacing the header's filter
 * popover: All contacts, every listed group with its subgroups one step in, then
 * No group. A click shows that group alone (a group covers its subgroups), a
 * second click or All contacts shows everyone again; Shift- or ⌘-click adds or
 * removes exactly the clicked group. The title folds the section and keeps the
 * selection in view; both fold states are saved.
 */
function GroupsSection({ tree, groupConfigs, selected, onSelect }: {
  tree: GroupNode[]
  groupConfigs: ContactGroup[]
  selected: string[]
  onSelect: (selected: string[]) => void
}): ReactElement | null {
  const [folded, setFolded] = useGroupsSectionFolded()
  const [collapsedIds, setCollapsedIds] = useCollapsedGroups()
  const [focusId, setFocusId] = React.useState<string | null>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const listId = React.useId()
  const groups = tree.filter((node) => node.id !== ALL && node.id !== UNCATEGORIZED)
  const all = tree.find((node) => node.id === ALL)
  const ungrouped = tree.find((node) => node.id === UNCATEGORIZED)
  const collapsed = new Set(collapsedIds)
  const hasSubgroups = (node: GroupNode): boolean => groups.some((candidate) => candidate.parent === node.id)
  const foldable = groups.filter((node) => node.key && hasSubgroups(node)).map((node) => node.key!)
  const allFolded = foldable.length > 0 && foldable.every((key) => collapsed.has(key))
  const parentOf = (node: GroupNode): GroupNode | undefined => node.parent ? groups.find((candidate) => candidate.id === node.parent) : undefined
  const rows = [
    ...(all ? [all] : []),
    ...groups.filter((node) => { const parent = parentOf(node); return !(parent?.key && collapsed.has(parent.key)) }),
    ...(ungrouped ? [ungrouped] : [])
  ]
  if (!groups.length) return null

  const isActive = (node: GroupNode): boolean => node.id === ALL ? selected.length === 0 : selected.includes(node.id)
  const current = rows.find((node) => node.id === focusId) ?? rows.find(isActive) ?? rows[0]
  const labelOf = (node: GroupNode): string => node.id === ALL ? uiText('contacts.groups.allContacts') : node.label
  const summary = selected.length === 1
    ? labelOf(tree.find((node) => node.id === selected[0]) ?? { id: selected[0], label: selected[0], count: 0 })
    : selected.length > 1 ? uiText('contacts.groups.selected', { p0: selected.length }) : ''
  const toggleFold = (node: GroupNode): void => {
    if (!node.key) return
    setCollapsedIds(collapsed.has(node.key) ? collapsedIds.filter((key) => key !== node.key) : [...collapsedIds, node.key])
  }
  const focusRow = (node: GroupNode | undefined): void => {
    if (!node) return
    setFocusId(node.id)
    const target = [...(listRef.current?.querySelectorAll<HTMLElement>('.ct-groups-row') ?? [])].find((row) => row.dataset.groupId === node.id)
    target?.focus()
  }
  const onRowKey = (event: React.KeyboardEvent<HTMLButtonElement>, node: GroupNode, index: number): void => {
    const folds = Boolean(node.key && hasSubgroups(node))
    const shut = folds && collapsed.has(node.key!)
    const move = (next: GroupNode | undefined): void => { event.preventDefault(); focusRow(next) }
    switch (event.key) {
      case 'ArrowDown': move(rows[index + 1]); break
      case 'ArrowUp': move(rows[index - 1]); break
      case 'Home': move(rows[0]); break
      case 'End': move(rows.at(-1)); break
      case 'ArrowRight':
        if (shut) { event.preventDefault(); toggleFold(node) } else if (folds) move(rows[index + 1])
        break
      case 'ArrowLeft':
        if (folds && !shut) { event.preventDefault(); toggleFold(node) } else if (node.parent) move(parentOf(node))
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        onSelect(pickGroup(selected, node.id, event.shiftKey || api.ui.hasModKey(event)))
        break
    }
  }

  return (
    <section className={`ct-groups${folded ? ' folded' : ''}`} aria-label={uiText('auto.ae9629f4ebb8')}>
      <div className="ct-groups-head">
        <button
          type="button"
          className="ct-groups-title"
          aria-expanded={!folded}
          aria-controls={listId}
          onClick={() => setFolded(!folded)}
        >
          <span className="ct-groups-chevron" aria-hidden="true">{folded ? <ChevronRight /> : <ChevronDown />}</span>
          <span className="ct-groups-name">{uiText('auto.ae9629f4ebb8')}</span>
          {summary && <span className="ct-groups-summary">· {summary}</span>}
        </button>
        {selected.length > 0 && (
          <button
            type="button"
            className="panel-tool-btn ct-groups-clear"
            aria-label={uiText('contacts.groups.clear')}
            title={uiText('contacts.groups.clear')}
            onClick={() => onSelect([])}
          >
            <X />
          </button>
        )}
        {!folded && foldable.length > 0 && (
          <button
            type="button"
            className="panel-tool-btn ct-groups-fold-all"
            aria-label={uiText(allFolded ? 'contacts.groups.expandAll' : 'contacts.groups.collapseAll')}
            title={uiText(allFolded ? 'contacts.groups.expandAll' : 'contacts.groups.collapseAll')}
            onClick={() => setCollapsedIds(allFolded ? [] : foldable)}
          >
            {allFolded ? <ChevronsUpDown /> : <ChevronsDownUp />}
          </button>
        )}
      </div>
      {!folded && (
        <div className="ct-groups-list" id={listId} ref={listRef} role="group" aria-label={uiText('auto.ae9629f4ebb8')}>
          {rows.map((node, index) => {
            const folds = Boolean(node.key && hasSubgroups(node))
            const shut = folds && collapsed.has(node.key!)
            const active = isActive(node)
            const label = labelOf(node)
            return (
              <div key={node.id} className="ct-groups-item">
                {folds && (
                  <button
                    type="button"
                    className="ct-groups-fold"
                    tabIndex={-1}
                    aria-expanded={!shut}
                    aria-label={uiText(shut ? 'contacts.groups.expandGroup' : 'contacts.groups.collapseGroup', { p0: label })}
                    onClick={() => toggleFold(node)}
                  >
                    {shut ? <ChevronRight /> : <ChevronDown />}
                  </button>
                )}
                <button
                  type="button"
                  className={`ct-groups-row${node.sub ? ' sub' : ''}${active ? ' active' : ''}`}
                  data-group-id={node.id}
                  aria-pressed={active}
                  tabIndex={node === current ? 0 : -1}
                  onFocus={() => setFocusId(node.id)}
                  onKeyDown={(event) => onRowKey(event, node, index)}
                  onClick={(event) => onSelect(pickGroup(selected, node.id, event.shiftKey || api.ui.hasModKey(event)))}
                >
                  <span
                    className={`ct-groups-dot${node.id === ALL ? ' all' : node.id === UNCATEGORIZED ? ' none' : ''}`}
                    style={node.id === ALL || node.id === UNCATEGORIZED ? undefined : { background: paletteCssValue(groupColorFor(node.id, groupConfigs)) }}
                    aria-hidden="true"
                  />
                  <span className="ct-groups-label">{label}</span>
                  <span className="ct-groups-count">{node.count}</span>
                </button>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

export function Panel(): ReactElement {
  const snap = useContacts(api)
  const showGroups = useShowGroupsInList()
  const store = getStore(api)
  const [query, setQuery] = React.useState('')

  const inGroup = filterBySelectedGroups(snap.contacts, snap.selectedGroups)
  const q = query.trim().toLowerCase()
  const visible = q ? inGroup.filter((c) => searchHaystack(c).includes(q)) : inGroup
  const renderContact = (c: Contact): ReactElement => {
    const avatar = avatarSource(c, snap.coverPaths[c.relPath])
    const subtitle = contactSubtitle(c)
    return (
      <button
        key={c.relPath}
        className={`ct-row${c.relPath === snap.selectedPath ? ' active' : ''}`}
        onClick={(event) => store.openContact(c.relPath, { newTab: api.ui.hasModKey(event) })}
        onAuxClick={(event) => { if (event.button === 1) store.openContact(c.relPath, { newTab: true }) }}
      >
        <span className="ct-avatar">
          {initials(c.displayName) || <User />}
          {avatar && (
            <img
              className="ct-avatar-img"
              src={avatar}
              alt=""
              loading="lazy"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
            />
          )}
        </span>
        <span className="ct-row-meta">
          <span className="ct-row-name">{c.displayName}</span>
          {subtitle && <span className="ct-row-sub">{subtitle}</span>}
          {showGroups && c.groups.length > 0 && (
            <span className="ct-row-tags">
              {c.groups.slice(0, MAX_TAGS).map((group) => (
                <span key={group} className="ct-tag" title={group}><span>{group}</span></span>
              ))}
              {c.groups.length > MAX_TAGS && <span className="ct-tag ct-tag-more" title={c.groups.slice(MAX_TAGS).join(', ')}>+{c.groups.length - MAX_TAGS}</span>}
            </span>
          )}
        </span>
      </button>
    )
  }

  return (
    <div className="ct-panel">
      <div className="panel-header">
        <span className="panel-title">{uiText('auto.b0dd615cbbdc')}</span>
        <div className="ct-header-actions">
          <button className="ct-iconbtn" title={uiText('auto.f4101c50fadc')} onClick={() => store.startCreate()}><Plus /></button>
        </div>
      </div>

      <div className="search-field-row">
        <div className="ct-search search-field">
          <Search className="search-field-icon" />
          <input
            className="search-field-input"
            value={query}
            placeholder={uiText('auto.4210f2777a64')}
            onChange={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
        </div>
      </div>

      <GroupsSection
        tree={snap.groupTree}
        groupConfigs={snap.groupConfigs}
        selected={snap.selectedGroups}
        onSelect={(selected) => store.setGroupFilter(selected)}
      />

      <div className="ct-list">
        {visible.length === 0 ? (
          <div className="ct-empty">
            {snap.contacts.length === 0
              ? uiText('auto.b9d02d616011')
              : uiText('auto.e61bff8c93ec')}
          </div>
        ) : (
          visible.map(renderContact)
        )}
      </div>
    </div>
  )
}
