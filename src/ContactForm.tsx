import { useContactIcons } from './contactIcons'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import { React, api as runtimeApi } from './runtime'
import type { MountedPluginView, PluginEditorProvider, ValleyPluginApi } from '@valley/plugin-sdk'
import type { TextDocumentRead } from '@valley/plugin-sdk/types'
import type { Contact, ContactMethod, Organization, RelationType, Social, SocialLink } from './types'
import { RELATION_TYPES } from './types'
import { getStore } from './store'
import { paletteCssAlpha, paletteCssValue } from '@valley/plugin-sdk/palette'
import { allGroups, contactFileBase, groupColorFor, normalizeGroupName, readContactDocument, relationLabel, relationTarget, saveContact, UNTITLED_FILE_BASE } from './data'
import { emptyContact, parseContactFile } from './schema'
import { RELATION_LABELS } from './relationGraphModel'
import { GripVertical, Plus, X } from './icons'
import { canonicalPlatform, iconForPlatform, resolveSocial } from './social'
import { getSocialLinks } from './data'
import { dateFormatPlaceholder, formatContactDate, parseContactDateInput } from './util'
import { uiText } from './localization'
import { useContactFileActions, type ContactFileActionContext } from './fileViewCommands'

const BLANK: Contact = emptyContact()

/** A relation row: the name shown, plus the stored target it came from. */
interface RelDraft { toName: string; ref: string; label: string; type: RelationType; role: string }

/** Draft keys that are bookkeeping, not contact edits. */
const DRAFT_STATE = new Set(['sourceContact', 'expectedDocument', 'ready', 'saving', 'error', 'revision', 'savedRevision', 'committedRevision', 'fileNameEdited'])

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
  mounts: Set<string>
  owners: Map<string, { view: MountedPluginView } | { path: string; instanceId: string }>
  ownerMountId?: string | null
}

function contactDraft(api: ValleyPluginApi, key: string): ContactDraft {
  const drafts = api.runtime.getOrCreate('contacts.formDrafts', () => new Map<string, ContactDraft>())
  let draft = drafts.get(key)
  if (!draft) {
    draft = { fields: new Map(), listeners: new Set(), identity: crypto.randomUUID(), fences: 0, mounts: new Set(), owners: new Map() }
    drafts.set(key, draft)
  }
  return draft
}

function useContactField<T>(api: ValleyPluginApi, key: string, field: string, initial: T | (() => T), ownerId?: string): [T, React.Dispatch<React.SetStateAction<T>>] {
  const draft = contactDraft(api, key)
  const initialRef = React.useRef(initial)
  initialRef.current = initial
  const read = React.useCallback((): T => {
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
    if (draft.fences && !DRAFT_STATE.has(field)) return
    draft.fields.set(field, typeof next === 'function' ? (next as (previous: T) => T)(read()) : next)
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
      for (const listener of draft.listeners) listener()
      let released = false
      return { validate: snapshot, release: () => {
        if (released) return
        released = true
        draft.fences--
        for (const listener of draft.listeners) listener()
      } }
    }
  })
  return () => { active = false; draft.mounts.delete(instanceId); draft.owners.delete(instanceId); off() }
}

export const registerContactFileEditor = (owner: ValleyPluginApi, view: MountedPluginView): (() => void) => registerContactEditor(owner, view.filePath, view.mountId, { view }, provider => owner.vault.editors.register(view, provider))

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
  const draftKey = contact?.relPath ?? '__new__'
  const [instanceId] = React.useState(() => `contact-form-${crypto.randomUUID()}`)
  const editorId = mountedView?.mountId ?? instanceId
  const mountedKey = mountedView ? JSON.stringify([mountedView.mountId, mountedView.generation, mountedView.area, mountedView.paneId, mountedView.tabId, mountedView.filePath, mountedView.pluginId]) : ''
  React.useEffect(() => {
    if (mountedKey || !contact?.relPath) return
    return registerContactEditor(api, contact.relPath, instanceId, { path: contact.relPath, instanceId }, provider => api.vault.editors.registerDocument(contact.relPath, instanceId, provider))
  }, [api, contact?.relPath, instanceId, mountedKey])
  const form = React.useRef<HTMLDivElement>(null)
  const [prepared, setPrepared] = React.useState(false)
  React.useEffect(() => {
    const draft = contactDraft(api, draftKey)
    const listener = () => { setPrepared(draft.fences > 0); if (form.current) form.current.inert = draft.fences > 0 }
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
  const [groups, setGroups] = useContactField(api, draftKey, 'groups', base.groups, editorId)
  const [groupDraft, setGroupDraft] = React.useState('')
  const [dragIndex, setDragIndex] = React.useState<number | null>(null)
  const [phone, setPhone] = useContactField<ContactMethod[]>(api, draftKey, 'phone', base.phone, editorId)
  const [email, setEmail] = useContactField<ContactMethod[]>(api, draftKey, 'email', base.email, editorId)
  const [place, setPlace] = useContactField<ContactMethod[]>(api, draftKey, 'place', base.place, editorId)
  const [organization, setOrganization] = useContactField<Organization[]>(api, draftKey, 'organization', base.organization, editorId)
  const [social, setSocial] = useContactField<SocialRow[]>(api, draftKey, 'social', () => base.socialMedia.map((s) => newSocialRow(s)), editorId)
  const [websites, setWebsites] = useContactField<string[]>(api, draftKey, 'websites', base.websites, editorId)
  const [relations, setRelations] = useContactField<RelDraft[]>(api, draftKey, 'relations', () => relationDrafts(base, snap.contacts), editorId)
  const [note, setNote] = useContactField(api, draftKey, 'note', base.note, editorId)
  const [valleyReady, setNotesReady] = useContactField(api, draftKey, 'ready', !contact?.relPath)
  const [revision] = useContactField(api, draftKey, 'revision', 0)
  const [savedRevision, setSavedRevision] = useContactField(api, draftKey, 'savedRevision', 0)
  const [, setCommittedRevision] = useContactField(api, draftKey, 'committedRevision', 0)
  const [saving, setSaving] = useContactField(api, draftKey, 'saving', false)
  const [fileName, setFileName] = useContactField(api, draftKey, 'fileName', '', editorId)
  const [fileNameEdited, setFileNameEdited] = useContactField(api, draftKey, 'fileNameEdited', false)
  const knownGroups = allGroups(snap.groupConfigs).filter((g) => !groups.includes(g))
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
    const stored = groupColorFor(group, snap.groupConfigs)
    const color = paletteCssValue(stored)
    return { borderColor: color, color, background: paletteCssAlpha(stored, 13) }
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
    const target = (draft.fields.get('revision') as number | undefined) ?? 0
    setSaving(true)
    setError('')
    const next: Contact = {
      ...base,
      firstName: firstName.trim(),
      middleName: middleName.trim(),
      lastName: lastName.trim(),
      nickname: nickname.trim(),
      birthdate: parseContactDateInput(birthdate, dateFormat),
      profession: profession.trim(),
      cover: cover.trim(),
      groups,
      phone: phone.filter((m) => m.value.trim()),
      email: email.filter((m) => m.value.trim()),
      place: place.filter((m) => m.value.trim()),
      organization: organization.filter((o) => o.name || o.title || o.dept),
      socialMedia: social
        .map((row) => row.value)
        .filter((s) => s.platform || s.handle || s.url)
        .map((s) => ({ ...s, platform: s.platform ? canonicalPlatform(s.platform) : s.platform })),
      websites: websites.filter((w) => w.trim()),
      relations: relations
        .filter((r) => r.toName.trim())
        .map((r) => ({ to: r.ref && r.toName === r.label ? r.ref : relationTarget(r.toName, snap.contacts), type: r.type, role: r.role.trim() || undefined })),
      note
    }
    try {
      if (contact && !expectedDocument) throw new Error(uiText('contacts.error.changed'))
      const editor = contact?.relPath ? { ...(draft.owners.get(draft.ownerMountId ?? editorId) ?? (mountedView ? { view: mountedView } : { path: contact.relPath, instanceId })), revision: `${draft.identity}:${target}`, committed: () => setCommittedRevision(target) } : undefined
      const saved = await saveContact(next, { previous: base, fileName: fileNameValue, document: expectedDocument }, api, editor, commandContext ? async paths => {
        await commandContext.validate(paths.map(path => ({ kind: 'file' as const, path, fileOperation: 'write' as const })))
        if (!draft.mounts.has(editorId) || draft.fences || draft.fields.get('revision') !== target || draft.ownerMountId && draft.ownerMountId !== editorId) throw Object.assign(new Error('The Contact draft changed before its file effect.'), { outcome: 'not-applied' })
      } : undefined)
      if (!saved) throw new Error(uiText('contacts.error.changed'))
      if (saved.editorConflict) throw new Error(uiText('contacts.error.changed'))
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
        else if (action.collection === 'website') setWebsites([...websites, ''])
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
        else if (action.collection === 'website') setWebsites(replace(websites, i, fields.value))
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
      settings: async (_action, context) => { await context.validate(); await api.workspace.openSettings('groups') }
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
    onActionState?.({ saving, canSave: valleyReady && !prepared, label: contact ? uiText('auto.efc007a393f6') : uiText('auto.6e157c5da441') })
  }, [saving, valleyReady, prepared, contact, onActionState])
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
      {autosave && <div className="ct-form-status" aria-live="polite">{saving ? uiText('auto.56a2285c5b11') : revision !== savedRevision ? uiText('contacts.properties.pending') : ''}</div>}
      <div className="ct-form-grid">
        <Field label={uiText('auto.7e568a90221d')}><input className="ct-input" value={firstName} onChange={(e) => setFirstName(val(e))} /></Field>
        <Field label={uiText('auto.adec36a821f8')}><input className="ct-input" value={lastName} onChange={(e) => setLastName(val(e))} /></Field>
        <Field label={uiText('auto.17dbdb86621f')}><input className="ct-input" value={middleName} onChange={(e) => setMiddleName(val(e))} /></Field>
        <Field label={uiText('auto.ce2bd99c4758')}><input className="ct-input" value={nickname} onChange={(e) => setNickname(val(e))} /></Field>
        <Field label={uiText('auto.ab5815528f10')}><input className="ct-input" value={birthdate} placeholder={dateFormatPlaceholder(dateFormat)} onChange={(e) => setBirthdate(val(e))} /></Field>
        <Field label={uiText('auto.6f528041b7e1')}><input className="ct-input" value={profession} onChange={(e) => setProfession(val(e))} /></Field>
        <Field label={uiText('auto.834fba1ea948')} full>
          <input className="ct-input" value={cover} placeholder="portrait.jpg" onChange={(e) => setCover(val(e))} />
        </Field>
        <Field label={uiText('auto.09979a78c995')} full>
          <div className="ct-file-name">
            <input
              className="ct-input"
              value={fileNameValue}
              placeholder={derivedFileName || UNTITLED_FILE_BASE}
              onChange={(e) => {
                setFileNameEdited(true)
                setFileName(val(e))
              }}
            />
            <span className="ct-file-ext">.vcf</span>
          </div>
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
                  {group}
                  <button
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
              <button className="ct-rep-add" onClick={() => api.workspace.openSettings('groups')}>
                {uiText('settings.section.groups')}
              </button>
            </div>
          </div>
        </Field>
      </div>

      <MethodList title={uiText('auto.77064d526523')} items={phone} setItems={setPhone} placeholder="+41 79 ..." labelPlaceholder="mobile" />
      <MethodList title={uiText('auto.84add5b29527')} items={email} setItems={setEmail} placeholder={uiText('auto.9703026304af')} labelPlaceholder="work" />
      <MethodList title={uiText('auto.d70f93df5e8f')} items={place} setItems={setPlace} placeholder={uiText('auto.4b4fa9d8f179')} labelPlaceholder="home" />

      <div className="ct-rep">
        <div className="ct-form-section-title">{uiText('auto.519255ae1f74')}</div>
        {organization.map((o, i) => (
          <div className="ct-rep-row" key={i}>
            <input className="ct-input" placeholder={uiText('auto.709a23220f2c')} value={o.name ?? ''} onChange={(e) => setOrganization(replace(organization, i, { ...o, name: val(e) }))} />
            <input className="ct-input" placeholder={uiText('auto.768e0c1c6957')} value={o.title ?? ''} onChange={(e) => setOrganization(replace(organization, i, { ...o, title: val(e) }))} />
            <input className="ct-input" placeholder={uiText('auto.48a7b68e8254')} value={o.dept ?? ''} onChange={(e) => setOrganization(replace(organization, i, { ...o, dept: val(e) }))} />
            <button className="ct-rep-del" onClick={() => setOrganization(remove(organization, i))}><X /></button>
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
              <PlatformPicker
                api={api}
                value={row.value.platform ?? ''}
                links={socialLinks}
                onChange={(platform) => setSocial(replace(social, i, { ...row, value: { ...row.value, platform } }))}
              />
              <input className="ct-input" placeholder={uiText('auto.249ba3600002')} value={row.value.handle ?? ''}
                onChange={(e) => setSocial(replace(social, i, { ...row, value: { ...row.value, handle: val(e) } }))} />
              <button className="ct-rep-del" onClick={() => setSocial(remove(social, i))}><X /></button>
            </div>
          )
        })}
        <button className="ct-rep-add" onClick={() => setSocial([...social, newSocialRow()])}><Plus /> {uiText('auto.fad77af1f333')}</button>
        {socialReorder.liveRegion}
      </div>

      <div className="ct-rep">
        <div className="ct-form-section-title">{uiText('auto.6519fe11ef74')}</div>
        {relations.map((r, i) => (
          <div className="ct-rep-row" key={i}>
            <ComboField className="ct-input" placeholder={uiText('auto.565e288e2a02')}
              ariaLabel={uiText('auto.565e288e2a02')} value={r.toName}
              onChange={(value) => setRelations(replace(relations, i, { ...r, toName: value }))}
              options={snap.contacts.map((c) => ({ value: c.displayName, label: c.displayName }))} />
            <SelectField className="ct-select" value={r.type}
              ariaLabel={uiText('auto.79f3483671d7')}
              onChange={(value) => setRelations(replace(relations, i, { ...r, type: value as RelationType }))}
              options={RELATION_TYPES.map((t) => ({ value: t, label: RELATION_LABELS[t] }))} />
            <input className="ct-input" placeholder={uiText('auto.c3f104d13657')} value={r.role}
              onChange={(e) => setRelations(replace(relations, i, { ...r, role: val(e) }))} />
            <button className="ct-rep-del" onClick={() => setRelations(remove(relations, i))}><X /></button>
          </div>
        ))}
        <button className="ct-rep-add" onClick={() => setRelations([...relations, { toName: '', ref: '', label: '', type: 'friend', role: '' }])}><Plus /> {uiText('auto.8fda01a98d1f')}</button>
      </div>

      <div className="ct-rep">
        <div className="ct-form-section-title">{uiText('auto.a87a48da60ac')}</div>
        {websites.map((w, i) => (
          <div className="ct-rep-row" key={i}>
            <input className="ct-input" placeholder="https://..." value={w} onChange={(e) => setWebsites(replace(websites, i, val(e)))} />
            <button className="ct-rep-del" onClick={() => setWebsites(remove(websites, i))}><X /></button>
          </div>
        ))}
        <button className="ct-rep-add" onClick={() => setWebsites([...websites, ''])}><Plus /> {uiText('auto.cb9082a114f4')}</button>
      </div>

      <div className="ct-rep">
        <div className="ct-form-section-title">{uiText('auto.70440046a3dc')}</div>
        {valleyReady ? (
          <api.ui.NoteInput
            className="ct-notes-editor"
            value={note}
            onChange={setNote}
            context={{ sourcePath: contact?.relPath || undefined }}
            minHeight={120}
            placeholder={uiText('contacts.notes.placeholder')}
          />
        ) : (
          <div className="ct-notes-editor note-input-editor" />
        )}
      </div>

    </div>
  )
}

/**
 * The platform of a social row, picked by its brand mark instead of its name —
 * the shape a profile's social links take everywhere else. The grid *is* the
 * configured registry (Settings → Contacts → Social platforms), in that order,
 * so reordering or deleting a platform there is what this offers; the search
 * line still accepts an unlisted platform, using its matching SVG or the
 * generic social icon.
 */
function PlatformPicker({ api, value, links, onChange }: {
  api: ValleyPluginApi
  value: string
  links: readonly SocialLink[]
  onChange: (platform: string) => void
}): ReactElement {
  const ref = React.useRef<HTMLButtonElement>(null)
  const Icon = resolveSocial({ platform: value }, links).icon
  const current = canonicalPlatform(value)
  const name = links.find((link) => link.id === current)?.label ?? value.trim()
  const label = uiText('auto.123a7f2fcc9a')
  const open = (): void => {
    const anchor = ref.current
    if (!anchor) return
    void api.ui.openPopover(
      (ctx) => (
        <PlatformGrid
          links={links}
          current={current}
          onPick={(platform) => { onChange(platform); ctx.close() }}
        />
      ),
      { anchor },
      { className: 'ct-social-picker', ariaLabel: label }
    )
  }
  return (
    <button
      ref={ref}
      type="button"
      className={`ct-social-pick${name ? '' : ' empty'}`}
      onClick={open}
      title={name || label}
      aria-label={name ? `${label}: ${name}` : label}
    ><Icon /></button>
  )
}

function PlatformGrid({ links, current, onPick }: {
  links: readonly SocialLink[]
  current: string
  onPick: (platform: string) => void
}): ReactElement {
  const [query, setQuery] = React.useState('')
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? links.filter((link) => link.label.toLowerCase().includes(needle) || link.id.includes(needle))
    : links
  return (
    <div className="ct-social-picker-body">
      <input
        className="ct-input ct-social-picker-search"
        autoFocus
        value={query}
        spellCheck={false}
        placeholder={uiText('contacts.social.searchPlatform')}
        aria-label={uiText('contacts.social.searchPlatform')}
        onChange={(e) => setQuery(val(e))}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          const pick = shown[0]?.label ?? query.trim()
          if (pick) onPick(pick)
        }}
      />
      <div className="ct-social-picker-grid">
        {shown.map((link) => {
          const Glyph = iconForPlatform(link.label, link.icon)
          return (
            <button
              key={link.id}
              type="button"
              className={`ct-social-picker-tile${link.id === current ? ' selected' : ''}`}
              title={link.label}
              aria-label={link.label}
              aria-pressed={link.id === current}
              onClick={() => onPick(link.label)}
            ><Glyph /></button>
          )
        })}
      </div>
      {needle && shown.length === 0 && (
        <button type="button" className="ct-social-picker-custom" onClick={() => onPick(query.trim())}>
          {uiText('contacts.social.useCustom', { p0: query.trim() })}
        </button>
      )}
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

function Field({ label, full, children }: { label: string; full?: boolean; children: ReactNode }): ReactElement {
  return (
    <div className={`ct-form-field${full ? ' full' : ''}`}>
      <label>{label}</label>
      {children}
    </div>
  )
}

function MethodList({ title, items, setItems, placeholder, labelPlaceholder }: {
  title: string
  items: ContactMethod[]
  setItems: (next: ContactMethod[]) => void
  placeholder: string
  labelPlaceholder: string
}): ReactElement {
  return (
    <div className="ct-rep">
      <div className="ct-form-section-title">{title}</div>
      {items.map((m, i) => (
        <div className="ct-rep-row" key={i}>
          <input className="ct-input" placeholder={placeholder} value={m.value}
            onChange={(e) => setItems(replace(items, i, { ...m, value: val(e) }))} />
          <input className="ct-input ct-rep-type" placeholder={labelPlaceholder} value={m.type ?? ''}
            onChange={(e) => setItems(replace(items, i, { ...m, type: val(e) }))} />
          <button className="ct-rep-del" onClick={() => setItems(remove(items, i))}><X /></button>
        </div>
      ))}
      <button className="ct-rep-add" onClick={() => setItems([...items, { value: '' }])}><Plus /> {uiText('auto.61cc55aa0453')}{' '}{title.toLowerCase()}</button>
    </div>
  )
}
