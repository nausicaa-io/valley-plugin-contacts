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
export function DetailView({ contact }: { contact: Contact }): ReactElement {
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

  const openAddress = (address: string): void => {
    void api.links.open({ category: 'location', value: address })
  }

  React.useEffect(() => {
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

  const persistGroups = (nextGroups: string[]): void => {
    const previousGroups = groups
    const saveSeq = ++saveSeqRef.current
    setGroups(nextGroups)
    setSavingGroups(true)
    void saveContact({ ...contact, groups: nextGroups }, { previous: contact }).then((saved) => {
      if ((!saved || saved.editorConflict) && saveSeqRef.current === saveSeq) setGroups(previousGroups)
    }).catch(() => {
      if (saveSeqRef.current === saveSeq) setGroups(previousGroups)
    }).finally(() => {
      if (saveSeqRef.current === saveSeq) setSavingGroups(false)
    })
  }

  const removeGroup = (group: string): void => {
    const key = normalizeGroupName(group)
    persistGroups(groups.filter((g) => normalizeGroupName(g) !== key))
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
    persistGroups([...groups, next])
  }

  const currentGroups = new Set(groups.map((g) => normalizeGroupName(g)))
  const knownGroups = allGroups(snap.groupConfigs)
    .filter((g) => !currentGroups.has(normalizeGroupName(g)))
  const groupQuery = normalizeGroupName(chipValue)
  const suggestedGroups = knownGroups
    .filter((g) => !groupQuery || normalizeGroupName(g).includes(groupQuery))
    .slice(0, 7)
  const optionCount = suggestedGroups.length

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
        ...contact.phone.map((m) => ({ icon: <Phone />, value: m.value, label: m.type, href: `tel:${m.value}` })),
        ...contact.email.map((m) => ({ icon: <Mail />, value: m.value, label: m.type, href: `mailto:${m.value}` })),
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
                <a href={r.href} onClick={event => { event.preventDefault(); void api.links.open(r.href!) }}>{r.value}</a>
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
