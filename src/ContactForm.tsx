import { useContactIcons } from './contactIcons'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import { React, api as runtimeApi } from './runtime'
import type { MountedPluginView, PluginEditorProvider, ValleyPluginApi } from '@valley/plugin-sdk'
import type { TextDocumentRead } from '@valley/plugin-sdk/types'
import type { Contact, ContactLabel, ContactLabelKind, ContactMethod, Organization, RelationType, Social, SocialLink } from './types'
import { RELATION_TYPES } from './types'
import { getStore } from './store'
import { paletteCssValue } from '@valley/plugin-sdk/palette'
import { allGroups, getSettings, useContactLabels, contactFileBase, groupColorFor, normalizeGroupName, parentGroupName, readContactDocument, relationLabel, relationTarget, saveContact, UNTITLED_FILE_BASE } from './data'
import { emptyContact, parseContactFile, storedAddressPlace } from './schema'
import { RELATION_LABELS } from './relationGraphModel'
import { GripVertical, Plus, X } from './icons'
import { canonicalPlatform, resolveSocial } from './social'
import { sanitizeFileName } from './contactDocuments'
import { getSocialLinks } from './data'
import { dateFormatPlaceholder, formatContactDate, initials, parseContactDateInput } from './util'
import { assetUrlForRelPath } from '@valley/plugin-sdk/fileTypes'
import { PhotoField } from './PhotoEditor'
import { getContactGroups } from './groups'
import { uiText } from './localization'
import { useContactFileActions, type ContactFileActionContext } from './fileViewCommands'

const BLANK: Contact = emptyContact()

/** A relation row: the name shown, plus the stored target it came from. */
interface RelDraft { toName: string; ref: string; label: string; type: RelationType; role: string }

/** Draft keys that are bookkeeping, not contact edits. */
const DRAFT_STATE = new Set(['ownPath', 'sourceContact', 'expectedDocument', 'ready', 'saving', 'error', 'revision', 'savedRevision', 'committedRevision', 'fileNameEdited'])

/** A social row while it is being edited. Reordering needs an id that survives
 *  the move, and a `Social` has none — two blank rows are indistinguishable. */
interface SocialRow { uid: string; value: Social }

let socialRowSeq = 0
function newSocialRow(value: Social = {}): SocialRow {
  socialRowSeq += 1
  return { uid: `social-${socialRowSeq}`, value }
}

/** Imperative handle the Page's top-bar Cancel/Save buttons drive. */
export interface ContactFormHandle {
  save: () => void
  cancel: () => void
}

interface ContactFormProps {
  contact: Contact | null
  mountedView?: MountedPluginView
  /** Save each change shortly after typing stops. */
  autosave?: boolean
  compact?: boolean
  /** Ref the Page's top-bar Cancel/Save buttons drive imperatively. */
  controlRef?: React.MutableRefObject<ContactFormHandle | null>
  /** Reports save availability so the top bar can enable/label its Save button. */
  onActionState?: (state: { saving: boolean; canSave: boolean; label: string }) => void
}

interface ContactDraft {
  fields: Map<string, unknown>
  listeners: Set<() => void>
  identity: string
  fences: number
  /** Fences raised for this form's own save: typing goes on, into `pending`, and lands when the save releases (17 Nov). */
  ownFences: number
  pending: Map<string, unknown>
  /** Leases this draft gave the host, until released (by the host, at the host's deadline, or when this form's own save settles). */
  leases: Set<DraftLease>
  /** Set by an autosaving form: its last editor saves what is left before it lets go. */
  autosave?: boolean
  mounts: Set<string>
  owners: Map<string, { view: MountedPluginView } | { path: string; instanceId: string }>
  ownerMountId?: string | null
}

interface DraftLease { own: boolean; fenceId: string; release(): void }

/** After the host's fence deadline a lease whose release never arrived releases itself (18 Nov). */
const LEASE_GRACE_MS = 1000

/** Releases the fences of this draft's own saves, with every copy's lease in them: once a save has settled, the host has nothing of it left to hold. */
function releaseOwnLeases(draft: ContactDraft): void {
  const fences = new Set([...draft.leases].filter(lease => lease.own).map(lease => lease.fenceId))
  for (const lease of [...draft.leases]) if (fences.has(lease.fenceId)) lease.release()
}

function notifyDraft(draft: ContactDraft): void {
  for (const listener of [...draft.listeners]) listener()
}

function contactDraft(api: ValleyPluginApi, key: string): ContactDraft {
  const drafts = api.runtime.getOrCreate('contacts.formDrafts', () => new Map<string, ContactDraft>())
  let draft = drafts.get(key)
  if (!draft) {
    draft = { fields: new Map(), listeners: new Set(), identity: crypto.randomUUID(), fences: 0, ownFences: 0, pending: new Map(), leases: new Set(), mounts: new Set(), owners: new Map() }
    drafts.set(key, draft)
  }
  return draft
}

function useContactField<T>(api: ValleyPluginApi, key: string, field: string, initial: T | (() => T), ownerId?: string): [T, React.Dispatch<React.SetStateAction<T>>] {
  const draft = contactDraft(api, key)
  const initialRef = React.useRef(initial)
  initialRef.current = initial
  const read = React.useCallback((): T => {
    if (draft.pending.has(field)) return draft.pending.get(field) as T
    if (!draft.fields.has(field)) {
      const seed = initialRef.current
      draft.fields.set(field, typeof seed === 'function' ? (seed as () => T)() : seed)
    }
    return draft.fields.get(field) as T
  }, [draft, field])
  const value = React.useSyncExternalStore(
    React.useCallback((listener) => {
      draft.listeners.add(listener)
      return () => { draft.listeners.delete(listener) }
    }, [draft]),
    read,
    read
  )
  const setValue = React.useCallback((next: React.SetStateAction<T>) => {
    if (ownerId && key !== '__new__' && !draft.mounts.has(ownerId)) return
    const value = typeof next === 'function' ? (next as (previous: T) => T)(read()) : next
    if (draft.fences && !DRAFT_STATE.has(field)) {
      // A foreign preparation holds the draft still; during this form's own save the edit waits for the release.
      if (draft.fences !== draft.ownFences) return
      draft.pending.set(field, value)
      if (draft.ownerMountId === undefined || draft.ownerMountId !== null && !draft.mounts.has(draft.ownerMountId)) draft.ownerMountId = ownerId ?? null
      for (const listener of draft.listeners) listener()
      return
    }
    draft.fields.set(field, value)
    if (!DRAFT_STATE.has(field)) {
      if (draft.ownerMountId === undefined || draft.ownerMountId !== null && !draft.mounts.has(draft.ownerMountId)) draft.ownerMountId = ownerId ?? null
      draft.fields.set(`changed:${field}`, true)
      draft.fields.set('revision', ((draft.fields.get('revision') as number | undefined) ?? 0) + 1)
    }
    for (const listener of draft.listeners) listener()
  }, [draft, field, read, ownerId, key])
  return [value, setValue]
}

/** Drop a draft nobody is editing (the sidebar re-reads the card next time). */
function forgetContactDraft(api: ValleyPluginApi, key: string): void {
  api.runtime.getOrCreate('contacts.formDrafts', () => new Map<string, ContactDraft>()).delete(key)
}

function clearContactDraft(api: ValleyPluginApi, key: string): void {
  const draft = contactDraft(api, key)
  if (draft.fences) return
  draft.fields.clear()
  draft.ownerMountId = undefined
  for (const listener of draft.listeners) listener()
}

function registerContactEditor(owner: ValleyPluginApi, path: string, instanceId: string, target: { view: MountedPluginView } | { path: string; instanceId: string }, register: (provider: PluginEditorProvider) => () => void): () => void {
  const draft = contactDraft(owner, path)
  let active = true
  draft.mounts.add(instanceId)
  draft.owners.set(instanceId, target)
  if (draft.ownerMountId && !draft.mounts.has(draft.ownerMountId)) draft.ownerMountId = instanceId
  const snapshot = () => {
    const alias = Boolean(draft.ownerMountId && draft.ownerMountId !== instanceId)
    const dirty = (draft.fields.get('revision') ?? 0) !== (draft.fields.get('committedRevision') ?? 0)
    return { revision: `${draft.identity}:${draft.fields.get('revision') ?? 0}`, dirty: !alias && dirty,
      readiness: alias ? 'ready' as const : draft.fields.get('error') ? 'uncertain' as const : draft.fields.get('saving') && dirty ? 'saving' as const : draft.fields.get('ready') === false ? 'loading' as const : 'ready' as const }
  }
  const off = register({
    getSnapshot: snapshot,
    subscribe: listener => { draft.listeners.add(listener); return () => { draft.listeners.delete(listener) } },
    prepare: (expected, request) => {
      const observed = snapshot()
      if (!active || observed.revision !== expected || observed.dirty && !request.ownSave || observed.readiness !== 'ready' && !(request.ownSave && observed.readiness === 'saving')) throw new Error('The contact draft changed before preparation')
      draft.fences++
      if (request.ownSave) draft.ownFences++
      for (const listener of draft.listeners) listener()
      let released = false
      // A release that never arrives (the view closed during the save, a lost message) must not hold the draft for
      // the rest of the session: nothing typed would be saved again (18 Nov).
      const lease: DraftLease = { own: request.ownSave, fenceId: request.fenceId, release: () => {
        if (released) return
        released = true
        clearTimeout(expiry)
        draft.leases.delete(lease)
        draft.fences--
        if (request.ownSave) draft.ownFences--
        if (!draft.fences && draft.pending.size) {
          // What was typed during the save is the next revision: dirty again, so autosave writes it next.
          for (const [field, value] of draft.pending) { draft.fields.set(field, value); draft.fields.set(`changed:${field}`, true) }
          draft.pending.clear()
          draft.fields.set('revision', ((draft.fields.get('revision') as number | undefined) ?? 0) + 1)
        }
        notifyDraft(draft)
      } }
      const expiry = setTimeout(lease.release, Math.max(0, request.deadline - Date.now()) + LEASE_GRACE_MS)
      draft.leases.add(lease)
      return { validate: snapshot, release: lease.release }
    }
  })
  return () => {
    let finished = false
    const finish = (): void => { if (finished) return; finished = true; active = false; draft.mounts.delete(instanceId); draft.owners.delete(instanceId); off() }
    const unsaved = draft.pending.size > 0 || draft.fences > 0 || (draft.fields.get('revision') ?? 0) !== (draft.fields.get('committedRevision') ?? 0)
    // The last copy of an autosaving form saves what is left, through its still registered editor, before it lets go.
    if (!draft.autosave || draft.mounts.size !== 1 || !unsaved) { finish(); return }
    void flushContactDraft(owner, path, draft, target).finally(finish)
  }
}

interface DraftValues {
  firstName: string; middleName: string; lastName: string; nickname: string; birthdate: string; profession: string; cover: string; photo: string
  groups: string[]; phone: ContactMethod[]; email: ContactMethod[]; place: ContactMethod[]; organization: Organization[]; social: SocialRow[]
  websites: ContactMethod[]; relations: RelDraft[]; note: string
}

/** The card a draft's values describe, as the form saves it. */
function contactFromDraft(base: Contact, values: DraftValues, dateFormat: string, contacts: Contact[]): Contact {
  return {
    ...base,
    firstName: values.firstName.trim(),
    middleName: values.middleName.trim(),
    lastName: values.lastName.trim(),
    nickname: values.nickname.trim(),
    birthdate: parseContactDateInput(values.birthdate, dateFormat),
    profession: values.profession.trim(),
    // A new photo is embedded in the card and replaces a linked cover image.
    photo: values.photo,
    cover: values.photo !== base.photo ? '' : values.cover.trim(),
    groups: values.groups,
    phone: values.phone.filter((m) => m.value.trim()),
    email: values.email.filter((m) => m.value.trim()),
    place: values.place.filter((m) => m.value.trim()),
    organization: values.organization.filter((o) => o.name || o.title || o.dept),
    socialMedia: values.social
      .map((row) => row.value)
      .filter((s) => s.platform || s.handle || s.url)
      .map((s) => ({ ...s, platform: s.platform ? canonicalPlatform(s.platform) : s.platform })),
    websites: values.websites.filter((w) => w.value.trim()),
    relations: values.relations
      .filter((r) => r.toName.trim())
      .map((r) => ({ to: r.ref && r.toName === r.label ? r.ref : relationTarget(r.toName, contacts), type: r.type, role: r.role.trim() || undefined })),
    note: values.note
  }
}

/**
 * Saves a draft whose form is gone (its view closed while typing was still waiting for the autosave or for its own
 * save): waits until no fence holds it, then writes its values through the editor that is still registered. A save
 * that cannot be written leaves the draft dirty with its error, shown by the next form of this contact.
 */
async function flushContactDraft(owner: ValleyPluginApi, path: string, draft: ContactDraft, target: { view: MountedPluginView } | { path: string; instanceId: string }): Promise<void> {
  while (draft.fences > 0 || draft.fields.get('saving')) {
    await new Promise<void>(resolve => {
      const listener = (): void => { if (draft.fences > 0 || draft.fields.get('saving')) return; draft.listeners.delete(listener); resolve() }
      draft.listeners.add(listener)
    })
  }
  const fields = draft.fields
  const revision = (fields.get('revision') as number | undefined) ?? 0
  const source = fields.get('sourceContact') as Contact | undefined
  const expected = fields.get('expectedDocument') as TextDocumentRead | undefined
  if (!fields.get('ready') || !source || !expected || revision === ((fields.get('committedRevision') as number | undefined) ?? 0)) return
  const dateFormat = owner.getState().dateFormat
  const contacts = getStore(owner).getSnapshot().contacts
  const value = <T,>(key: string, fallback: T): T => fields.has(key) ? fields.get(key) as T : fallback
  const values: DraftValues = {
    firstName: value('firstName', source.firstName), middleName: value('middleName', source.middleName), lastName: value('lastName', source.lastName), nickname: value('nickname', source.nickname),
    birthdate: value('birthdate', formatContactDate(source.birthdate, dateFormat)), profession: value('profession', source.profession), cover: value('cover', source.cover), photo: value('photo', source.photo),
    groups: value('groups', source.groups), phone: value('phone', source.phone), email: value('email', source.email), place: value('place', source.place), organization: value('organization', source.organization),
    social: value('social', source.socialMedia.map(row => newSocialRow(row))), websites: value('websites', source.websites), relations: value('relations', relationDrafts(source, contacts)), note: value('note', source.note)
  }
  const next = contactFromDraft(source, values, dateFormat, contacts)
  fields.set('saving', true)
  notifyDraft(draft)
  try {
    // The file keeps its name here; a rename waits for the next save from an open form.
    const saved = await saveContact(next, { previous: source, fileName: contactPathBase(path), document: expected }, owner, { ...target, revision: `${draft.identity}:${revision}`, committed: () => fields.set('committedRevision', revision) })
    if (!saved || saved.editorConflict) throw new Error(uiText('contacts.error.changed'))
    fields.set('committedRevision', revision)
    fields.set('expectedDocument', saved.document ?? undefined)
    fields.set('sourceContact', { ...next, displayName: source.displayName })
    fields.set('error', '')
  } catch (reason) {
    fields.set('error', reason instanceof Error ? reason.message : uiText('contacts.error.save'))
  } finally {
    fields.set('saving', false)
    fields.set('savedRevision', revision)
    releaseOwnLeases(draft)
    notifyDraft(draft)
  }
}

const contactPathBase = (path: string): string => (path.split('/').pop() ?? path).replace(/\.vcf$/i, '')

export const registerContactFileEditor = (owner: ValleyPluginApi, view: MountedPluginView): (() => void) => registerContactEditor(owner, view.filePath, view.mountId, { view }, provider => owner.realm.editors.register(view, provider))

/** Create / edit form rendering the contact schema as clean inputs. */
function relationDrafts(contact: Contact, contacts: Contact[]): RelDraft[] {
  return contact.relations.map((relation) => {
    const label = relationLabel(relation.to, contacts)
    return { toName: label, ref: relation.to, label, type: relation.type, role: relation.role ?? '' }
  })
}

/** The draft fields a freshly read card seeds. */
function draftFields(source: Contact, contacts: Contact[], dateFormat: string): Record<string, unknown> {
  return {
    ...source,
    sourceContact: source,
    birthdate: formatContactDate(source.birthdate, dateFormat),
    social: source.socialMedia.map(value => newSocialRow(value)),
    relations: relationDrafts(source, contacts),
    note: source.note
  }
}

export function ContactForm({ contact, mountedView, autosave = false, compact = autosave, controlRef, onActionState }: ContactFormProps): ReactElement {
  useContactIcons()
  const api = React.useMemo(() => runtimeApi, [])
  const store = getStore(api)
  // The host's styled dropdown — never a raw `<select>`, whose popup Chromium
  // hands to the OS unthemed and which ignores the native/custom menu setting.
  const { SelectField, useReorderDrag } = api.ui.settings
  const ComboField = api.ui.ComboField
  const snap = store.getSnapshot()
  const dateFormat = api.getState().dateFormat
  const socialLinks = getSocialLinks()
  const labels = useContactLabels(api)
  const draftKey = contact?.relPath ?? '__new__'
  const [instanceId] = React.useState(() => `contact-form-${crypto.randomUUID()}`)
  const editorId = mountedView?.mountId ?? instanceId
  const mountedKey = mountedView ? JSON.stringify([mountedView.mountId, mountedView.generation, mountedView.area, mountedView.paneId, mountedView.tabId, mountedView.filePath, mountedView.pluginId]) : ''
  React.useEffect(() => {
    if (mountedKey || !contact?.relPath) return
    return registerContactEditor(api, contact.relPath, instanceId, { path: contact.relPath, instanceId }, provider => api.realm.editors.registerDocument(contact.relPath, instanceId, provider))
  }, [api, contact?.relPath, instanceId, mountedKey])
  if (autosave) contactDraft(api, draftKey).autosave = true
  const form = React.useRef<HTMLDivElement>(null)
  const [prepared, setPrepared] = React.useState(false)
  React.useEffect(() => {
    const draft = contactDraft(api, draftKey)
    // Only a foreign preparation (a rename, a command from elsewhere) makes the form inert; its own autosave never
    // does, so typing is not interrupted. When the form comes back, focus and selection return where they were.
    let held: { element: HTMLElement; start: number | null; end: number | null; direction: 'forward' | 'backward' | 'none' | null } | null = null
    const listener = () => {
      setPrepared(draft.fences > 0)
      const element = form.current
      if (!element) return
      const inert = draft.fences > draft.ownFences
      if (inert === element.inert) return
      if (inert) {
        const active = element.ownerDocument.activeElement
        held = active instanceof HTMLElement && element.contains(active)
          ? { element: active, ...(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? { start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection } : { start: null, end: null, direction: null }) }
          : null
        element.inert = true
        return
      }
      element.inert = false
      const restore = held
      held = null
      if (!restore || !restore.element.isConnected || element.ownerDocument.activeElement !== element.ownerDocument.body && element.ownerDocument.activeElement !== null) return
      restore.element.focus({ preventScroll: true })
      if (restore.start !== null && (restore.element instanceof HTMLInputElement || restore.element instanceof HTMLTextAreaElement)) {
        try { restore.element.setSelectionRange(restore.start, restore.end ?? restore.start, restore.direction ?? undefined) } catch { /* inputs without a selection API keep the caret where focus puts it */ }
      }
    }
    draft.listeners.add(listener)
    listener()
    return () => { draft.listeners.delete(listener) }
  }, [api, draftKey])
  const base = (contactDraft(api, draftKey).fields.get('sourceContact') as Contact | undefined) ?? contact ?? BLANK
  const [firstName, setFirstName] = useContactField(api, draftKey, 'firstName', base.firstName, editorId)
  const [middleName, setMiddleName] = useContactField(api, draftKey, 'middleName', base.middleName, editorId)
  const [lastName, setLastName] = useContactField(api, draftKey, 'lastName', base.lastName, editorId)
  const [nickname, setNickname] = useContactField(api, draftKey, 'nickname', base.nickname, editorId)
  const [birthdate, setBirthdate] = useContactField(api, draftKey, 'birthdate', formatContactDate(base.birthdate, dateFormat), editorId)
  const [profession, setProfession] = useContactField(api, draftKey, 'profession', base.profession, editorId)
  const [cover, setCover] = useContactField(api, draftKey, 'cover', base.cover, editorId)
  const [photo, setPhoto] = useContactField(api, draftKey, 'photo', base.photo, editorId)
  const [groups, setGroups] = useContactField(api, draftKey, 'groups', base.groups, editorId)
  const [groupDraft, setGroupDraft] = React.useState('')
  const [dragIndex, setDragIndex] = React.useState<number | null>(null)
  const [phone, setPhone] = useContactField<ContactMethod[]>(api, draftKey, 'phone', base.phone, editorId)
  const [email, setEmail] = useContactField<ContactMethod[]>(api, draftKey, 'email', base.email, editorId)
  const [place, setPlace] = useContactField<ContactMethod[]>(api, draftKey, 'place', base.place, editorId)
  const [organization, setOrganization] = useContactField<Organization[]>(api, draftKey, 'organization', base.organization, editorId)
  const [social, setSocial] = useContactField<SocialRow[]>(api, draftKey, 'social', () => base.socialMedia.map((s) => newSocialRow(s)), editorId)
  const [websites, setWebsites] = useContactField<ContactMethod[]>(api, draftKey, 'websites', base.websites, editorId)
  const [relations, setRelations] = useContactField<RelDraft[]>(api, draftKey, 'relations', () => relationDrafts(base, snap.contacts), editorId)
  const [note, setNote] = useContactField(api, draftKey, 'note', base.note, editorId)
  const [valleyReady, setNotesReady] = useContactField(api, draftKey, 'ready', !contact?.relPath)
  const [revision] = useContactField(api, draftKey, 'revision', 0)
  const [savedRevision, setSavedRevision] = useContactField(api, draftKey, 'savedRevision', 0)
  const [, setCommittedRevision] = useContactField(api, draftKey, 'committedRevision', 0)
  const [saving, setSaving] = useContactField(api, draftKey, 'saving', false)
  const [fileName, setFileName] = useContactField(api, draftKey, 'fileName', '', editorId)
  const [fileNameEdited, setFileNameEdited] = useContactField(api, draftKey, 'fileNameEdited', false)
  const knownGroups = allGroups(getContactGroups(api)).filter((g) => !groups.includes(g))
  // Social rows are ordered by hand — the detail view and the note's YAML both
  // keep that order, so it is the person's own ranking of where to reach them.
  const socialReorder = useReorderDrag<SocialRow>({
    items: social,
    getId: (row) => row.uid,
    getLabel: (row) => row.value.platform || uiText('auto.123a7f2fcc9a'),
    onReorder: setSocial
  })

  // The file name mirrors the person's name while the note still carries it, and
  // freezes on a hand-named file — typing here wins over both.
  const derivedFileName = contactFileBase({ ...base, firstName, lastName, nickname })
  const fileNameInSync = !contact || contact.fileName === contactFileBase(contact)
  const fileNameValue = fileNameEdited
    ? fileName
    : fileNameInSync
      ? derivedFileName
      : base.fileName
  // No two cards share a file name in one folder (18 Nov): a name another card of this folder already has, in any
  // case, is refused with a note under the field, and the file keeps its current name until the name is changed.
  const folderOf = (path: string): string => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  const ownFolder = contact?.relPath ? folderOf(contact.relPath) : getSettings(api).contactsRoot
  const wantedName = sanitizeFileName(fileNameValue) || UNTITLED_FILE_BASE
  const fileNameTaken = wantedName.toLowerCase() !== (contact?.fileName ?? '').toLowerCase()
    && snap.contacts.some((other) => other.relPath !== contact?.relPath && other.relPath !== contactDraft(api, draftKey).fields.get('ownPath')
      && !(base.uid && other.uid === base.uid) && folderOf(other.relPath) === ownFolder && other.fileName.toLowerCase() === wantedName.toLowerCase())

  const [expectedDocument, setExpectedDocument] = useContactField<TextDocumentRead | undefined>(api, draftKey, 'expectedDocument', undefined)
  const [error, setError] = useContactField(api, draftKey, 'error', '')

  React.useEffect(() => {
    let disposed = false
    if (contactDraft(api, draftKey).fields.get('ready')) return
    if (!contact?.relPath) {
      setNotesReady(true)
      return
    }
    setNotesReady(false)
    const draft = contactDraft(api, draftKey)
    void readContactDocument(contact.relPath, api).then((document) => {
      if (disposed || draft.fences) return
      const source = parseContactFile(contact.relPath, document.content)
      const fields = { ...draftFields(source, store.getSnapshot().contacts, dateFormat), expectedDocument: document, ready: true }
      for (const [key, value] of Object.entries(fields)) {
        if (DRAFT_STATE.has(key) || !draft.fields.get(`changed:${key}`)) draft.fields.set(key, value)
      }
      for (const listener of draft.listeners) listener()
    }).catch(() => {
      if (disposed) return
      setError(uiText('contacts.error.load'))
      setNotesReady(false)
    })
    return () => {
      disposed = true
    }
  }, [contact?.relPath, draftKey, valleyReady, api, dateFormat, setError, setNotesReady, store])

  // A card changed elsewhere (a chip in the page, another app) while nothing is
  // pending here: take the new bytes instead of saving over them later.
  const contactKey = contact ? JSON.stringify(contact) : ''
  React.useEffect(() => {
    if (!autosave || !contact?.relPath || !valleyReady) return
    const draft = contactDraft(api, draftKey)
    const source = draft.fields.get('sourceContact') as Contact | undefined
    if (!source || draft.fences || draft.fields.get('saving') || draft.fields.get('revision') !== draft.fields.get('committedRevision')) return
    const { relPath: _path, fileName: _name, displayName: _display, ...current } = contact
    const { relPath: _sourcePath, fileName: _sourceName, displayName: _sourceDisplay, ...known } = source
    if (JSON.stringify(current) === JSON.stringify(known)) return
    let disposed = false
    void readContactDocument(contact.relPath, api).then((document) => {
      if (disposed || draft.fences || draft.fields.get('revision') !== draft.fields.get('committedRevision')) return
      const fresh = parseContactFile(contact.relPath, document.content)
      for (const [key, value] of Object.entries({ ...draftFields(fresh, store.getSnapshot().contacts, dateFormat), expectedDocument: document, error: '' })) draft.fields.set(key, value)
      for (const key of [...draft.fields.keys()]) if (key.startsWith('changed:')) draft.fields.delete(key)
      for (const listener of draft.listeners) listener()
    }).catch(() => {})
    return () => { disposed = true }
  }, [autosave, contactKey, contact, valleyReady, api, draftKey, dateFormat, store])

  const groupStyle = (group: string): CSSProperties => {
    return { '--ct-group-color': paletteCssValue(groupColorFor(group, snap.groupConfigs)) } as CSSProperties
  }

  const addGroup = (): void => {
    const key = normalizeGroupName(groupDraft)
    const next = knownGroups.find((group) => normalizeGroupName(group) === key)
    setGroupDraft('')
    if (!next || groups.some((group) => normalizeGroupName(group) === key)) return
    setGroups([...groups, next])
  }

  const moveGroup = (from: number, to: number): void => {
    if (from === to || from < 0 || to < 0 || from >= groups.length || to >= groups.length) return
    const next = groups.slice()
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    setGroups(next)
  }

  const save = async (commandContext?: ContactFileActionContext): Promise<void> => {
    const draft = contactDraft(api, draftKey)
    if (!valleyReady || contact?.relPath && !draft.mounts.has(editorId) || draft.fences || draft.fields.get('saving')) { if (commandContext) throw Object.assign(new Error('The exact Contact editor is unavailable.'), { outcome: 'not-applied' }); return }
    // A new card is not created under a name its folder already has; an existing one saves and keeps its name.
    if (!contact && fileNameTaken) { if (commandContext) throw Object.assign(new Error(uiText('contacts.form.fileNameTaken', { p0: wantedName })), { outcome: 'not-applied' }); return }
    const target = (draft.fields.get('revision') as number | undefined) ?? 0
    setSaving(true)
    setError('')
    const next = contactFromDraft(base, { firstName, middleName, lastName, nickname, birthdate, profession, cover, photo, groups, phone, email, place, organization, social, websites, relations, note }, dateFormat, snap.contacts)
    try {
      if (contact && !expectedDocument) throw new Error(uiText('contacts.error.changed'))
      const editor = contact?.relPath ? { ...(draft.owners.get(draft.ownerMountId ?? editorId) ?? (mountedView ? { view: mountedView } : { path: contact.relPath, instanceId })), revision: `${draft.identity}:${target}`, committed: () => setCommittedRevision(target) } : undefined
      const saved = await saveContact(next, { previous: base, fileName: fileNameTaken ? contact?.fileName : fileNameValue, document: expectedDocument }, api, editor, commandContext ? async paths => {
        await commandContext.validate(paths.map(path => ({ kind: 'file' as const, path, fileOperation: 'write' as const })))
        if (!draft.mounts.has(editorId) || draft.fences || draft.fields.get('revision') !== target || draft.ownerMountId && draft.ownerMountId !== editorId) throw Object.assign(new Error('The Contact draft changed before its file effect.'), { outcome: 'not-applied' })
      } : undefined)
      if (!saved) throw new Error(uiText('contacts.error.changed'))
      if (saved.editorConflict) throw new Error(uiText('contacts.error.changed'))
      // The card's own file, under its new name too, is never a namesake of itself.
      draft.fields.set('ownPath', saved.relPath)
      setCommittedRevision(target)
      if (autosave && contact && saved.relPath !== contact.relPath) {
        // Renamed: this form keeps showing the saved values until the sidebar
        // follows the file to its new name, which reads the card afresh.
        draft.fields.set('sourceContact', { ...next, displayName: base.displayName })
        store.openContact(saved.relPath, { reveal: false })
      } else if (!contact || saved.relPath !== contact.relPath) {
        clearContactDraft(api, draftKey)
        store.openContact(saved.relPath)
      } else {
        setExpectedDocument(saved.document ?? undefined)
        draft.fields.set('sourceContact', { ...next, displayName: base.displayName })
        if (!autosave) store.openContact(saved.relPath)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : uiText('contacts.error.save'))
      if (commandContext) throw reason
    } finally {
      setSaving(false)
      // A failed save waits for the next edit instead of retrying the same one.
      setSavedRevision(target)
      // The save has settled, so the host holds nothing of it any more, whether or not its release arrived.
      releaseOwnLeases(draft)
    }
  }

  const reload = (): void => {
    clearContactDraft(api, draftKey)
  }
  const requireDraft = (): void => {
    const draft = contactDraft(api, draftKey)
    if (!valleyReady || saving || prepared || draft.fences || !draft.mounts.has(editorId) || draft.ownerMountId && draft.ownerMountId !== editorId) throw Object.assign(new Error('The exact Contact raw draft is unavailable or belongs to another mounted copy.'), { code: 'CONTROL_UNAVAILABLE', outcome: 'not-applied' })
  }
  useContactFileActions(mountedView, 'form', {
    snapshot: () => {
      const draft = contactDraft(api, draftKey), fields = draft.fields
      const source = (fields.get('sourceContact') as Contact | undefined) ?? contact ?? BLANK
      const value = <T,>(key: string, fallback: T): T => fields.has(key) ? fields.get(key) as T : fallback
      const rawFirst = value('firstName', source.firstName), rawLast = value('lastName', source.lastName), rawNickname = value('nickname', source.nickname)
      const rawName = value('fileNameEdited', false) ? value('fileName', '') : fileNameInSync ? contactFileBase({ ...source, firstName: rawFirst, lastName: rawLast, nickname: rawNickname }) : source.fileName
      const rawRevision = value('revision', 0)
      return { firstName: rawFirst, middleName: value('middleName', source.middleName), lastName: rawLast, nickname: rawNickname, birthdate: value('birthdate', formatContactDate(source.birthdate, dateFormat)), profession: value('profession', source.profession), cover: value('cover', source.cover), fileName: rawName, note: value('note', source.note), groups: value('groups', source.groups), phone: value('phone', source.phone), email: value('email', source.email), place: value('place', source.place), organization: value('organization', source.organization), social: value('social', []), websites: value('websites', source.websites), relations: value('relations', []), ready: value('ready', false), saving: value('saving', false), prepared: draft.fences > 0, error: value('error', ''), editorRevision: `${draft.identity}:${rawRevision}`, dirty: rawRevision !== value('committedRevision', 0), ownsDraft: !draft.ownerMountId || draft.ownerMountId === editorId }
    },
    actions: {
      patch: action => {
        if (action.type !== 'patch') return
        requireDraft()
        const setters: Record<string, (value: string) => void> = { firstName: setFirstName, middleName: setMiddleName, lastName: setLastName, nickname: setNickname, birthdate: setBirthdate, profession: setProfession, cover: setCover, fileName: value => { setFileName(value); setFileNameEdited(true) }, note: setNote }
        for (const [key, value] of Object.entries(action.fields)) setters[key](value)
      },
      'row-add': action => {
        if (action.type !== 'row-add') return
        requireDraft()
        const rows = { phone, email, place, organization, social, website: websites, relation: relations }[action.collection]
        if (rows.length >= 256) throw Object.assign(new Error('The Contact row collection has reached its bound.'), { outcome: 'not-applied' })
        if (action.collection === 'phone') setPhone([...phone, { value: '' }])
        else if (action.collection === 'email') setEmail([...email, { value: '' }])
        else if (action.collection === 'place') setPlace([...place, { value: '' }])
        else if (action.collection === 'organization') setOrganization([...organization, {}])
        else if (action.collection === 'social') setSocial([...social, newSocialRow()])
        else if (action.collection === 'website') setWebsites([...websites, { value: '' }])
        else setRelations([...relations, { toName: '', ref: '', label: '', type: 'friend', role: '' }])
      },
      'row-edit': action => {
        if (action.type !== 'row-edit') return
        requireDraft()
        const rows = { phone, email, place, organization, social, website: websites, relation: relations }[action.collection]
        if (action.index >= rows.length) throw Object.assign(new Error('This exact Contact row is missing.'), { outcome: 'not-applied' })
        const i = action.index, fields = action.fields
        if (action.collection === 'phone') setPhone(replace(phone, i, { ...phone[i], ...fields }))
        else if (action.collection === 'email') setEmail(replace(email, i, { ...email[i], ...fields }))
        else if (action.collection === 'place') setPlace(replace(place, i, { ...place[i], ...fields }))
        else if (action.collection === 'organization') setOrganization(replace(organization, i, { ...organization[i], ...fields }))
        else if (action.collection === 'social') setSocial(replace(social, i, { ...social[i], value: { ...social[i].value, ...fields } }))
        else if (action.collection === 'website') setWebsites(replace(websites, i, { ...websites[i], ...fields }))
        else setRelations(replace(relations, i, { ...relations[i], ...fields } as RelDraft))
      },
      'row-remove': action => {
        if (action.type !== 'row-remove') return
        requireDraft()
        const rows = { phone, email, place, organization, social, website: websites, relation: relations }[action.collection]
        if (action.index >= rows.length) throw Object.assign(new Error('This exact Contact row is missing.'), { outcome: 'not-applied' })
        const i = action.index
        if (action.collection === 'phone') setPhone(remove(phone, i))
        else if (action.collection === 'email') setEmail(remove(email, i))
        else if (action.collection === 'place') setPlace(remove(place, i))
        else if (action.collection === 'organization') setOrganization(remove(organization, i))
        else if (action.collection === 'social') setSocial(remove(social, i))
        else if (action.collection === 'website') setWebsites(remove(websites, i))
        else setRelations(remove(relations, i))
      },
      'group-add': action => { if (action.type === 'group-add') { requireDraft(); const next = knownGroups.find(value => normalizeGroupName(value) === normalizeGroupName(action.value)); if (!next) throw Object.assign(new Error('This configured Contact group is unavailable.'), { outcome: 'not-applied' }); setGroups([...groups, next]) } },
      'group-remove': action => { if (action.type === 'group-remove') { requireDraft(); if (!groups.includes(action.value)) throw Object.assign(new Error('This exact Contact group is missing.'), { outcome: 'not-applied' }); setGroups(groups.filter(value => value !== action.value)) } },
      'group-move': action => { if (action.type === 'group-move') { requireDraft(); if (action.from >= groups.length || action.to >= groups.length) throw Object.assign(new Error('This Contact group position is missing.'), { outcome: 'not-applied' }); moveGroup(action.from, action.to) } },
      'social-move': action => { if (action.type === 'social-move') { requireDraft(); if (action.from >= social.length || action.to >= social.length) throw Object.assign(new Error('This Contact social row position is missing.'), { outcome: 'not-applied' }); const next = social.slice(), [row] = next.splice(action.from, 1); next.splice(action.to, 0, row); setSocial(next) } },
      'social-platform': action => { if (action.type === 'social-platform') { requireDraft(); if (!social[action.index]) throw Object.assign(new Error('This exact Contact social row is missing.'), { outcome: 'not-applied' }); setSocial(replace(social, action.index, { ...social[action.index], value: { ...social[action.index].value, platform: action.value } })) } },
      flush: async (_action, context) => { requireDraft(); await save(context) },
      reload: () => { const draft = contactDraft(api, draftKey); if (draft.fences || saving || !draft.mounts.has(editorId) || draft.ownerMountId && draft.ownerMountId !== editorId) throw Object.assign(new Error('This exact Contact draft cannot be reloaded.'), { outcome: 'not-applied' }); reload() },
      settings: async (_action, context) => { await context.validate(); await api.workspace.openSettings('plugin:contacts#groups') }
    }
  })
  React.useEffect(() => () => {
    if (!autosave) return
    const draft = contactDraft(api, draftKey)
    if (!draft.fences && !draft.mounts.size && !draft.fields.get('saving') && draft.fields.get('revision') === draft.fields.get('committedRevision')) forgetContactDraft(api, draftKey)
  }, [autosave, api, draftKey])

  const cancel = React.useCallback((): void => {
    clearContactDraft(api, draftKey)
    store.cancelEdit()
  }, [api, draftKey, store])

  // The top bar drives save/cancel imperatively via controlRef.
  const saveRef = React.useRef(save)
  saveRef.current = save
  React.useEffect(() => {
    if (!controlRef) return
    controlRef.current = { save: () => { void saveRef.current() }, cancel }
    return () => { controlRef.current = null }
  }, [controlRef, cancel])
  React.useEffect(() => {
    onActionState?.({ saving, canSave: valleyReady && !prepared && !(fileNameTaken && !contact), label: contact ? uiText('auto.efc007a393f6') : uiText('auto.6e157c5da441') })
  }, [saving, valleyReady, prepared, contact, onActionState, fileNameTaken])
  React.useEffect(() => {
    if (!autosave || !valleyReady || saving || revision === savedRevision) return
    const timer = window.setTimeout(() => { void saveRef.current() }, 600)
    return () => window.clearTimeout(timer)
  }, [autosave, valleyReady, saving, revision, savedRevision])

  return (
    <div ref={form} className={`ct-form${compact ? ' ct-form-compact' : ''}`}>
      {error && (
        <p role="alert" className="ct-form-error">
          {error}
          {autosave && <button type="button" className="ct-rep-add" onClick={reload}>{uiText('contacts.properties.reload')}</button>}
        </p>
      )}
      <PhotoField
        photo={photo}
        fallback={photo !== base.photo ? '' : snap.coverPaths[contact?.relPath ?? ''] ? assetUrlForRelPath(snap.coverPaths[contact?.relPath ?? '']!) : ''}
        initials={initials([firstName, lastName].filter(Boolean).join(' ') || nickname)}
        onChange={setPhoto}
      />
      <div className="ct-form-grid">
        <Field label={uiText('auto.7e568a90221d')}><input className="ct-input" value={firstName} onChange={(e) => setFirstName(val(e))} /></Field>
        <Field label={uiText('auto.adec36a821f8')}><input className="ct-input" value={lastName} onChange={(e) => setLastName(val(e))} /></Field>
        <Field label={uiText('auto.17dbdb86621f')}><input className="ct-input" value={middleName} onChange={(e) => setMiddleName(val(e))} /></Field>
        <Field label={uiText('auto.ce2bd99c4758')}><input className="ct-input" value={nickname} onChange={(e) => setNickname(val(e))} /></Field>
        <Field label={uiText('auto.ab5815528f10')}><BirthdateField api={api} value={birthdate} dateFormat={dateFormat} onChange={setBirthdate} /></Field>
        <Field label={uiText('auto.6f528041b7e1')}><input className="ct-input" value={profession} onChange={(e) => setProfession(val(e))} /></Field>
        <Field label={uiText('auto.09979a78c995')} full>
          <div className="ct-file-name">
            <input
              className="ct-input"
              aria-invalid={fileNameTaken || undefined}
              value={fileNameValue}
              placeholder={derivedFileName || UNTITLED_FILE_BASE}
              onChange={(e) => {
                setFileNameEdited(true)
                setFileName(val(e))
              }}
            />
            <span className="ct-file-ext">.vcf</span>
          </div>
          {fileNameTaken && <p role="alert" className="ct-field-error">{uiText('contacts.form.fileNameTaken', { p0: wantedName })}</p>}
        </Field>
        <Field label={uiText('auto.ae9629f4ebb8')} full>
          <div className="ct-group-editor">
            <div className="ct-group-pills">
              {groups.map((group, i) => (
                <span
                  key={group}
                  className="ct-group-pill"
                  draggable
                  style={groupStyle(group)}
                  onDragStart={() => setDragIndex(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (dragIndex !== null) moveGroup(dragIndex, i)
                    setDragIndex(null)
                  }}
                  onDragEnd={() => setDragIndex(null)}
                >
                  <span className="ct-chip-dot" aria-hidden="true" />
                  <span className="ct-chip-name">{parentGroupName(group, snap.groupConfigs) && <span className="ct-chip-parent">{parentGroupName(group, snap.groupConfigs)} · </span>}{group}</span>
                  <button
                    aria-label={uiText('auto.9a5319bc9fe3')}
                    onClick={() => {
                      const key = normalizeGroupName(group)
                      setGroups(groups.filter((g) => normalizeGroupName(g) !== key))
                    }}
                    title={uiText('auto.9a5319bc9fe3')}
                  >
                    <X />
                  </button>
                </span>
              ))}
            </div>
            <div className="ct-group-add">
              <ComboField
                className="ct-input"
                value={groupDraft}
                placeholder={uiText('auto.c33f059b0ca7')}
                ariaLabel={uiText('auto.c33f059b0ca7')}
                onChange={setGroupDraft}
                options={knownGroups.map((g) => ({ value: g, label: g }))}
                allowCustom={false}
              />
              <button className="ct-rep-add" onClick={addGroup}><Plus /> {uiText('auto.2fca464f9c89')}</button>
              <button className="ct-rep-add" onClick={() => api.workspace.openSettings('plugin:contacts#groups')}>
                {uiText('settings.section.groups')}
              </button>
            </div>
          </div>
        </Field>
      </div>

      {/* On a wide page the lists sit side by side; on a narrow one they stack, and each row stacks its own inputs (18 Nov). */}
      <div className="ct-form-sections">
      <MethodList api={api} kind="phone" labels={labels.phone} title={uiText('auto.77064d526523')} items={phone} setItems={setPhone} placeholder="+41 79 ..." />
      <MethodList api={api} kind="email" labels={labels.email} title={uiText('auto.84add5b29527')} items={email} setItems={setEmail} placeholder={uiText('auto.9703026304af')} />
      <PlaceList api={api} labels={labels.place} title={uiText('auto.d70f93df5e8f')} items={place} setItems={setPlace} placeholder={uiText('auto.4b4fa9d8f179')} />

      <div className="ct-rep">
        <div className="ct-form-section-title">{uiText('auto.519255ae1f74')}</div>
        {organization.map((o, i) => (
          <div className="ct-rep-row ct-multi-row" key={i}>
            <SubField label={uiText('contacts.form.orgName')}>
              <input className="ct-input" placeholder={uiText('contacts.form.orgNamePlaceholder')} aria-label={uiText('contacts.form.orgName')} value={o.name ?? ''} onChange={(e) => setOrganization(replace(organization, i, { ...o, name: val(e) }))} />
            </SubField>
            <SubField label={uiText('contacts.form.orgTitle')}>
              <input className="ct-input" placeholder={uiText('contacts.form.orgTitlePlaceholder')} aria-label={uiText('contacts.form.orgTitle')} value={o.title ?? ''} onChange={(e) => setOrganization(replace(organization, i, { ...o, title: val(e) }))} />
            </SubField>
            <SubField label={uiText('contacts.form.orgDept')}>
              <input className="ct-input" placeholder={uiText('contacts.form.orgDeptPlaceholder')} aria-label={uiText('contacts.form.orgDept')} value={o.dept ?? ''} onChange={(e) => setOrganization(replace(organization, i, { ...o, dept: val(e) }))} />
            </SubField>
            <button className="ct-rep-del" aria-label={uiText('contacts.form.removeRow')} title={uiText('contacts.form.removeRow')} onClick={() => setOrganization(remove(organization, i))}><X /></button>
          </div>
        ))}
        <button className="ct-rep-add" onClick={() => setOrganization([...organization, {}])}><Plus /> {uiText('auto.e6d645c114a5')}</button>
      </div>

      <div className="ct-rep">
        <div className="ct-form-section-title">{uiText('auto.7e89cf439cfd')}</div>
        {social.map((row, i) => {
          const handleProps = socialReorder.getHandleProps(row)
          return (
            <div
              className={`ct-rep-row ct-social-edit-row${socialReorder.overId === row.uid ? ` drop-${socialReorder.dropPosition ?? 'before'}` : ''}`}
              key={row.uid}
              {...socialReorder.getItemProps(row)}
            >
              <button
                {...handleProps}
                className={`${handleProps.className ?? ''} ct-social-grip`}
                title={uiText('contacts.social.reorder')}
              ><GripVertical /></button>
              <span className="ct-social-icon" aria-hidden="true">{React.createElement(resolveSocial({ platform: row.value.platform ?? '' }, socialLinks).icon)}</span>
              <PlatformSelect
                api={api}
                value={row.value.platform ?? ''}
                links={socialLinks}
                onChange={(platform) => setSocial(replace(social, i, { ...row, value: { ...row.value, platform } }))}
              />
              <input className="ct-input" placeholder={uiText('auto.249ba3600002')} aria-label={uiText('contacts.form.username')} value={row.value.handle ?? ''}
                onChange={(e) => setSocial(replace(social, i, { ...row, value: { ...row.value, handle: val(e) } }))} />
              <button className="ct-rep-del" aria-label={uiText('contacts.form.removeRow')} title={uiText('contacts.form.removeRow')} onClick={() => setSocial(remove(social, i))}><X /></button>
            </div>
          )
        })}
        <button className="ct-rep-add" onClick={() => setSocial([...social, newSocialRow()])}><Plus /> {uiText('auto.fad77af1f333')}</button>
        {socialReorder.liveRegion}
      </div>

      <div className="ct-rep">
        <div className="ct-form-section-title">{uiText('auto.6519fe11ef74')}</div>
        {relations.map((r, i) => (
          <div className="ct-rep-row ct-multi-row" key={i}>
            <SubField label={uiText('contacts.form.relationPerson')}>
              <ComboField className="ct-input" placeholder={uiText('contacts.form.relationPersonPlaceholder')}
                ariaLabel={uiText('contacts.form.relationPerson')} value={r.toName}
                onChange={(value) => setRelations(replace(relations, i, { ...r, toName: value }))}
                options={snap.contacts.map((c) => ({ value: c.displayName, label: c.displayName }))} />
            </SubField>
            <SubField label={uiText('contacts.form.relationType')}>
              <span className="ct-select-wrap">
                <SelectField value={r.type}
                  ariaLabel={uiText('contacts.form.relationType')}
                  onChange={(value) => setRelations(replace(relations, i, { ...r, type: value as RelationType }))}
                  options={RELATION_TYPES.map((t) => ({ value: t, label: RELATION_LABELS[t] }))} />
              </span>
            </SubField>
            <SubField label={uiText('contacts.form.relationRole')}>
              <input className="ct-input" placeholder={uiText('contacts.form.relationRolePlaceholder')} aria-label={uiText('contacts.form.relationRole')} value={r.role}
                onChange={(e) => setRelations(replace(relations, i, { ...r, role: val(e) }))} />
            </SubField>
            <button className="ct-rep-del" aria-label={uiText('contacts.form.removeRow')} title={uiText('contacts.form.removeRow')} onClick={() => setRelations(remove(relations, i))}><X /></button>
          </div>
        ))}
        <button className="ct-rep-add" onClick={() => setRelations([...relations, { toName: '', ref: '', label: '', type: 'friend', role: '' }])}><Plus /> {uiText('auto.8fda01a98d1f')}</button>
      </div>

      <div className="ct-rep">
        <div className="ct-form-section-title">{uiText('auto.a87a48da60ac')}</div>
        {websites.map((w, i) => (
          <div className="ct-rep-row ct-method-row" key={i}>
            <input className="ct-input" placeholder="https://..." aria-label={uiText('auto.a87a48da60ac')} value={w.value} onChange={(e) => setWebsites(replace(websites, i, { ...w, value: val(e) }))} />
            <LabelSelect api={api} kind="website" labels={labels.website} value={w.type ?? ''} onChange={(type) => setWebsites(replace(websites, i, withType(w, type)))} />
            <button className="ct-rep-del" aria-label={uiText('contacts.form.removeRow')} title={uiText('contacts.form.removeRow')} onClick={() => setWebsites(remove(websites, i))}><X /></button>
          </div>
        ))}
        <button className="ct-rep-add" onClick={() => setWebsites([...websites, { value: '' }])}><Plus /> {uiText('auto.cb9082a114f4')}</button>
      </div>

      </div>

      <ContactNotesField
        valleyReady={valleyReady}
        note={note}
        sourcePath={contact?.relPath || undefined}
        onChange={setNote}
        onSave={() => { void saveRef.current() }}
      />

    </div>
  )
}

/**
 * The card's Markdown notes in the SDK's Markdown box: drawn in this page, so it
 * scrolls with the form, with the formatting toolbar, `[[wikilink]]`
 * completion and a Markdown switch. It grows with its text; Mod-Enter saves.
 * The value is the NOTE text as written: the box never rewrites it.
 */
function ContactNotesField({ valleyReady, note, onChange, onSave }: {
  valleyReady: boolean
  note: string
  sourcePath: string | undefined
  onChange: (value: string) => void
  onSave: () => void
}): ReactElement {
  const words = note.trim() ? note.trim().split(/\s+/).length : 0
  const MarkdownField = valleyReady ? runtimeApi.ui.settings.MarkdownField : undefined
  return (
    <div className="ct-rep ct-notes">
      <div className="ct-form-section-title">{uiText('auto.70440046a3dc')}</div>
      {MarkdownField ? (
        <MarkdownField
          className="ct-notes-editor"
          value={note}
          onChange={onChange}
          onSave={onSave}
          ariaLabel={uiText('auto.70440046a3dc')}
          minHeight={180}
          maxHeight={560}
          placeholder={uiText('contacts.notes.placeholder')}
          hint={uiText('contacts.notes.hint')}
          wordCount={(count) => uiText('contacts.notes.words', { count })}
        />
      ) : (
        <div className="ct-notes-editor note-input-editor" style={{ minHeight: 180 }} />
      )}
      {!MarkdownField && (
        <div className="ct-notes-foot">
          <span>{uiText('contacts.notes.hint')}</span>
          <span>{uiText('contacts.notes.words', { count: words })}</span>
        </div>
      )}
    </div>
  )
}

/**
 * The platform of a social row, picked by name from the configured registry
 * (Settings → Contacts → Social platforms), in that order (18 Nov). A saved
 * platform that is not in the registry stays listed, so it is never lost.
 */
function PlatformSelect({ api, value, links, onChange }: {
  api: ValleyPluginApi
  value: string
  links: readonly SocialLink[]
  onChange: (platform: string) => void
}): ReactElement {
  const { SelectField } = api.ui.settings
  const current = canonicalPlatform(value)
  const known = links.find((link) => link.id === current)
  const options = links.map((link) => ({ value: link.label, label: link.label }))
  if (value.trim() && !known) options.push({ value: value.trim(), label: value.trim() })
  options.push({ value: EDIT_OPTION, label: uiText('contacts.form.editPlatforms') })
  // The sandboxed SelectField does not take a class on its own frame, so its footprint is set on this wrapper.
  return (
    <span className="ct-select-wrap ct-platform-select">
    <SelectField
      value={known ? known.label : value.trim()}
      ariaLabel={uiText('auto.123a7f2fcc9a')}
      placeholder={uiText('contacts.form.choosePlatform')}
      options={options}
      onChange={(next) => { if (next === EDIT_OPTION) void api.workspace.openSettings('plugin:contacts#social'); else onChange(next) }}
    />
    </span>
  )
}

/** The dropdown row value that opens Settings instead of choosing an entry. */
const EDIT_OPTION = '__contacts-edit__'

/**
 * The label of a phone, email, address or website row, picked from its list in
 * Settings → Contacts → Labels (18 Nov). A saved label that is not in the list
 * (another app's, or one removed since) stays listed, so it is never lost.
 */
function LabelSelect({ api, kind, labels, value, onChange }: {
  api: ValleyPluginApi
  kind: ContactLabelKind
  labels: readonly ContactLabel[]
  value: string
  onChange: (label: string) => void
}): ReactElement {
  const { SelectField } = api.ui.settings
  const saved = value.trim()
  const match = labels.find((label) => label.name.toLowerCase() === saved.toLowerCase())?.name
  // Each label shows its colour as the row's dot, the colour Map draws its pin in (19 Nov).
  const options: { value: string; label: string; color?: string }[] = labels.map((label) => ({ value: label.name, label: label.name, ...(label.color ? { color: label.color } : {}) }))
  if (saved && !match) options.push({ value: saved, label: saved })
  options.push({ value: '', label: uiText('contacts.form.noLabel') }, { value: EDIT_OPTION, label: uiText('contacts.form.editLabels') })
  return (
    <span className="ct-select-wrap ct-label-select">
    <SelectField
      value={match ?? saved}
      ariaLabel={uiText(`contacts.form.label.${kind}`)}
      placeholder={uiText('contacts.form.chooseLabel')}
      options={options}
      onChange={(next) => { if (next === EDIT_OPTION) void api.workspace.openSettings('plugin:contacts#social'); else onChange(next) }}
    />
    </span>
  )
}

/** A row with `type` set, or without it for no label. */
function withType(method: ContactMethod, type: string): ContactMethod {
  const { type: _previous, ...rest } = method
  return type ? { ...rest, type } : rest
}

/** One input of a multi-input row, captioned with what it is for; on a narrow page the inputs stack. */
function SubField({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="ct-subfield">
      <span className="ct-subfield-label" aria-hidden="true">{label}</span>
      {children}
    </div>
  )
}

function val(e: { target: EventTarget | null }): string {
  return (e.target as HTMLInputElement).value
}
function replace<T>(arr: T[], i: number, item: T): T[] {
  const next = arr.slice()
  next[i] = item
  return next
}
function remove<T>(arr: T[], i: number): T[] {
  return arr.filter((_, j) => j !== i)
}

// A leap year, so a year-less 29 February stays pickable; never saved (17 Nov).
const YEARLESS_PICKER_YEAR = '2000'

/** Birthday through the SDK DateField; "Year unknown" keeps the vCard's year-less `--MM-DD` form (17 Nov). */
function BirthdateField({ api, value, dateFormat, onChange }: { api: ValleyPluginApi; value: string; dateFormat: string; onChange: (value: string) => void }): ReactElement {
  const { DateField, Toggle } = api.ui.settings
  const stored = parseContactDateInput(value, dateFormat)
  const yearless = /^--(\d{2})-(\d{2})$/.exec(stored)
  const full = /^\d{4}-\d{2}-\d{2}$/.test(stored)
  const [noYear, setNoYear] = React.useState(Boolean(yearless))
  React.useEffect(() => {
    if (yearless) setNoYear(true)
    else if (full) setNoYear(false)
  }, [Boolean(yearless), full])
  const pickerValue = full ? stored : yearless ? `${YEARLESS_PICKER_YEAR}-${yearless[1]}-${yearless[2]}` : ''
  const label = uiText('auto.ab5815528f10')
  return (
    <div className="ct-birthdate">
      <DateField
        value={pickerValue}
        ariaLabel={label}
        // Free-text BDAY values stay saved untouched until a day is picked.
        placeholder={!full && !yearless && stored ? stored : dateFormatPlaceholder(dateFormat)}
        onChange={(next) => onChange(!next ? '' : noYear ? `--${next.slice(5)}` : formatContactDate(next, dateFormat))}
      />
      <span className="ct-birthdate-noyear">
        <Toggle
          checked={noYear}
          label={uiText('contacts.form.yearUnknown')}
          onChange={(on) => {
            setNoYear(on)
            if (on && full) onChange(`--${stored.slice(5)}`)
          }}
        />
        <span aria-hidden="true">{uiText('contacts.form.yearUnknown')}</span>
      </span>
    </div>
  )
}

function Field({ label, full, children }: { label: string; full?: boolean; children: ReactNode }): ReactElement {
  return (
    <div className={`ct-form-field${full ? ' full' : ''}`}>
      <label>{label}</label>
      {children}
    </div>
  )
}

/**
 * Addresses through the SDK AddressField: OpenStreetMap suggestions while typing,
 * free text still allowed. A picked suggestion keeps its structured parts, which
 * the card stores in ADR and shows a small map under the field; typed text stays
 * a plain address (17 Nov).
 */
function PlaceList({ api, labels, title, items, setItems, placeholder }: {
  api: ValleyPluginApi
  labels: readonly ContactLabel[]
  title: string
  items: ContactMethod[]
  setItems: (next: ContactMethod[]) => void
  placeholder: string
}): ReactElement {
  const { AddressField } = api.ui.settings
  return (
    <div className="ct-rep">
      <div className="ct-form-section-title">{title}</div>
      {items.map((m, i) => (
        <div className="ct-rep-row ct-method-row ct-place-row" key={i}>
          <AddressField className="ct-address" ariaLabel={title} placeholder={placeholder} preview
            value={m.place ? { text: m.value, place: m.place } : m.value}
            onChange={(next) => {
              const { place: _previous, ...rest } = m
              const stored = storedAddressPlace(next.place)
              setItems(replace(items, i, stored ? { ...rest, value: next.text, place: stored } : { ...rest, value: next.text }))
            }} />
          <LabelSelect api={api} kind="place" labels={labels} value={m.type ?? ''} onChange={(type) => setItems(replace(items, i, withType(m, type)))} />
          <button className="ct-rep-del" aria-label={uiText('contacts.form.removeRow')} title={uiText('contacts.form.removeRow')} onClick={() => setItems(remove(items, i))}><X /></button>
        </div>
      ))}
      <button className="ct-rep-add" onClick={() => setItems([...items, { value: '' }])}><Plus /> {uiText('auto.61cc55aa0453')}{' '}{title.toLowerCase()}</button>
    </div>
  )
}

function MethodList({ api, kind, labels, title, items, setItems, placeholder }: {
  api: ValleyPluginApi
  kind: 'phone' | 'email'
  labels: readonly ContactLabel[]
  title: string
  items: ContactMethod[]
  setItems: (next: ContactMethod[]) => void
  placeholder: string
}): ReactElement {
  return (
    <div className="ct-rep">
      <div className="ct-form-section-title">{title}</div>
      {items.map((m, i) => (
        <div className="ct-rep-row ct-method-row" key={i}>
          <input className="ct-input" placeholder={placeholder} aria-label={title} value={m.value}
            onChange={(e) => setItems(replace(items, i, { ...m, value: val(e) }))} />
          <LabelSelect api={api} kind={kind} labels={labels} value={m.type ?? ''} onChange={(type) => setItems(replace(items, i, withType(m, type)))} />
          <button className="ct-rep-del" aria-label={uiText('contacts.form.removeRow')} title={uiText('contacts.form.removeRow')} onClick={() => setItems(remove(items, i))}><X /></button>
        </div>
      ))}
      <button className="ct-rep-add" onClick={() => setItems([...items, { value: '' }])}><Plus /> {uiText('auto.61cc55aa0453')}{' '}{title.toLowerCase()}</button>
    </div>
  )
}
