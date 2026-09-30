/**
 * One-time transfer of Markdown contact notes (`type: contact` frontmatter plus
 * a Markdown body) into `.vcf` cards. Never part of the packaged plugin.
 *
 *   npx vite-node tooling/markdownToVcard.ts -- <folder> [--write] [--remove-markdown]
 *
 * Without `--write` it only reports what it would do. Existing `.vcf` files are
 * never overwritten; `--remove-markdown` deletes each note only after its card
 * was written.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { buildContactFile, contactDisplayName, emptyContact, inferRelationType, newContactUid, normalizeBirthdate } from '../src/schema'
import { RELATION_TYPES, type Contact, type ContactMethod, type Organization, type Relation, type RelationType, type Social } from '../src/types'

const KNOWN_KEYS = new Set(['type', 'groups', 'cover', 'firstName', 'middleName', 'lastName', 'nickname', 'birthdate', 'relations', 'organization', 'email', 'phone', 'socialMedia', 'place', 'websites', 'events', 'lastContact', 'notes', 'profession', 'location'])

const text = (value: unknown): string => value instanceof Date ? value.toISOString().slice(0, 10) : typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim()
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : value == null ? [] : [value]
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

function methods(value: unknown): ContactMethod[] {
  return list(value).flatMap((item) => {
    const entry = record(item)
    const found = text(typeof item === 'string' ? item : entry.value)
    const type = text(entry.type)
    return found ? [type ? { value: found, type } : { value: found }] : []
  })
}

export interface MarkdownContact {
  contact: Contact
  /** Relation targets as written (`[[Name]]` stripped), resolved in a second pass. */
  relationNames: string[]
  geo?: { lat: number; lng: number }
  unmapped: string[]
}

/** Split a note into its frontmatter and body; null when it is not a contact. */
export function markdownContact(relPath: string, raw: string): MarkdownContact | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)
  if (!match) return null
  const frontmatter = record(parseYaml(match[1]))
  if (text(frontmatter.type).toLowerCase() !== 'contact') return null
  const vcfPath = relPath.replace(/\.md$/i, '.vcf')
  const base = emptyContact(vcfPath)
  const relations: Relation[] = []
  const relationNames: string[] = []
  for (const item of list(frontmatter.relations)) {
    const entry = record(item)
    const name = text(entry.to).replace(/^\[\[/, '').replace(/\]\]$/, '').split('|')[0].trim()
    if (!name) continue
    const role = text(entry.role) || undefined
    const type = text(entry.type).toLowerCase()
    relations.push({ to: name, type: (RELATION_TYPES as readonly string[]).includes(type) ? type as RelationType : inferRelationType(role), ...(role ? { role } : {}) })
    relationNames.push(name)
  }
  const organization: Organization[] = list(frontmatter.organization).flatMap((item) => {
    const entry = record(item)
    const org: Organization = {}
    if (text(entry.name)) org.name = text(entry.name)
    if (text(entry.title)) org.title = text(entry.title)
    if (text(entry.dept)) org.dept = text(entry.dept)
    return org.name || org.title || org.dept ? [org] : []
  })
  const socialMedia: Social[] = list(frontmatter.socialMedia).flatMap((item) => {
    const entry = record(item)
    const social: Social = {}
    if (text(entry.platform)) social.platform = text(entry.platform)
    if (text(entry.handle)) social.handle = text(entry.handle)
    if (text(entry.url)) social.url = text(entry.url)
    return social.platform || social.handle || social.url ? [social] : []
  })
  const contact: Contact = {
    ...base,
    firstName: text(frontmatter.firstName),
    middleName: text(frontmatter.middleName),
    lastName: text(frontmatter.lastName),
    nickname: text(frontmatter.nickname),
    birthdate: normalizeBirthdate(text(frontmatter.birthdate)),
    cover: text(frontmatter.cover),
    groups: list(frontmatter.groups).map(text).filter(Boolean),
    relations,
    organization,
    email: methods(frontmatter.email),
    phone: methods(frontmatter.phone),
    place: methods(frontmatter.place),
    socialMedia,
    websites: list(frontmatter.websites).map(text).filter(Boolean),
    events: list(frontmatter.events).map(text).filter(Boolean),
    lastContact: text(frontmatter.lastContact),
    profession: text(frontmatter.profession),
    uid: newContactUid(),
    note: ''
  }
  contact.displayName = contactDisplayName(contact)
  // A body that opens with the person's name as its heading repeats the card title.
  let body = raw.slice(match[0].length).replace(/^\s+/, '')
  const heading = /^#\s+(.+?)\s*(?:\r?\n|$)/.exec(body)
  if (heading && heading[1].trim().toLowerCase() === contact.displayName.toLowerCase()) body = body.slice(heading[0].length).replace(/^\s+/, '')
  contact.note = body.replace(/\s+$/, '')
  const location = record(frontmatter.location)
  const lat = Number(location.lat), lng = Number(location.lng)
  return {
    contact,
    relationNames,
    ...(Number.isFinite(lat) && Number.isFinite(lng) && location.lat !== undefined ? { geo: { lat, lng } } : {}),
    unmapped: Object.keys(frontmatter).filter((key) => !KNOWN_KEYS.has(key))
  }
}

/** Point `[[Name]]` relations at the matching converted card's UID. */
export function linkRelations(converted: MarkdownContact[]): void {
  const byName = new Map<string, string>()
  for (const { contact } of converted) {
    for (const key of [contact.fileName, contact.displayName, [contact.firstName, contact.lastName].filter(Boolean).join(' ')]) {
      const name = key.toLowerCase().trim()
      if (name && !byName.has(name)) byName.set(name, contact.uid)
    }
  }
  for (const { contact } of converted) {
    contact.relations = contact.relations.map((relation) => ({ ...relation, to: byName.get(relation.to.toLowerCase()) ?? relation.to }))
  }
}

/** The card text for one converted contact (with its coordinates as `GEO`). */
export function vcardFor(entry: MarkdownContact): string {
  const card = buildContactFile(entry.contact)
  return entry.geo ? card.replace(/END:VCARD\r\n$/, `GEO:geo:${entry.geo.lat},${entry.geo.lng}\r\nEND:VCARD\r\n`) : card
}

async function markdownFiles(directory: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) out.push(...await markdownFiles(full))
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(full)
  }
  return out.sort()
}

export async function convertFolder(directory: string, options: { write?: boolean; removeMarkdown?: boolean; log?: (line: string) => void } = {}): Promise<{ converted: number; skipped: string[] }> {
  const log = options.log ?? console.log
  const root = path.resolve(directory)
  const converted: Array<MarkdownContact & { source: string; target: string }> = []
  const skipped: string[] = []
  for (const source of await markdownFiles(root)) {
    const relPath = path.relative(root, source)
    const entry = markdownContact(relPath, await fs.readFile(source, 'utf8'))
    if (!entry) continue
    const target = source.replace(/\.md$/i, '.vcf')
    if (await fs.stat(target).then(() => true, () => false)) { skipped.push(relPath); log(`skip ${relPath}: ${path.basename(target)} exists`); continue }
    converted.push({ ...entry, source, target })
  }
  linkRelations(converted)
  for (const entry of converted) {
    const relPath = path.relative(root, entry.source)
    log(`${options.write ? 'write' : 'would write'} ${path.relative(root, entry.target)}${entry.unmapped.length ? ` (unmapped: ${entry.unmapped.join(', ')})` : ''}`)
    if (!options.write) continue
    await fs.writeFile(entry.target, vcardFor(entry), { flag: 'wx' })
    if (options.removeMarkdown) {
      await fs.rm(entry.source)
      log(`removed ${relPath}`)
    }
  }
  return { converted: converted.length, skipped }
}

// vite-node runs this module directly (and drops it from argv); tests import it.
if (!process.env.VITEST && import.meta.url.endsWith('/tooling/markdownToVcard.ts')) {
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const folder = args.find((arg) => !arg.startsWith('--'))
  if (!folder) throw new Error('Usage: vite-node tooling/markdownToVcard.ts -- <folder> [--write] [--remove-markdown]')
  const result = await convertFolder(folder, { write: args.includes('--write'), removeMarkdown: args.includes('--remove-markdown') })
  console.log(`${result.converted} contact(s)${args.includes('--write') ? ' converted' : ' to convert'}, ${result.skipped.length} skipped.`)
}
