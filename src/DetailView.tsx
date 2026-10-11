import { useContactIcons } from './contactIcons'
import type { CSSProperties, KeyboardEvent, ReactElement } from 'react'
import { assetUrlForRelPath } from '@valley/plugin-sdk/fileTypes'
import { React, api } from './runtime'
import type { Contact } from './types'
import { getStore } from './store'
import { paletteCssAlpha, paletteCssValue } from '@valley/plugin-sdk/palette'
import { allGroups, getSocialLinks, groupColorFor, normalizeGroupName, relationLabel, resolveRelation, saveContact } from './data'
import { RELATION_COLORS, RELATION_LABELS } from './relationGraphModel'
import { formatContactBirthdate, initials } from './util'
import { resolveSocial } from './social'
import { Building, Cake, Link, Mail, MapPin, Phone, Plus, X } from './icons'
import { uiText } from './localization'
import type { LinkTarget, MountedPluginView } from '@valley/plugin-sdk'
import type { TextDocumentRead } from '@valley/plugin-sdk/types'
import { readContactDocument } from './data'
import { CONFIRMED_LINK_OPEN, useContactFileActions, type ContactFileActionContext } from './fileViewCommands'

/** The card's Markdown notes, rendered by the host like a note's reading view. */
function ContactNotes({ contact }: { contact: Contact }): ReactElement {
  if (!contact.note.trim()) return <div className="ct-notes-empty">{uiText('auto.f03eb1de1e64')}</div>
  return <api.ui.MarkdownView className="ct-notes-read" value={contact.note} context={{ sourcePath: contact.relPath }} />
}

/** Cover image, else the card's embedded photo, else nothing (initials show). */
export function avatarSource(contact: Contact, coverPath: string | null | undefined): string {
  return coverPath ? assetUrlForRelPath(coverPath) : contact.photo
}

/** Read-only structured view of a contact, with inline group chips. */
export function DetailView({ contact, mountedView }: { contact: Contact; mountedView?: MountedPluginView }): ReactElement {
  useContactIcons()
  const store = getStore(api)
  const snap = store.getSnapshot()
  const [addingChip, setAddingChip] = React.useState(false)
  const [chipValue, setChipValue] = React.useState('')
  const [groups, setGroups] = React.useState(contact.groups)
  const [savingGroups, setSavingGroups] = React.useState(false)
  const [highlightedGroup, setHighlightedGroup] = React.useState(0)
  const pickerRef = React.useRef<HTMLSpanElement | null>(null)
  const saveSeqRef = React.useRef(0)
  const contactGroupsKey = JSON.stringify(contact.groups)
  const avatar = avatarSource(contact, snap.coverPaths[contact.relPath])
  const avatarAccent = paletteCssValue(groupColorFor(groups[0], snap.groupConfigs))
  const dateFormat = api.getState().dateFormat
  const socialLinks = getSocialLinks()
  const [documentRevision, setDocumentRevision] = React.useState<TextDocumentRead | null>(null)
  const liveReading = React.useRef({ groups, savingGroups, documentRevision })
  liveReading.current = { groups, savingGroups, documentRevision }
  React.useEffect(() => { let active = true; liveReading.current.documentRevision = null; setDocumentRevision(null); void readContactDocument(contact.relPath).then(document => { if (active) { liveReading.current.documentRevision = document; setDocumentRevision(document) } }, () => {}); return () => { active = false } }, [contact])

  const openAddress = (address: string): void => {
    void api.links.open({ category: 'location', value: address })
  }

  React.useEffect(() => {
    liveReading.current.groups = JSON.parse(contactGroupsKey)
    liveReading.current.savingGroups = false
    setGroups(JSON.parse(contactGroupsKey))
    setAddingChip(false)
    setChipValue('')
    setHighlightedGroup(0)
    setSavingGroups(false)
  }, [contact.relPath, contactGroupsKey])

  React.useEffect(() => {
    if (!addingChip) return
    const closePicker = (event: MouseEvent): void => {
      const target = event.target
      if (target && pickerRef.current?.contains(target as Node)) return
      setAddingChip(false)
      setChipValue('')
      setHighlightedGroup(0)
    }
    const document = pickerRef.current?.ownerDocument
    document?.addEventListener('mousedown', closePicker)
    return () => document?.removeEventListener('mousedown', closePicker)
  }, [addingChip])

  const groupStyle = (group: string): CSSProperties => {
    const stored = groupColorFor(group, snap.groupConfigs)
    const color = paletteCssValue(stored)
    return { borderColor: color, color, background: paletteCssAlpha(stored, 13) }
  }

  const persistGroups = async (nextGroups: string[], commandContext?: ContactFileActionContext): Promise<void> => {
    const previousGroups = groups
    const saveSeq = ++saveSeqRef.current
    liveReading.current.groups = nextGroups
    liveReading.current.savingGroups = true
    setGroups(nextGroups)
    setSavingGroups(true)
    try {
      if (commandContext && !documentRevision) throw Object.assign(new Error('The reading Contact revision is unavailable.'), { outcome: 'not-applied' })
      const saved = await saveContact({ ...contact, groups: nextGroups }, { previous: contact, ...(commandContext ? { document: documentRevision! } : {}) }, api, undefined, commandContext ? paths => commandContext.validate(paths.map(path => ({ kind: 'file' as const, path, fileOperation: 'write' as const }))) : undefined)
      if (!saved || saved.editorConflict) throw new Error('The reading Contact group save was not confirmed.')
      if (saveSeqRef.current === saveSeq) { liveReading.current.documentRevision = saved.document; setDocumentRevision(saved.document) }
    } catch (cause) {
      if (saveSeqRef.current === saveSeq) { liveReading.current.groups = previousGroups; setGroups(previousGroups) }
      if (commandContext) throw cause
    } finally {
      if (saveSeqRef.current === saveSeq) { liveReading.current.savingGroups = false; setSavingGroups(false) }
    }
  }

  const removeGroup = (group: string): void => {
    const key = normalizeGroupName(group)
    void persistGroups(groups.filter((g) => normalizeGroupName(g) !== key))
  }

  const closeAddGroup = (): void => {
    setAddingChip(false)
    setChipValue('')
    setHighlightedGroup(0)
  }

  const commitGroup = (rawGroup: string): void => {
    const key = normalizeGroupName(rawGroup)
    const next = knownGroups.find((group) => normalizeGroupName(group) === key)
    closeAddGroup()
    if (!next || groups.some((group) => normalizeGroupName(group) === key)) return
    void persistGroups([...groups, next])
  }

  const currentGroups = new Set(groups.map((g) => normalizeGroupName(g)))
  const knownGroups = allGroups(snap.groupConfigs)
    .filter((g) => !currentGroups.has(normalizeGroupName(g)))
  const groupQuery = normalizeGroupName(chipValue)
  const suggestedGroups = knownGroups
    .filter((g) => !groupQuery || normalizeGroupName(g).includes(groupQuery))
    .slice(0, 7)
  const optionCount = suggestedGroups.length
  const relatedPath = (index: number): string | undefined => { const relation = contact.relations[index]; return relation ? resolveRelation(relation.to, store.getSnapshot().contacts)?.relPath : undefined }
  useContactFileActions(mountedView, 'reader', {
    snapshot: () => ({ groups: liveReading.current.groups, savingGroups: liveReading.current.savingGroups, phone: contact.phone, email: contact.email, place: contact.place, websites: contact.websites, social: contact.socialMedia, relations: contact.relations, documentRevision: liveReading.current.documentRevision?.revisionToken ?? null }),
    actions: {
      'reading-group-add': async (action, context) => { if (action.type === 'reading-group-add') { const next = knownGroups.find(value => normalizeGroupName(value) === normalizeGroupName(action.value)); if (savingGroups || !next) throw Object.assign(new Error('This reading Contact group is unavailable.'), { outcome: 'not-applied' }); await persistGroups([...groups, next], context) } },
      'reading-group-remove': async (action, context) => { if (action.type === 'reading-group-remove') { if (savingGroups || !groups.includes(action.value)) throw Object.assign(new Error('This exact reading Contact group is unavailable.'), { outcome: 'not-applied' }); await persistGroups(groups.filter(value => value !== action.value), context) } },
      'link-open': async (action, context) => {
        if (action.type !== 'link-open') return
        const i = action.index
        if (action.kind === 'relation') { const path = relatedPath(i); if (!path) throw Object.assign(new Error('This related Contact target is unavailable.'), { outcome: 'not-applied' }); await context.validate(); if (relatedPath(i) !== path) throw Object.assign(new Error('The related Contact target changed while authorization was pending.'), { outcome: 'not-applied' }); store.openContact(path); return }
        const value = action.kind === 'phone' ? contact.phone[i]?.value : action.kind === 'email' ? contact.email[i]?.value : action.kind === 'website' ? contact.websites[i] : action.kind === 'address' ? contact.place[i]?.value : contact.socialMedia[i] ? resolveSocial(contact.socialMedia[i], socialLinks).href : null
        if (!value) throw Object.assign(new Error('This exact reading Contact link is unavailable.'), { outcome: 'not-applied' })
        await context.validate()
        const opened = await api.links.open(action.kind === 'address' ? { category: 'location', value } : action.kind === 'phone' ? { category: 'phone', value } : action.kind === 'email' ? { category: 'email', value } : value)
        return { [CONFIRMED_LINK_OPEN]: opened?.status === 'opened' }
      },
      settings: async (_action, context) => { await context.validate(); await api.workspace.openSettings('groups') }
    },
    targets: {
      'link-open': action => { const path = action.type === 'link-open' && action.kind === 'relation' ? relatedPath(action.index) : undefined; return path ? [{ kind: 'file', path, fileOperation: 'read' }] : [] }
    }
  })

  React.useEffect(() => {
    setHighlightedGroup(0)
  }, [chipValue, addingChip])

  const onGroupInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeAddGroup()
      return
    }
    if (event.key === 'ArrowDown' && optionCount > 0) {
      event.preventDefault()
      setHighlightedGroup((highlightedGroup + 1) % optionCount)
      return
    }
    if (event.key === 'ArrowUp' && optionCount > 0) {
      event.preventDefault()
      setHighlightedGroup((highlightedGroup - 1 + optionCount) % optionCount)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const selectedSuggestion = suggestedGroups[highlightedGroup]
      if (selectedSuggestion) commitGroup(selectedSuggestion)
    }
  }

  return (
    <div className="ct-detail">
      <div className="ct-detail-head">
        <span className="ct-detail-avatar" style={{ boxShadow: `0 0 0 3px ${avatarAccent}` }}>
          {initials(contact.displayName)}
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
        <div className="ct-detail-names">
          <h2 className="ct-detail-name">{contact.displayName}</h2>
          {contact.profession && <p className="ct-detail-sub">{contact.profession}</p>}
        </div>
      </div>

      <div className={`ct-chips${savingGroups ? ' saving' : ''}`}>
        {groups.map((group) => (
          <span key={group} className="ct-chip" style={groupStyle(group)}>
            {group}
            <button onClick={() => removeGroup(group)} title={uiText('auto.9a5319bc9fe3')}><X /></button>
          </span>
        ))}
        {addingChip ? (
          <span className="ct-chip-picker" ref={pickerRef}>
            <input
              className="ct-chip-input"
              autoFocus
              value={chipValue}
              placeholder={uiText('auto.d747c072f6c5')}
              onChange={(e) => setChipValue((e.target as HTMLInputElement).value)}
              onKeyDown={onGroupInputKeyDown}
            />
            <span className="ct-chip-popover" role="listbox">
              {suggestedGroups.map((group, i) => (
                <button
                  key={group}
                  className={`ct-chip-option${i === highlightedGroup ? ' active' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    commitGroup(group)
                  }}
                  role="option"
                  aria-selected={i === highlightedGroup}
                >
                  <span className="ct-chip-option-dot" style={{ background: paletteCssValue(groupColorFor(group, snap.groupConfigs)) }} />
                  <span className="ct-chip-option-label">{group}</span>
                </button>
              ))}
              {optionCount === 0 && <span className="ct-chip-empty">{uiText('auto.115fe0fac776')}</span>}
              <button
                className="ct-chip-option create"
                onMouseDown={(event) => {
                  event.preventDefault()
                  closeAddGroup()
                  api.workspace.openSettings('groups')
                }}
                role="option"
                aria-selected={false}
              >
                <Plus />
                <span className="ct-chip-option-label">{uiText('contacts.settings.groups')}</span>
              </button>
            </span>
          </span>
        ) : (
          <button className="ct-chip-add" onClick={() => setAddingChip(true)}><Plus /> {uiText('auto.171a0606f7c7')}</button>
        )}
      </div>

      {contact.relations.length > 0 && (
        <div className="ct-section">
          <div className="ct-section-title">{uiText('auto.6519fe11ef74')}</div>
          {contact.relations.map((rel, i) => {
            const name = relationLabel(rel.to, snap.contacts)
            const target = resolveRelation(rel.to, snap.contacts)?.relPath ?? null
            return (
              <div className="ct-rel" key={i}>
                <span className="ct-rel-dot" style={{ background: RELATION_COLORS[rel.type] }} />
                <span
                  className={`ct-rel-name${target ? '' : ' dead'}`}
                  onClick={() => target && store.openContact(target)}
                >
                  {name}
                </span>
                <span className="ct-rel-badge" style={{ background: RELATION_COLORS[rel.type] }}>
                  {RELATION_LABELS[rel.type]}
                </span>
                {rel.role && <span className="ct-rel-role">{rel.role}</span>}
              </div>
            )
          })}
        </div>
      )}

      <FieldSection title={uiText('auto.b37456c4530b')} rows={[
        ...contact.phone.map((m) => ({ icon: <Phone />, value: m.value, label: m.type, href: `tel:${m.value}`, link: { category: 'phone', value: m.value } })),
        ...contact.email.map((m) => ({ icon: <Mail />, value: m.value, label: m.type, href: `mailto:${m.value}`, link: { category: 'email', value: m.value } })),
        ...contact.place.map((m) => ({ icon: <MapPin />, value: m.value, label: m.type, onClick: () => openAddress(m.value) })),
        ...contact.websites.map((w) => ({ icon: <Link />, value: w, href: w })),
        ...(contact.birthdate ? [{ icon: <Cake />, value: formatContactBirthdate(contact.birthdate, dateFormat), label: 'birthday' }] : [])
      ]} />

      <FieldSection title={uiText('auto.41a575086b73')} rows={contact.socialMedia.map((s) => {
        const resolved = resolveSocial(s, socialLinks)
        const Icon = resolved.icon
        return {
          icon: <Icon />,
          value: resolved.display,
          label: resolved.label,
          href: resolved.href ?? undefined
        }
      })} />

      {contact.organization.length > 0 && (
        <FieldSection title={uiText('auto.519255ae1f74')} rows={contact.organization.map((o) => ({
          icon: <Building />,
          value: o.name || '',
          label: [o.title, o.dept].filter(Boolean).join(' · ') || undefined
        }))} />
      )}

      <div className="ct-section">
        <div className="ct-section-title">{uiText('auto.70440046a3dc')}</div>
        <ContactNotes contact={contact} />
      </div>
    </div>
  )
}

interface FieldRow {
  icon: ReactElement
  value: string
  label?: string
  href?: string
  link?: LinkTarget
  onClick?: () => void
}

function FieldSection({ title, rows }: { title: string; rows: FieldRow[] }): ReactElement | null {
  const real = rows.filter((r) => r.value)
  if (real.length === 0) return null
  return (
    <div className="ct-section">
      <div className="ct-section-title">{title}</div>
      {real.map((r, i) => (
        <div className="ct-field" key={i}>
          <span className="ct-field-icon">{r.icon}</span>
          <div className="ct-field-body">
            <div className="ct-field-value">
              {r.href ? (
                <a href={r.href} onClick={event => { event.preventDefault(); void api.links.open(r.link ?? r.href!) }}>{r.value}</a>
              ) : r.onClick ? (
                <button className="ct-field-link" type="button" onClick={r.onClick}>{r.value}</button>
              ) : r.value}
            </div>
            {r.label && <div className="ct-field-label">{r.label}</div>}
          </div>
        </div>
      ))}
    </div>
  )
}
