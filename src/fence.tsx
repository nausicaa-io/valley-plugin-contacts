/**
 * ```contacts``` code block — a contact card embedded in a note.
 *
 *   ```contacts
 *   target: Jane Smith
 *   style: card            (card | inline)
 *   show:
 *     - phone
 *     - email
 *     - place
 *   ```
 *
 * `show` picks the detail lines (phone, email, place, birthdate, profession,
 * organization); omit it for the default (phone + email + place). The card
 * opens the real contact in the Contacts page.
 */
import codeBlockExamples from './codeBlockExamples.json'
import { React, api } from './runtime'
import type { FC } from 'react'
import { assetUrlForRelPath } from '@valley/plugin-sdk/fileTypes'
import { parseFenceParams } from '@valley/plugin-sdk/fenceParams'
import { getStore } from './store'
import { paletteCssValue } from '@valley/plugin-sdk/palette'
import { groupColorFor } from './data'
import type { Contact } from './types'
import { uiText } from './localization'

const STYLE_ID = 'notes-contacts-fence-styles'

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.contacts-fence { margin: 0.75em 0; }
.contacts-fence-card { display: flex; gap: 12px; padding: 12px; border: 1px solid var(--border-light); border-radius: var(--radius); background: var(--container-color); cursor: pointer; }
.contacts-fence-card:hover { background: var(--hover-bg); }
.contacts-fence-avatar { flex: none; width: 48px; height: 48px; border-radius: 50%; overflow: hidden; display: flex; align-items: center; justify-content: center; background: var(--surface-color); color: var(--text-secondary); font-weight: 600; }
.contacts-fence-avatar img { width: 100%; height: 100%; object-fit: cover; }
.contacts-fence-main { min-width: 0; flex: 1; }
.contacts-fence-name { font-weight: 600; color: var(--title-color); }
.contacts-fence-line { font-size: var(--small-font-size); color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.contacts-fence-line b { color: var(--text-color); font-weight: 500; }
.contacts-fence-inline { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px 2px 4px; border: 1px solid var(--border-light); border-radius: 999px; background: var(--container-color); cursor: pointer; }
.contacts-fence-inline:hover { background: var(--hover-bg); }
.contacts-fence-inline .contacts-fence-avatar { width: 22px; height: 22px; font-size:10px; }
.contacts-fence-empty { padding: 10px 12px; border: 1px solid var(--border-light); border-radius: var(--radius); color: var(--text-secondary); font-size: var(--small-font-size); }
`
  document.head.appendChild(style)
}

const DEFAULT_SHOW = ['phone', 'email', 'place']

const norm = (value: string): string => value.trim().toLowerCase()

export function findContact(contacts: Contact[], query: string): Contact | null {
  const wanted = norm(query)
  return (
    contacts.find((c) => norm(c.displayName) === wanted) ??
    contacts.find((c) => norm(c.fileName) === wanted) ??
    contacts.find((c) => norm(`${c.firstName} ${c.lastName}`.trim()) === wanted) ??
    contacts.find((c) => norm(c.displayName).includes(wanted)) ??
    null
  )
}

function detailLines(contact: Contact, show: string[]): { label: string; value: string }[] {
  const lines: { label: string; value: string }[] = []
  for (const field of show) {
    switch (norm(field)) {
      case 'phone':
        for (const m of contact.phone) lines.push({ label: m.type || 'phone', value: m.value })
        break
      case 'email':
        for (const m of contact.email) lines.push({ label: m.type || 'email', value: m.value })
        break
      case 'place':
      case 'location':
      case 'address':
        for (const m of contact.place) lines.push({ label: m.type || 'place', value: m.value })
        break
      case 'birthdate':
      case 'birthday':
        if (contact.birthdate) lines.push({ label: 'birthday', value: contact.birthdate })
        break
      case 'profession':
        if (contact.profession) lines.push({ label: 'profession', value: contact.profession })
        break
      case 'organization':
      case 'org':
        for (const org of contact.organization) {
          const value = [org.name, org.title].filter(Boolean).join(' · ')
          if (value) lines.push({ label: 'org', value })
        }
        break
    }
  }
  return lines
}

const initials = (contact: Contact): string =>
  (contact.firstName[0] ?? contact.displayName[0] ?? '?') + (contact.lastName[0] ?? '')

const ContactsFence: FC<{ code: string }> = ({ code }) => {
  const store = getStore(api)
  const snap = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
  const params = parseFenceParams(code)
  const target = params.values.target ?? params.values.contact ?? params.bare
  const inline = (params.values.style ?? 'card').toLowerCase() === 'inline'
  const show = params.lists.show?.length ? params.lists.show : DEFAULT_SHOW

  if (!target) return <div className="contacts-fence-empty">{uiText('auto.34b250611c6f')}</div>
  const contact = findContact(snap.contacts, target)
  if (!contact) return <div className="contacts-fence-empty">{uiText('auto.2d84548e6570')}{' '}{target}{' '}{uiText('auto.792c40464917')}</div>

  const coverPath = snap.coverPaths[contact.relPath]
  const accent = paletteCssValue(groupColorFor(contact.groups[0], snap.groupConfigs))
  const open = (): void => {
    store.openContact(contact.relPath)
    api.workspace.openMainTab()
  }
  const avatar = (
    <span className="contacts-fence-avatar" style={{ boxShadow: `0 0 0 2px ${accent}` }}>
      {coverPath ? <img src={assetUrlForRelPath(coverPath)} alt="" /> : initials(contact)}
    </span>
  )

  if (inline) {
    return (
      <span className="contacts-fence-inline" onClick={open} title={uiText('auto.9c7af6130b43')}>
        {avatar}
        <span>{contact.displayName}</span>
      </span>
    )
  }

  return (
    <div className="contacts-fence-card" onClick={open} title={uiText('auto.9c7af6130b43')}>
      {avatar}
      <div className="contacts-fence-main">
        <div className="contacts-fence-name">{contact.displayName}</div>
        {detailLines(contact, show).map((line, index) => (
          <div key={index} className="contacts-fence-line">
            <b>{line.label}</b> {line.value}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Register the ```contacts``` fence; returns the unregister fn. */
export function registerContactsFence(): () => void {
  const off = api.markdown.registerCodeBlockRenderer('contacts', (code, el) => {
    ensureStyles()
    el.classList.add('contacts-fence')
    return api.ui.renderReact(el, <ContactsFence code={code} />)
  }, { examples: codeBlockExamples.contacts })
  return () => {
    off()
    document.getElementById(STYLE_ID)?.remove()
  }
}
