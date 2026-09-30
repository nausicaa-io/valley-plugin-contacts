import type { ReactElement } from 'react'
import { assetUrlForRelPath } from '@valley/plugin-sdk/fileTypes'
import { React, api } from './runtime'
import { useContacts, getStore } from './store'
import { paletteCssValue } from '@valley/plugin-sdk/palette'
import { ALL, UNCATEGORIZED, filterByGroupVisibility, groupColorFor } from './data'
import type { Contact, ContactGroup, GroupNode } from './types'
import { GroupGlyph, Plus, Search, User } from './icons'
import { contactSubtitle, initials, searchHaystack } from './util'
import { uiText } from './localization'

function GroupFilterPopover({
  groups,
  groupConfigs,
  ungrouped,
  hidden,
  hideUngrouped,
  onChange,
  onOpenSettings
}: {
  groups: GroupNode[]
  groupConfigs: ContactGroup[]
  ungrouped: GroupNode | null
  hidden: string[]
  hideUngrouped: boolean
  onChange: (hidden: string[], hideUngrouped: boolean) => void
  onOpenSettings: () => void
}): ReactElement {
  const [localHidden, setLocalHidden] = React.useState(hidden)
  const [localHideUngrouped, setLocalHideUngrouped] = React.useState(hideUngrouped)
  const selectedCount = groups.filter((group) => !localHidden.includes(group.id)).length
  const allSelected = selectedCount === groups.length && (!ungrouped || !localHideUngrouped)
  const activeRows = [
    ...groups.map((group) => !localHidden.includes(group.id)),
    ...(ungrouped ? [!localHideUngrouped] : [])
  ]
  const selectionRunClass = (active: boolean, index: number): string => active
    ? ` active${!activeRows[index - 1] ? ' selection-run-start' : ''}${!activeRows[index + 1] ? ' selection-run-end' : ''}`
    : ''
  const commit = (nextHidden: string[], nextHideUngrouped: boolean): void => {
    setLocalHidden(nextHidden)
    setLocalHideUngrouped(nextHideUngrouped)
    onChange(nextHidden, nextHideUngrouped)
  }
  const rows = [...groups, ...(ungrouped ? [ungrouped] : [])]

  return (
    <div className="ct-group-filter-popover-body">
      <div className="ct-group-filter-popover-head">
        <button type="button" className="ct-group-filter-popover-title" onClick={onOpenSettings}>
          {uiText('auto.171a0606f7c7')}
        </button>
        {rows.length > 0 && (
          <button
            type="button"
            className="ct-group-filter-popover-all"
            onClick={() => commit(allSelected ? groups.map((group) => group.id) : [], allSelected ? !!ungrouped : false)}
          >
            {uiText(allSelected ? 'contacts.filter.deselectAll' : 'contacts.filter.selectAll')}
          </button>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="ct-group-filter-empty">{uiText('auto.115fe0fac776')}</div>
      ) : (
        <div className="ct-group-filter-list">
          {groups.map((group, index) => {
            const selected = !localHidden.includes(group.id)
            return (
              <button
                key={group.id}
                type="button"
                className={`ct-group-filter-option${selectionRunClass(activeRows[index], index)}`}
                aria-pressed={selected}
                onClick={() => commit(
                  selected ? [...localHidden, group.id] : localHidden.filter((id) => id !== group.id),
                  localHideUngrouped
                )}
              >
                <span className="ct-group-filter-check" aria-hidden="true">{selected ? '✓' : ''}</span>
                <span className="ct-group-filter-dot" style={{ background: paletteCssValue(groupColorFor(group.id, groupConfigs)) }} />
                <span className="ct-group-filter-label">{group.label}</span>
                <span className="ct-group-filter-count">{group.count}</span>
              </button>
            )
          })}
          {ungrouped && (
            <button
              type="button"
              className={`ct-group-filter-option${selectionRunClass(activeRows[groups.length], groups.length)}`}
              aria-pressed={!localHideUngrouped}
              onClick={() => commit(localHidden, !localHideUngrouped)}
            >
              <span className="ct-group-filter-check" aria-hidden="true">{localHideUngrouped ? '' : '✓'}</span>
              <span className="ct-group-filter-dot no-group" />
              <span className="ct-group-filter-label">{ungrouped.label}</span>
              <span className="ct-group-filter-count">{ungrouped.count}</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function Panel(): ReactElement {
  const snap = useContacts(api)
  const store = getStore(api)
  const [query, setQuery] = React.useState('')

  const inGroup = filterByGroupVisibility(snap.contacts, snap.hiddenGroups, snap.hideUngrouped)
  const q = query.trim().toLowerCase()
  const visible = q ? inGroup.filter((c) => searchHaystack(c).includes(q)) : inGroup
  const groupNodes = snap.groupTree.filter((node) => node.id !== ALL && node.id !== UNCATEGORIZED)
  const ungrouped = snap.groupTree.find((node) => node.id === UNCATEGORIZED) ?? null
  const groupFilterActive = snap.hiddenGroups.length > 0 || snap.hideUngrouped

  const openGroups = (anchor: HTMLElement): void => {
    void api.ui.openPopover(
      ({ close }) => (
        <GroupFilterPopover
          groups={groupNodes}
          groupConfigs={snap.groupConfigs}
          ungrouped={ungrouped}
          hidden={snap.hiddenGroups}
          hideUngrouped={snap.hideUngrouped}
          onChange={(hidden, nextHideUngrouped) => store.setGroupFilter(hidden, nextHideUngrouped)}
          onOpenSettings={() => {
            close()
            void api.workspace.openSettings('groups')
          }}
        />
      ),
      { anchor, align: 'end' },
      { className: 'ct-group-filter-popover', ariaLabel: uiText('auto.ae9629f4ebb8') }
    )
  }

  const renderContact = (c: Contact): ReactElement => {
    const coverPath = snap.coverPaths[c.relPath]
    const groupColor = paletteCssValue(groupColorFor(c.groups[0], snap.groupConfigs))
    return (
      <button
        key={c.relPath}
        className={`ct-row${c.relPath === snap.selectedPath ? ' active' : ''}`}
        onClick={() => store.openContact(c.relPath)}
      >
        <span className="ct-avatar" style={{ boxShadow: `0 0 0 2px ${groupColor}` }}>
          {initials(c.displayName) || <User />}
          {coverPath && (
            <img
              className="ct-avatar-img"
              src={assetUrlForRelPath(coverPath)}
              alt=""
              loading="lazy"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
            />
          )}
        </span>
        <span className="ct-row-meta">
          <span className="ct-row-name">{c.displayName}</span>
          {contactSubtitle(c) && <span className="ct-row-sub">{contactSubtitle(c)}</span>}
        </span>
      </button>
    )
  }

  return (
    <div className="ct-panel">
      <div className="panel-header">
        <span className="panel-title">{uiText('auto.b0dd615cbbdc')}</span>
        <div className="ct-header-actions">
          <button
            className={`ct-group-filter-btn${groupFilterActive ? ' active' : ''}`}
            type="button"
            aria-label={uiText('auto.ae9629f4ebb8')}
            title={uiText('auto.ae9629f4ebb8')}
            onClick={(event) => openGroups(event.currentTarget)}
          >
            <GroupGlyph />
          </button>
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
