import { WORKSPACE_DETAILS_V1, type ValleyPluginApi, type WorkspaceDetailsContext } from '@valley/plugin-sdk'
import { React, api } from './runtime'
import type { Contact } from './types'
import { getStore } from './store'
import { ContactForm } from './ContactForm'
import { DetailView } from './DetailView'
import { formatContactDate } from './util'
import { uiText } from './localization'

type Mode = 'reading' | 'editing'
function state(owner = api) {
  return owner.runtime.getOrCreate('contacts.views', () => ({ modes: new Map<string, Mode>(), contacts: new Map<string, Contact>(), listeners: new Set<() => void>() }))
}
function notify(owner = api): void { for (const listener of state(owner).listeners) listener() }
function subscribe(listener: () => void, owner = api): () => void {
  state(owner).listeners.add(listener)
  return () => { state(owner).listeners.delete(listener) }
}
export function setContactMode(path: string, mode: Mode, owner = api): void {
  state(owner).modes.set(path, mode)
  notify(owner)
}

export function ContactContent({ contact }: { contact: Contact }) {
  const owner = api
  const path = contact.relPath
  const mode = React.useSyncExternalStore(listener => subscribe(listener, owner), () => state(owner).modes.get(path) ?? 'reading')
  const [hasEdited, setHasEdited] = React.useState(mode === 'editing')
  const root = React.useRef<HTMLDivElement>(null)
  const previousMode = React.useRef(mode)
  React.useEffect(() => {
    if (previousMode.current !== mode) root.current?.focus({ preventScroll: true })
    previousMode.current = mode
  }, [mode])
  React.useEffect(() => { if (mode === 'editing') setHasEdited(true) }, [mode])
  React.useEffect(() => { state(owner).contacts.set(path, contact); notify(owner) }, [owner, path, contact])
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'e') return
      const current = owner.getState()
      if (current.activePath !== path && !(current.activePluginTab?.pluginId === 'contacts' && getStore(owner).getSnapshot().selectedPath === path)) return
      event.preventDefault()
      event.stopPropagation()
      setContactMode(path, mode === 'reading' ? 'editing' : 'reading', owner)
    }
    const window = root.current?.ownerDocument.defaultView
    window?.addEventListener('keydown', onKey)
    return () => window?.removeEventListener('keydown', onKey)
  }, [owner, path, mode])
  return <div ref={root} tabIndex={-1} className="ct-contact-content">
    {mode === 'reading' && <DetailView contact={contact} />}
    {(hasEdited || mode === 'editing') && <div hidden={mode !== 'editing'}><ContactForm contact={contact} autosave compact={false} /></div>}
  </div>
}

export function registerContactDetails(owner: ValleyPluginApi): () => void {
  const fields = ['name', 'groups', 'birthday', 'email', 'phone', 'organization', 'profession', 'nickname', 'address', 'website'] as const
  const selected = (context: WorkspaceDetailsContext): Contact | undefined => {
    const snap = getStore(owner).getSnapshot()
    if (!context.filePath && (snap.mode === 'graph' || snap.mode === 'create')) return undefined
    const path = context.filePath ?? snap.selectedPath ?? ''
    return snap.contacts.find(contact => contact.relPath === path) ?? state(owner).contacts.get(path)
  }
  return owner.interop.extensions.provide(WORKSPACE_DETAILS_V1, {
    id: 'contacts.details', label: 'Contact', labelKey: 'contacts.properties.title', fileExtensions: ['.vcf'], pluginViews: true,
    items: [...fields.map(id => ({ id, label: id[0].toUpperCase() + id.slice(1), labelKey: `contacts.footer.${id}`, kind: 'text' as const })),
      { id: 'view', label: 'View mode', labelKey: 'contacts.footer.view', kind: 'select' }],
    defaultItems: ['name', 'groups', 'view'],
    getSnapshot(context) {
      const contact = selected(context)
      if (!contact) return { items: {} }
      const values = {
        name: contact.displayName, groups: contact.groups.join(', '), birthday: formatContactDate(contact.birthdate, owner.getState().dateFormat),
        email: contact.email.map(entry => entry.value).join(', '), phone: contact.phone.map(entry => entry.value).join(', '),
        organization: contact.organization.map(entry => [entry.name, entry.title].filter(Boolean).join(' · ')).join(', '),
        profession: contact.profession, nickname: contact.nickname, address: contact.place.map(entry => entry.value).join(', '), website: contact.websites.join(', ')
      }
      return { items: { ...Object.fromEntries(fields.map(id => [id, { text: values[id], available: Boolean(values[id]) }])),
        view: { value: state(owner).modes.get(contact.relPath) ?? 'reading', options: [
          { value: 'reading', label: uiText('contacts.mode.reading') }, { value: 'editing', label: uiText('contacts.mode.editing') }
        ] }
      } }
    },
    subscribe(listener) {
      const offView = subscribe(listener, owner)
      const offStore = getStore(owner).subscribe(listener)
      return () => { offView(); offStore() }
    },
    invoke(context, id, value) {
      const contact = selected(context)
      if (contact && id === 'view' && (value === 'reading' || value === 'editing')) setContactMode(contact.relPath, value, owner)
    }
  })
}
