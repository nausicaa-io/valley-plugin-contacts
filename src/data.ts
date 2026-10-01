import * as documents from './contactDocuments'
import { uiText } from './localization'
import { api } from './runtime'
import { fileExtension, IMAGE_EXTENSIONS } from '@valley/plugin-sdk/fileTypes'
import {
  canonicalGroupName,
  groupColorFor as sharedGroupColorFor,
  normalizeGroups
} from '@valley/plugin-sdk/groups'
import type { PluginIndexEntry } from '@valley/plugin-sdk'
import { getContactIndex } from './indexOwner'
import type { ValleyPluginApi } from '@valley/plugin-sdk'
import type { TextDocumentRead } from '@valley/plugin-sdk/types'
import type { Contact, ContactGroup, GroupNode, SocialLink } from './types'
import { CONTACT_EXTENSION, parseContactFile } from './schema'
import { canonicalPlatform, defaultSocialLinks } from './social'

export const UNCATEGORIZED = '__uncategorized__'
export const ALL = '__all__'

export const DEFAULT_AVATAR_COLOR = '#8f969f'

/** File name a contact note falls back to when it has no name at all. */

export interface ContactsSettings {
  contactsRoot: string
  /** The one app-wide group registry. */
  groups: ContactGroup[]
  socials: SocialLink[]
}

export function normalizeGroupName(name: string): string {
  return name.trim().toLowerCase()
}

function socialSlug(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'social'
}

function normalizeSocialLinks(value: unknown): SocialLink[] {
  if (!Array.isArray(value)) return []
  const out: SocialLink[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const g = raw as Record<string, unknown>
    const label = typeof g.label === 'string' ? g.label.trim() : ''
    if (!label) continue
    const id = (typeof g.id === 'string' && g.id.trim() ? g.id.trim().toLowerCase() : canonicalPlatform(label)) || socialSlug(label)
    if (seen.has(id)) continue
    seen.add(id)
    const url = typeof g.url === 'string' ? g.url.trim() : ''
    out.push({ id, label, url, ...(typeof g.icon === 'string' && g.icon.trim() ? { icon: g.icon.trim() } : {}) })
  }
  return out
}

/** Read the plugin settings with sane fallbacks. `/` or `.` scopes contacts to
 *  the whole vault — a flat vault keeps its people at the root, where no folder
 *  prefix can select them and `type: contact` does the work instead. An unset
 *  root still falls back to the default folder. */
export function getSettings(owner = api): ContactsSettings {
  const s = owner.settings.get()
  const root = typeof s.contactsRoot === 'string' && s.contactsRoot.trim() ? s.contactsRoot.trim() : 'Meadow/Orbit'
  const scoped = root === '/' || root === '.' ? '' : root.replace(/\/+$/, '')
  const socials = normalizeSocialLinks(s.socials)
  return {
    contactsRoot: scoped,
    groups: getGlobalGroups(owner),
    socials: socials.length ? socials : defaultSocialLinks()
  }
}

/**
 * The shared registry off core state. Coerced rather than cast: the field is
 * newer than the SDK contract that first shipped, so a host that predates it —
 * or hand-edited `preferences.json` — must read as an empty registry, not crash
 * the contacts list.
 */
export function getGlobalGroups(owner = api): ContactGroup[] {
  return normalizeGroups(owner.getState().groups)
}

/** The configured social platforms (falling back to the built-in defaults). */
export function getSocialLinks(): SocialLink[] {
  return getSettings().socials
}

const CONTACT_READS = 4

/**
 * The live contact list. The index reports which `.vcf` files exist (with size
 * and modification time); only files whose signature moved are read and parsed,
 * four at a time, so a save costs one read, never a rescan of the folder.
 */
export function createContactProjection(owner: ValleyPluginApi, readEntries = () => getContactIndex(owner).read(), onLoaded: () => void = () => {}) {
  interface FileRecord { key: string; contact: Contact | null; pending: boolean; groupsKey?: string; grouped?: Contact }
  const files = new Map<string, FileRecord>()
  const queue: Array<{ path: string; record: FileRecord }> = []
  const warned = new Set<string>()
  let reading = 0
  let generation = 0
  let notify = false
  let previousInput: Contact[] = []
  let contacts: Contact[] = []
  let groupsKey = ''
  let groupConfigs: ContactGroup[] = []
  let treeKey = ''
  let groupTree: GroupNode[] = []
  let groupInput: Contact[] | undefined
  let groupNamesKey = ''
  let groupLabelsKey = ''
  let imagesKey = ''
  let imagePaths = new Set<string>()
  let imageNames = new Map<string, string>()
  let coversKey = ''
  let coverPaths: Record<string, string | null> = {}
  let coverInput: Contact[] | undefined
  let coverImagesKey = ''
  let vault = owner.getState().vault?.path
  const equalItems = <T>(a: T[], b: T[]): boolean => a.length === b.length && a.every((value, index) => value === b[index])
  const pump = (): void => {
    while (reading < CONTACT_READS && queue.length) {
      const { path, record } = queue.shift()!
      if (files.get(path) !== record) continue
      reading++
      const epoch = generation
      void owner.vault.readFile(path).then((raw) => {
        if (epoch !== generation || files.get(path) !== record) return
        try {
          record.contact = parseContactFile(path, raw)
          warned.delete(path)
        } catch (error) {
          record.contact = null
          if (!warned.has(path)) console.warn(`[contacts] ${path} is not a readable vCard: ${error instanceof Error ? error.message : String(error)}`)
          warned.add(path)
        }
        record.grouped = undefined
      }, () => {
        if (epoch === generation && files.get(path) === record) record.contact = null
      }).finally(() => {
        if (epoch !== generation) return
        reading--
        if (files.get(path) === record) record.pending = false
        pump()
        if (!notify) {
          notify = true
          queueMicrotask(() => { notify = false; onLoaded() })
        }
      })
    }
  }
  const reset = (): void => {
    generation++
    files.clear()
    queue.length = 0
    reading = 0
    previousInput = []
    contacts = []
    groupsKey = ''; groupConfigs = []; treeKey = ''; groupTree = []
    groupInput = undefined; groupNamesKey = ''; groupLabelsKey = ''
    imagesKey = ''; imagePaths.clear(); imageNames.clear(); coversKey = ''; coverPaths = {}
    coverInput = undefined; coverImagesKey = ''
  }
  return {
    /** Whether every listed card has been read at its current signature. */
    settled: (): boolean => ![...files.values()].some((record) => record.pending),
    contacts: (settings: ContactsSettings): Contact[] => {
      const state = owner.getState()
      if (vault !== state.vault?.path) { reset(); vault = state.vault?.path }
      const prefix = settings.contactsRoot ? `${settings.contactsRoot}/` : ''
      const retained = new Set<string>()
      const next: Contact[] = []
      const images: string[] = []
      for (const entry of readEntries()) {
        if (isImagePath(entry.relPath)) { images.push(entry.relPath); continue }
        if (!entry.relPath.startsWith(prefix) || !entry.relPath.toLowerCase().endsWith(CONTACT_EXTENSION)) continue
        retained.add(entry.relPath)
        const key = `${entry.mtimeMs ?? ''}:${entry.size ?? ''}`
        let record = files.get(entry.relPath)
        if (!record || record.key !== key) {
          // Keep serving the previous card while its new bytes are read.
          record = { key, contact: record?.contact ?? null, pending: true, grouped: record?.grouped, groupsKey: record?.groupsKey }
          files.set(entry.relPath, record)
          queue.push({ path: entry.relPath, record })
        }
        if (!record.contact) continue
        const canonical = JSON.stringify(settings.groups.map((group) => group.name))
        if (!record.grouped || record.groupsKey !== canonical || record.grouped.relPath !== record.contact.relPath) {
          const groups = record.contact.groups.map((name) => canonicalGroupName(name, settings.groups) ?? name)
          record.grouped = equalItems(groups, record.contact.groups) ? record.contact : { ...record.contact, groups }
          record.groupsKey = canonical
        }
        next.push(record.grouped)
      }
      for (const path of [...files.keys()]) if (!retained.has(path)) files.delete(path)
      pump()
      if (!equalItems(next, previousInput)) {
        previousInput = next
        const sorted = next.slice().sort((a, b) => a.displayName.localeCompare(b.displayName))
        if (!equalItems(sorted, contacts)) contacts = sorted
      }
      const nextImages = JSON.stringify(images)
      if (nextImages !== imagesKey) {
        imagesKey = nextImages
        imagePaths = new Set(images)
        imageNames = new Map()
        for (const path of images) {
          const name = baseName(path).toLowerCase()
          if (!imageNames.has(name)) imageNames.set(name, path)
        }
      }
      return contacts
    },
    groups: (contacts: Contact[], configured: ContactGroup[]) => {
      const configKey = JSON.stringify(configured)
      if (configKey !== groupsKey) { groupsKey = configKey; groupConfigs = configured }
      const names = JSON.stringify(configured.map((group) => group.name))
      const labels = JSON.stringify([uiText('contacts.group.all'), uiText('contacts.group.none')])
      if (contacts !== groupInput || names !== groupNamesKey || labels !== groupLabelsKey) {
        groupInput = contacts; groupNamesKey = names; groupLabelsKey = labels
        const counts = new Map<string, number>()
        let ungrouped = 0
        for (const contact of contacts) {
          if (!contact.groups.length) ungrouped++
          for (const name of contact.groups) counts.set(name, (counts.get(name) ?? 0) + 1)
        }
        const key = JSON.stringify([contacts.length, ungrouped, [...counts].sort(([a], [b]) => a.localeCompare(b)), names, labels])
        if (key !== treeKey) { treeKey = key; groupTree = buildGroupTree(contacts, configured) }
      }
      return { groupConfigs, groupTree }
    },
    covers: (contacts: Contact[]) => {
      if (contacts === coverInput && imagesKey === coverImagesKey) return coverPaths
      coverInput = contacts; coverImagesKey = imagesKey
      const key = JSON.stringify([imagesKey, contacts.map((contact) => [contact.relPath, contact.cover])])
      if (key !== coversKey) {
        coversKey = key
        const next: Record<string, string | null> = {}
        for (const contact of contacts) next[contact.relPath] = !contact.cover ? null : imagePaths.has(contact.cover) || contact.cover.includes('/')
          ? contact.cover : imageNames.get(contact.cover.toLowerCase()) ?? null
        if (JSON.stringify(next) !== JSON.stringify(coverPaths)) coverPaths = next
      }
      return coverPaths
    },
    dispose: reset
  }
}

/** The virtual group tree: All, configured groups first, then other groups, then No group. */
export function buildGroupTree(contacts: Contact[], configured: ContactGroup[] = []): GroupNode[] {
  const counts = new Map<string, number>()
  let uncategorized = 0
  for (const c of contacts) {
    if (c.groups.length === 0) {
      uncategorized++
      continue
    }
    for (const raw of c.groups) {
      const group = canonicalGroupName(raw, configured) ?? raw
      counts.set(group, (counts.get(group) ?? 0) + 1)
    }
  }
  const configuredKeys = new Set(configured.map((group) => normalizeGroupName(group.name)))
  const groupNodes = [
    ...configured.map((group) => ({
      id: group.name,
      label: group.name,
      count: counts.get(group.name) ?? 0
    })),
    ...[...counts.entries()]
      .filter(([name]) => !configuredKeys.has(normalizeGroupName(name)))
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([id, count]) => ({ id, label: id, count }))
  ]
  const tree: GroupNode[] = [{ id: ALL, label: uiText('contacts.group.all'), count: contacts.length }, ...groupNodes]
  if (uncategorized > 0) tree.push({ id: UNCATEGORIZED, label: uiText('contacts.group.none'), count: uncategorized })
  return tree
}

/** Filter contacts to a group node id. */
export function filterByGroup(contacts: Contact[], groupId: string): Contact[] {
  if (groupId === ALL) return contacts
  if (groupId === UNCATEGORIZED) return contacts.filter((c) => c.groups.length === 0)
  return contacts.filter((contact) => contact.groups.some((name) => normalizeGroupName(name) === normalizeGroupName(groupId)))
}

export function filterByGroupVisibility(
  contacts: Contact[],
  hiddenGroups: string[],
  hideUngrouped: boolean
): Contact[] {
  const hidden = new Set(hiddenGroups.map(normalizeGroupName))
  return contacts.filter((contact) => contact.groups.length === 0
    ? !hideUngrouped
    : contact.groups.some((name) => !hidden.has(normalizeGroupName(name))))
}

/** Every group name in use, for the chip editors. */
export function allGroups(configured: ContactGroup[] = []): string[] {
  return configured.map((group) => group.name)
}

export function groupColorFor(group: string | null | undefined, configured: ContactGroup[]): string {
  if (!normalizeGroupName(group ?? '')) return DEFAULT_AVATAR_COLOR
  return sharedGroupColorFor(group, configured)
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

function isImagePath(path: string): boolean {
  return (IMAGE_EXTENSIONS as readonly string[]).includes(fileExtension(path))
}

export function resolveCoverPath(entries: readonly PluginIndexEntry[], cover: string | undefined): string | null {
  if (!cover) return null
  const exact = entries.find((e) => e.relPath === cover)
  if (exact && isImagePath(exact.relPath)) return exact.relPath
  if (cover.includes('/')) return cover
  const base = baseName(cover).toLowerCase()
  const match = entries.find((e) => isImagePath(e.relPath) && baseName(e.relPath).toLowerCase() === base)
  return match ? match.relPath : null
}

export function resolveContactCovers(contacts: Contact[], entries: readonly PluginIndexEntry[]): Record<string, string | null> {
  const imagePaths = new Set<string>()
  const imageNames = new Map<string, string>()
  for (const entry of entries) {
    if (!isImagePath(entry.relPath)) continue
    imagePaths.add(entry.relPath)
    const name = baseName(entry.relPath).toLowerCase()
    if (!imageNames.has(name)) imageNames.set(name, entry.relPath)
  }
  const out: Record<string, string | null> = {}
  for (const c of contacts) {
    const cover = c.cover
    out[c.relPath] = !cover ? null : imagePaths.has(cover) || cover.includes('/')
      ? cover
      : imageNames.get(cover.toLowerCase()) ?? null
  }
  return out
}

/** Resolve a contact by name (file, display, or first + last) to its relPath. */
export function resolveContactPath(name: string, contacts: Contact[]): string | null {
  const key = name.toLowerCase().trim()
  for (const c of contacts) {
    if (c.fileName.toLowerCase() === key) return c.relPath
    if (c.displayName.toLowerCase() === key) return c.relPath
    if ([c.firstName, c.lastName].filter(Boolean).join(' ').toLowerCase() === key) return c.relPath
  }
  return null
}

/** Resolve a relation target — a card UID first, then a name — to its contact. */
export function resolveRelation(to: string, contacts: Contact[]): Contact | null {
  const ref = to.trim()
  if (!ref) return null
  if (/^urn:uuid:/i.test(ref) || contacts.some((contact) => contact.uid && contact.uid === ref)) {
    return contacts.find((contact) => contact.uid.toLowerCase() === ref.toLowerCase()) ?? null
  }
  const path = resolveContactPath(ref, contacts)
  return path ? contacts.find((contact) => contact.relPath === path) ?? null : null
}

/** How a relation target reads: the linked contact's name, else the stored name. */
export function relationLabel(to: string, contacts: Contact[]): string {
  return resolveRelation(to, contacts)?.displayName ?? (/^urn:uuid:/i.test(to) ? uiText('contacts.relation.missing') : to)
}

/** A relation target for a typed name: the matching contact's UID when it has one. */
export function relationTarget(name: string, contacts: Contact[]): string {
  const trimmed = name.trim()
  const contact = resolveRelation(trimmed, contacts)
  return contact?.uid || trimmed
}

function documentOwner(owner: ValleyPluginApi): documents.ContactDocumentOwner {
  const index = getContactIndex(owner)
  return { root: () => getSettings(owner).contactsRoot, assertCurrent: index.assertCurrent, vault: owner.vault }
}
export const uniqueContactPath = (base: string, options: { dir?: string; ignore?: string } = {}, owner = api) => documents.uniqueContactPath(base, options, documentOwner(owner))
export const renameContactFile = (path: string, base: string, document: TextDocumentRead, owner = api) => documents.renameContactFile(path, base, document, documentOwner(owner))
export const readContactDocument = (path: string, owner = api) => documents.readContactDocument(path, documentOwner(owner))
export const saveContact = (contact: Contact, options: documents.SaveContactOptions = {}, owner = api) => documents.saveContact(contact, options, documentOwner(owner))
export const deleteContact = (path: string, owner = api, document?: TextDocumentRead) => documents.deleteContact(path, documentOwner(owner), document)
export { sanitizeFileName, contactFileBase, contactTrashWarning, UNTITLED_FILE_BASE } from './contactDocuments'
export type { SaveContactOptions, ContactSave } from './contactDocuments'
