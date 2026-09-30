import type { IndexEntry } from '@valley/plugin-sdk/types'
import { buildContactFile, contactDisplayName, emptyContact } from '../src/schema'
import type { Contact } from '../src/types'

/** A stable UID per path, so fixtures and assertions agree across runs. */
export function uidFor(relPath: string): string {
  let hash = 0
  for (const char of relPath) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return `urn:uuid:00000000-0000-4000-8000-${hash.toString(16).padStart(12, '0')}`
}

/** A contact for `relPath` with the given fields (names drive the display name). */
export function contactAt(relPath: string, fields: Partial<Contact> = {}): Contact {
  const base: Contact = { ...emptyContact(relPath), uid: uidFor(relPath), ...fields }
  return { ...base, displayName: fields.displayName ?? contactDisplayName(base) }
}

/** The `.vcf` text Contacts writes for such a contact. */
export function cardAt(relPath: string, fields: Partial<Contact> = {}): string {
  return buildContactFile(contactAt(relPath, fields))
}

/** The index entry the host reports for a file with this content. */
export function fileEntry(relPath: string, content: string, mtimeMs = 1): IndexEntry {
  return { relPath, title: (relPath.split('/').pop() ?? relPath).replace(/\.[^.]+$/, ''), kind: 'other', mtimeMs, size: content.length }
}

/** Files plus matching index entries for a set of cards. */
export function cardVault(cards: Record<string, Partial<Contact>>, extra: Record<string, string> = {}): { files: Record<string, string>; indexEntries: IndexEntry[] } {
  const files: Record<string, string> = { ...extra }
  for (const [relPath, fields] of Object.entries(cards)) files[relPath] = cardAt(relPath, fields)
  return { files, indexEntries: Object.entries(files).map(([relPath, content]) => fileEntry(relPath, content)) }
}
