import type { ReactElement } from 'react'
import type { SettingsReorderHandleProps, SettingsReorderItemProps } from '@valley/plugin-sdk'
import { React, api } from './runtime'
import type { ContactGroup, SocialLink } from './types'
import { getSettings } from './data'
import { iconForPlatform } from './social'
import { CONTACT_ICON_FOLDER, ContactIconPicker, useContactIcons } from './contactIcons'
import { useContacts } from './store'
import { GripVertical, MdDelete, Plus, X } from './icons'
import { uiText } from './localization'
import { groupFamily, groupKey, nextGroupColor, placeGroup, resolveGroupDrop, stepGroup, subgroupsOf, type GroupPlacement } from '@valley/plugin-sdk/groups'
import {
  LOCAL_GROUP_LIMIT, LOCAL_GROUP_NAME_MAX, SHOW_GROUPS_IN_LIST_KEY, USE_LOCAL_GROUPS_KEY, USE_SHARED_GROUPS_KEY,
  newLocalGroupId, renameLocalGroup, setLocalGroups, useAllContactGroups, useGroupKinds, useLocalGroups, useShowGroupsInList
} from './groups'

/**
 * A text field in the plugin's own document with the shared Settings control
 * styling. The host TextField is controlled across the frame bridge, so every
 * keystroke re-rendered the whole list and fast typing dropped characters. This
 * one is uncontrolled: `onType` sees each keystroke, `onCommit` the final text
 * on Enter or blur; Escape restores `initial`.
 */
function CommitTextField({ initial, onCommit, onType, onEnter, placeholder, ariaLabel, className = 'ct-settings-text', invalid, spellCheck = false }: {
  initial: string
  onCommit: (value: string) => void
  onType?: (value: string) => void
  onEnter?: () => void
  placeholder?: string
  ariaLabel: string
  className?: string
  invalid?: boolean
  spellCheck?: boolean
}): ReactElement {
  const skip = React.useRef(false)
  return (
    <input
      className={`settings-control ${className}${invalid ? ' invalid' : ''}`}
      aria-invalid={invalid || undefined}
      type="text"
      defaultValue={initial}
      placeholder={placeholder}
      aria-label={ariaLabel}
      autoComplete="off"
      spellCheck={spellCheck}
      onChange={(event) => onType?.(event.currentTarget.value)}
      onBlur={(event) => {
        if (skip.current) { skip.current = false; return }
        if (event.currentTarget.value !== initial) onCommit(event.currentTarget.value)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          if (onEnter) { onCommit(event.currentTarget.value); onEnter(); return }
          event.currentTarget.blur()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.currentTarget.value = initial
          onType?.(initial)
          skip.current = true
          event.currentTarget.blur()
        }
      }}
    />
  )
}

function socialId(label: string): string {
  return `social_${label.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'social'}`
}

function ConfirmRemoveButton({ onDelete, label }: { onDelete: () => void; label: string }): ReactElement {
  const [confirm, setConfirm] = React.useState(false)
  React.useEffect(() => {
    if (!confirm) return
    const timer = window.setTimeout(() => setConfirm(false), 3500)
    return () => window.clearTimeout(timer)
  }, [confirm])
  return (
    <api.ui.settings.IconButton
      className={`ct-group-remove${confirm ? ' confirm' : ''}`}
      variant={confirm ? 'danger' : 'ghost'}
      onClick={() => { if (confirm) { setConfirm(false); onDelete() } else setConfirm(true) }}
      onBlur={() => setConfirm(false)}
      ariaLabel={confirm ? uiText('auto.97372e5fad97', { p0: label }) : uiText('auto.b8c425a1937d', { p0: label })}
      title={confirm ? uiText('auto.0b0311367700') : uiText('auto.e963907dac5c')}
    >
      {confirm ? <MdDelete /> : <X />}
    </api.ui.settings.IconButton>
  )
}

function useSocials(): [SocialLink[], (next: SocialLink[]) => void] {
  const [socials, setSocials] = React.useState<SocialLink[]>(() => getSettings().socials)
  const shown = React.useRef(socials)
  React.useEffect(() => api.settings.subscribe(() => {
    const next = getSettings().socials
    if (JSON.stringify(shown.current) === JSON.stringify(next)) return
    shown.current = next
    setSocials(next)
  }), [])
  const commit = React.useCallback((next: SocialLink[]): void => {
    shown.current = next
    setSocials(next)
    void api.settings.set('socials', next)
  }, [])
  return [socials, commit]
}

/** One platform row; its fields are uncontrolled, so typing never redraws the list. */
function SocialRow({ social, overClass, itemProps, handleProps, onUpdate, onRemove }: {
  social: SocialLink
  overClass: string
  itemProps: SettingsReorderItemProps
  handleProps: SettingsReorderHandleProps
  onUpdate: (id: string, patch: Partial<SocialLink>) => void
  onRemove: (id: string) => void
}): ReactElement {
  const Icon = iconForPlatform(social.label, social.icon)
  return (
    <div className={`ct-social-setting-row${overClass}`} {...itemProps}>
      <button {...handleProps} className={`${handleProps.className ?? ''} ct-social-grip ct-social-settings-grip`} title={uiText('contacts.social.reorder')}><GripVertical /></button>
      <ContactIconPicker name={social.label} icon={social.icon} onChange={(icon) => onUpdate(social.id, { icon })}><Icon /></ContactIconPicker>
      <CommitTextField
        key={`label:${social.label}`}
        initial={social.label}
        ariaLabel={uiText('auto.23cad2b6b992')}
        spellCheck
        onCommit={(label) => { if (label.trim()) onUpdate(social.id, { label: label.trim() }) }}
      />
      <CommitTextField
        key={`url:${social.url}`}
        className="ct-settings-text ct-social-setting-url"
        initial={social.url}
        placeholder="https://example.com/{}"
        ariaLabel={uiText('auto.93a4103c024a')}
        onCommit={(url) => onUpdate(social.id, { url: url.trim() })}
      />
      <ConfirmRemoveButton label={social.label} onDelete={() => onRemove(social.id)} />
    </div>
  )
}

function SocialSettings(): ReactElement {
  useContactIcons()
  const { Button, Section, useReorderDrag } = api.ui.settings
  const [socials, commitSocials] = useSocials()
  const latest = React.useRef(socials)
  latest.current = socials
  const [newLabel, setNewLabel] = React.useState('')
  const newUrl = React.useRef('')
  const [newIcon, setNewIcon] = React.useState<string>()
  const [addKey, setAddKey] = React.useState(0)
  const [duplicate, setDuplicate] = React.useState(false)

  const onUpdate = React.useCallback((id: string, patch: Partial<SocialLink>) => {
    commitSocials(latest.current.map((social) => social.id === id ? { ...social, ...patch } : social))
  }, [commitSocials])
  const onRemove = React.useCallback((id: string) => {
    commitSocials(latest.current.filter((social) => social.id !== id))
  }, [commitSocials])
  const add = (): void => {
    const label = newLabel.trim()
    if (!label) return
    if (socials.some((social) => social.label.toLowerCase() === label.toLowerCase())) { setDuplicate(true); return }
    commitSocials([...socials, { id: socialId(label), label, url: newUrl.current.trim(), ...(newIcon ? { icon: newIcon } : {}) }])
    setNewLabel('')
    newUrl.current = ''
    setNewIcon(undefined)
    setDuplicate(false)
    setAddKey((key) => key + 1)
  }

  // The stored order is the order the platforms are offered in, in the editor's picker and the detail view.
  const reorder = useReorderDrag<SocialLink>({
    items: socials,
    getId: (social) => social.id,
    getLabel: (social) => social.label,
    onReorder: commitSocials
  })

  return (
    <Section>
      <div className="settings-colorrules ct-social-settings">
        <span className="settings-toggle-text">
          <span className="settings-toggle-title">{uiText('auto.52e0b0a389f8')}</span>
          <span className="settings-toggle-desc">
            {uiText('auto.658128ca827d')}{' '}<code>{'{}'}</code>{' '}{uiText('auto.928154ade660')}{' '}
            {uiText('contacts.icons.folderHint', { p0: CONTACT_ICON_FOLDER })}
          </span>
        </span>
        <div className="ct-social-setting-head" aria-hidden="true">
          <span />
          <span />
          <span>{uiText('auto.23cad2b6b992')}</span>
          <span>{uiText('auto.93a4103c024a')}</span>
          <span />
        </div>
        {socials.map((social) => (
          <SocialRow
            key={social.id}
            social={social}
            overClass={reorder.overId === social.id ? ` drop-${reorder.dropPosition ?? 'before'}` : ''}
            itemProps={reorder.getItemProps(social)}
            handleProps={reorder.getHandleProps(social)}
            onUpdate={onUpdate}
            onRemove={onRemove}
          />
        ))}
        <div className="ct-social-setting-row ct-social-setting-add" key={`add:${addKey}`}>
          <span className="ct-social-grip ct-social-settings-grip" aria-hidden="true" />
          <ContactIconPicker name={newLabel || uiText('auto.042b0b89db47')} icon={newIcon} onChange={setNewIcon}>
            {React.createElement(iconForPlatform(newLabel, newIcon))}
          </ContactIconPicker>
          <CommitTextField
            initial=""
            invalid={duplicate}
            ariaLabel={uiText('auto.042b0b89db47')}
            placeholder={uiText('auto.042b0b89db47')}
            spellCheck
            onType={(value) => { setNewLabel(value); setDuplicate(false) }}
            onCommit={setNewLabel}
            onEnter={add}
          />
          <CommitTextField
            className="ct-settings-text ct-social-setting-url"
            initial=""
            placeholder="https://example.com/{}"
            ariaLabel={uiText('auto.c0251fe352c8')}
            onType={(value) => { newUrl.current = value }}
            onCommit={(value) => { newUrl.current = value }}
            onEnter={add}
          />
          <Button onClick={add}>{uiText('auto.61cc55aa0453')}</Button>
        </div>
        {duplicate && <span className="settings-empty-text">{uiText('contacts.settings.groupDuplicate')}</span>}
        {reorder.liveRegion}
      </div>
    </Section>
  )
}

/**
 * Contacts-only groups beside the shared ones, edited exactly like Settings →
 * Appearance → Groups: grip, name, colour, + subgroup, usage, remove, and an
 * add row on the same columns. A group is removed only once no card uses it.
 */
function LocalGroupsSettings(): ReactElement {
  const { Button, ColorField, IconButton, Section, useReorderDrag } = api.ui.settings
  const local = useLocalGroups()
  const groups = useAllContactGroups()
  const contacts = useContacts(api).contacts
  const names = React.useMemo(() => contacts.flatMap((contact) => contact.groups).map(groupKey), [contacts])
  const draft = React.useRef('')
  const [addKey, setAddKey] = React.useState(0)
  const [draftColor, setDraftColor] = React.useState(() => nextGroupColor(groups))
  const [duplicate, setDuplicate] = React.useState(false)
  const taken = (name: string, except?: string): boolean => groups.some((group) => group.id !== except && [group.name, ...(group.aliases ?? [])].some((candidate) => groupKey(candidate) === groupKey(name)))
  const save = (next: ContactGroup[]): void => { void setLocalGroups(next) }
  const usage = (group: ContactGroup): number => {
    const keys = new Set([group.name, ...(group.aliases ?? [])].map(groupKey))
    return names.filter((name) => keys.has(name)).length
  }
  const total = (group: ContactGroup): number => groupFamily(local, group).reduce((sum, member) => sum + usage(member), 0)
  const NEST_OFFSET = 28
  const [nest, setNest] = React.useState(false)
  const [subgroupOf, setSubgroupOf] = React.useState<string | null>(null)
  const [subColor, setSubColor] = React.useState(() => nextGroupColor(groups))
  const [subDuplicate, setSubDuplicate] = React.useState(false)
  const subRow = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => { if (subgroupOf) subRow.current?.querySelector('input')?.focus() }, [subgroupOf])
  const place = (id: string, placement: GroupPlacement | null): void => {
    if (!placement) return
    let next: ContactGroup[]
    try { next = placeGroup(local, id, placement) } catch { return }
    if (next.every((group, index) => group.id === local[index]?.id && group.parent === local[index]?.parent)) return
    save(next)
  }
  const reorder = useReorderDrag({
    items: local,
    indicatorOnly: true,
    getId: (group) => group.id,
    getLabel: (group) => group.name,
    onReorder: (_next, move) => {
      const edge = move.position === 'before' ? local[0]?.id : local.at(-1)?.id
      place(move.activeId, stepGroup(local, move.activeId, move.position, move.overId === edge))
    }
  })
  const wantsNest = (event: React.DragEvent<HTMLElement>): boolean => event.clientX > event.currentTarget.getBoundingClientRect().left + NEST_OFFSET
  const dropProps = (group: ContactGroup): ReturnType<typeof reorder.getItemProps> => {
    const props = reorder.getItemProps(group)
    return {
      ...props,
      onDragOver: (event) => { props.onDragOver?.(event); setNest(wantsNest(event)) },
      onDrop: (event) => {
        const dragId = reorder.activeId ?? event.dataTransfer.getData('text/plain')
        if (!dragId) return
        event.preventDefault()
        const rect = event.currentTarget.getBoundingClientRect()
        place(dragId, resolveGroupDrop(local, dragId, group.id, event.clientY < rect.top + rect.height / 2 ? 'before' : 'after', wantsNest(event)))
        reorder.cancel()
      }
    }
  }
  const target = reorder.activeId && reorder.overId && reorder.dropPosition
    ? resolveGroupDrop(local, reorder.activeId, reorder.overId, reorder.dropPosition, nest)
    : null
  const dropClass = (group: ContactGroup, index: number): string => {
    if (!target) return ''
    const nested = target.parent !== null ? ' drop-nested' : ''
    if (target.before !== null) return target.before === group.id ? ' drop-before' + nested : ''
    const scope = target.parent === null ? local : local.filter((entry) => entry.id === target.parent || entry.parent === target.parent)
    const last = scope.filter((entry) => entry.id !== reorder.activeId && entry.parent !== reorder.activeId).at(-1) ?? local[index]
    return last.id === group.id ? ' drop-after' + nested : ''
  }
  const addSubgroup = (value: string): void => {
    const name = value.trim().slice(0, LOCAL_GROUP_NAME_MAX)
    if (!subgroupOf || !name || local.length >= LOCAL_GROUP_LIMIT) { setSubgroupOf(null); return }
    if (taken(name)) { setSubDuplicate(true); return }
    const created: ContactGroup = { id: newLocalGroupId(), name, color: subColor }
    try { save(placeGroup([...local, created], created.id, { parent: subgroupOf, before: null })) } catch { /* its group is gone */ }
    setSubgroupOf(null)
  }
  const add = (): void => {
    const name = draft.current.trim().slice(0, LOCAL_GROUP_NAME_MAX)
    if (!name || local.length >= LOCAL_GROUP_LIMIT) return
    if (taken(name)) { setDuplicate(true); return }
    const created: ContactGroup = { id: newLocalGroupId(), name, color: draftColor }
    save([...local, created])
    draft.current = ''
    setDuplicate(false)
    setDraftColor(nextGroupColor([...groups, created]))
    setAddKey((key) => key + 1)
  }
  const rename = (group: ContactGroup, value: string): void => {
    if (!value.trim() || value.trim() === group.name || taken(value, group.id)) return
    save(local.map((candidate) => candidate.id === group.id ? renameLocalGroup(candidate, value) : candidate))
  }
  return (
    <Section>
      <div className="settings-path-row settings-groups-row">
        <span className="settings-toggle-text">
          <span className="settings-toggle-title">{uiText('contacts.settings.localGroups')}</span>
          <span className="settings-toggle-desc">{uiText('contacts.settings.localGroupsDesc')}</span>
        </span>
        <div className="settings-colorrules settings-groups" role="list" aria-label={uiText('contacts.settings.localGroups')}>
          {local.map((group, index) => {
            const slot = `${group.id}@${index}`
            const handleProps = reorder.getHandleProps(group)
            const subgroups = subgroupsOf(local, group.id).length
            const count = group.parent ? usage(group) : total(group)
            const blocked = count > 0 || subgroups > 0
            const draftHere = subgroupOf !== null && (local[index + 1]?.parent ?? null) !== subgroupOf
              && (group.id === subgroupOf || group.parent === subgroupOf)
            return (
              <React.Fragment key={group.id}>
                <div role="listitem" className={'settings-colorrule-row' + (group.parent ? ' settings-group-sub' : '') + dropClass(group, index)} {...dropProps(group)}>
                  <button {...handleProps} className={(handleProps.className ?? '') + ' settings-colorrule-grip'}><GripVertical /></button>
                  <CommitTextField
                    key={`name:${group.id}:${group.name}`}
                    className="settings-colorrule-key"
                    initial={group.name}
                    ariaLabel={uiText('contacts.settings.localGroupName')}
                    onCommit={(value) => rename(group, value)}
                  />
                  <ColorField
                    key={`color:${slot}`}
                    value={group.color}
                    onChange={(color) => save(local.map((candidate) => candidate.id === group.id ? { ...candidate, color } : candidate))}
                    ariaLabel={uiText('contacts.settings.localGroupColor', { p0: group.name })}
                  />
                  {group.parent
                    ? <span aria-hidden="true" />
                    : (
                      <IconButton
                        key={`addsub:${slot}`}
                        className="settings-group-addsub"
                        ariaLabel={uiText('contacts.settings.localSubgroupAddTo', { p0: group.name })}
                        title={uiText('contacts.settings.localSubgroupAdd')}
                        onClick={() => { setSubDuplicate(false); setSubColor(nextGroupColor(groups)); setSubgroupOf(group.id) }}
                      ><Plus /></IconButton>
                    )}
                  <span className="settings-group-usage" title={uiText('contacts.settings.localGroupUsage', { count })}>{count}</span>
                  <IconButton
                    key={`remove:${slot}`}
                    className="settings-colormap-remove"
                    aria-disabled={blocked || undefined}
                    ariaLabel={uiText('contacts.settings.localGroupDelete', { p0: group.name })}
                    title={count > 0 ? uiText('contacts.settings.localGroupRemoveBlocked', { count }) : subgroups > 0 ? uiText('contacts.settings.localGroupRemoveSubgroups') : uiText('contacts.settings.localGroupRemove')}
                    onClick={() => { if (!blocked) save(local.filter((candidate) => candidate.id !== group.id)) }}
                  ><X /></IconButton>
                </div>
                {draftHere && (
                  <div ref={subRow} className="settings-colorrule-row settings-group-sub">
                    <span className="settings-colorrule-grip settings-colorrule-grip-placeholder" aria-hidden="true" />
                    <CommitTextField
                      className="settings-colorrule-key"
                      initial=""
                      invalid={subDuplicate}
                      placeholder={uiText('contacts.settings.localSubgroupNew')}
                      ariaLabel={uiText('contacts.settings.localSubgroupNew')}
                      onType={() => setSubDuplicate(false)}
                      onCommit={addSubgroup}
                    />
                    <ColorField key={`sub-color:${subgroupOf}`} value={subColor} onChange={setSubColor} ariaLabel={uiText('contacts.settings.localGroupNewColor')} />
                  </div>
                )}
              </React.Fragment>
            )
          })}
          {reorder.liveRegion}
          <div className="settings-colorrule-row settings-colorrule-add">
            <span className="settings-colorrule-grip settings-colorrule-grip-placeholder" aria-hidden="true" />
            <CommitTextField
              key={`add:${addKey}`}
              className="settings-colorrule-key"
              initial=""
              invalid={duplicate}
              placeholder={uiText('contacts.settings.localGroupNew')}
              ariaLabel={uiText('contacts.settings.localGroupNew')}
              onType={(value) => { draft.current = value; setDuplicate(false) }}
              onCommit={(value) => { draft.current = value }}
              onEnter={add}
            />
            <ColorField key={`add-color:${addKey}`} value={draftColor} onChange={setDraftColor} ariaLabel={uiText('contacts.settings.localGroupNewColor')} />
            <span aria-hidden="true" />
            <span className="settings-colorrule-add-action">
              <span className="settings-button settings-button--medium settings-colorrule-add-sizer" aria-hidden="true">{uiText('contacts.settings.localGroupAdd')}</span>
              <Button type="button" className="settings-colormap-add-btn" disabled={local.length >= LOCAL_GROUP_LIMIT} onClick={add}>{uiText('contacts.settings.localGroupAdd')}</Button>
            </span>
          </div>
          {(duplicate || subDuplicate) && <span className="settings-empty-text">{uiText('contacts.settings.groupDuplicate')}</span>}
        </div>
      </div>
    </Section>
  )
}

/** Shared groups and Contacts-only groups, each behind its own switch. A kind that is off is not offered or listed; cards keep their groups. */
function GroupsSettings(): ReactElement {
  const { GroupsEditor, Row, Section, Toggle } = api.ui.settings
  const kinds = useGroupKinds()
  const showInList = useShowGroupsInList()
  return (
    <>
      <Section>
        <Row title={uiText('contacts.settings.showGroupsInList')} description={uiText('contacts.settings.showGroupsInListDesc')}>
          <Toggle checked={showInList} label={uiText('contacts.settings.showGroupsInList')} onChange={(on) => { void api.settings.set(SHOW_GROUPS_IN_LIST_KEY, on) }} />
        </Row>
        <Row title={uiText('contacts.settings.useSharedGroups')} description={uiText('contacts.settings.useSharedGroupsDesc')}>
          <Toggle checked={kinds.shared} label={uiText('contacts.settings.useSharedGroups')} onChange={(on) => { void api.settings.set(USE_SHARED_GROUPS_KEY, on) }} />
        </Row>
        <Row title={uiText('contacts.settings.useLocalGroups')} description={uiText('contacts.settings.useLocalGroupsDesc')}>
          <Toggle checked={kinds.local} label={uiText('contacts.settings.useLocalGroups')} onChange={(on) => { void api.settings.set(USE_LOCAL_GROUPS_KEY, on) }} />
        </Row>
      </Section>
      {kinds.shared && <Section><GroupsEditor /></Section>}
      {kinds.local && <LocalGroupsSettings />}
    </>
  )
}

function GeneralSettings(): ReactElement {
  const { RealmFolderField, Row, Section } = api.ui.settings
  const [contactsRoot, setContactsRoot] = React.useState(() => getSettings().contactsRoot)
  return (
    <Section>
      <Row title={uiText('auto.ecea12d8f363')} description={uiText('contacts.settings.rootDescription')}>
        <RealmFolderField
          value={contactsRoot}
          onChange={setContactsRoot}
          onCommit={(value) => void api.settings.set('contactsRoot', value)}
          ariaLabel={uiText('auto.ecea12d8f363')}
        />
      </Row>
    </Section>
  )
}

/** `contacts.settings`: rendered once per manifest `settingsSections` id, and once for the main page. */
export function Settings({ section }: { section?: string }): ReactElement {
  if (section === 'social') return <SocialSettings />
  if (section === 'groups') return <GroupsSettings />
  return <GeneralSettings />
}
