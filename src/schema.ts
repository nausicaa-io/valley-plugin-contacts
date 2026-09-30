import type {
  Contact,
  ContactMethod,
  Organization,
  Relation,
  RelationType,
  Social
} from './types'
import {
  cardsOf,
  escapeText,
  listValue,
  param,
  parseVCardFile,
  photoDataUri,
  property,
  replaceFirstCard,
  serializeCard,
  structuredValue,
  textValue,
  type PropertyInput,
  type VCardCard,
  type VCardProperty
} from './vcard'

export const CONTACT_EXTENSION = '.vcf'

/** Map a free-text role/relation word onto a relation type (best-effort). */
export function inferRelationType(role: string | undefined): RelationType {
  const r = (role || '').toLowerCase()
  if (!r) return 'other'
  if (/mother|father|mutter|vater|brother|bruder|sister|schwester|parent|eltern|son|sohn|daughter|tochter|cousin|cousine|aunt|tante|uncle|onkel|grand|oma|opa|nephew|niece|family|familie/.test(r))
    return 'family'
  if (/wife|husband|frau|mann|partner|girlfriend|boyfriend|freundin|freund\b|spouse|ehefrau|ehemann/.test(r))
    return 'partner'
  if (/colleague|coworker|co-worker|boss|chef|kolleg|manager|employer|client|business/.test(r))
    return 'work'
  if (/classmate|schoolmate|teacher|lehrer|professor|student|mitschüler|school|schule|gymi|gymnasium/.test(r))
    return 'school'
  if (/army|military|militär|rs |recruit|soldier|kamerad/.test(r)) return 'military'
  if (/friend|buddy|mate|kollega/.test(r)) return 'friend'
  return 'other'
}

// --- Field ownership ---------------------------------------------------------

/**
 * The contact fields and the vCard properties each one owns. An edit replaces
 * only the properties of fields that changed; everything else in the card —
 * unknown properties, other apps' extensions, their order — stays as written.
 */
const FIELDS = {
  names: ['FN', 'N', 'NICKNAME'],
  birthdate: ['BDAY'],
  groups: ['CATEGORIES'],
  organization: ['ORG', 'TITLE'],
  profession: ['ROLE'],
  phone: ['TEL'],
  email: ['EMAIL'],
  place: ['ADR'],
  websites: ['URL'],
  socialMedia: ['SOCIALPROFILE', 'X-SOCIALPROFILE'],
  relations: ['RELATED', 'X-ABRELATEDNAMES'],
  cover: ['X-VALLEY-COVER'],
  events: ['X-VALLEY-EVENT'],
  lastContact: ['X-VALLEY-LASTCONTACT'],
  note: ['NOTE'],
  uid: ['UID']
} as const satisfies Record<string, readonly string[]>

type FieldKey = keyof typeof FIELDS
const FIELD_KEYS = Object.keys(FIELDS) as FieldKey[]

// --- Labels ------------------------------------------------------------------

/** Standard TYPE tokens and the English labels Contacts shows for them. */
const TYPE_LABELS: Record<string, string> = {
  home: 'Home', work: 'Work', cell: 'Mobile', mobile: 'Mobile', fax: 'Fax', pager: 'Pager',
  text: 'Text', video: 'Video', textphone: 'Textphone', main: 'Main', other: 'Other', iphone: 'iPhone'
}
const TYPE_TOKENS: Record<string, string> = { mobile: 'cell', home: 'home', work: 'work', fax: 'fax', pager: 'pager', text: 'text', video: 'video', textphone: 'textphone', main: 'main', other: 'other', iphone: 'iphone', cell: 'cell' }
const GENERIC_TYPES = new Set(['pref', 'internet', 'x400', 'voice', 'dom', 'intl', 'postal', 'parcel', 'msg', 'x-internet'])

const RELATED_TYPES: Record<string, RelationType> = {
  kin: 'family', parent: 'family', child: 'family', sibling: 'family',
  spouse: 'partner', sweetheart: 'partner', date: 'partner', crush: 'partner',
  friend: 'friend', acquaintance: 'friend', met: 'friend',
  colleague: 'work', 'co-worker': 'work',
  'x-school': 'school', 'x-party': 'party', 'x-military': 'military', contact: 'other'
}
const RELATION_TOKENS: Record<RelationType, string> = {
  family: 'kin', partner: 'sweetheart', friend: 'friend', work: 'colleague',
  school: 'x-school', party: 'x-party', military: 'x-military', other: 'contact'
}

/** Apple writes labels as `_$!<Mobile>!$_` in a companion `X-ABLabel`. */
function appleLabel(card: VCardCard, entry: VCardProperty): string {
  if (!entry.group) return ''
  const label = card.properties.find((other) => other.group === entry.group && other.name === 'X-ABLABEL')
  return label ? textValue(label).replace(/^_\$!<(.*)>!\$_$/, '$1').trim() : ''
}

function labelOf(card: VCardCard, entry: VCardProperty): string | undefined {
  const apple = appleLabel(card, entry)
  if (apple) return apple
  const raw = param(entry, 'TYPE').flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean)
  const specific = raw.find((value) => !GENERIC_TYPES.has(value.toLowerCase()))
  if (!specific) return undefined
  return TYPE_LABELS[specific.toLowerCase()] ?? specific
}

function typeParam(label: string | undefined): Array<[string, string]> {
  const value = label?.trim()
  if (!value) return []
  return [['TYPE', TYPE_TOKENS[value.toLowerCase()] ?? value]]
}

// --- Reading -----------------------------------------------------------------

function first(card: VCardCard, name: string): VCardProperty | undefined {
  return card.properties.find((entry) => entry.name === name)
}

function all(card: VCardCard, name: string): VCardProperty[] {
  return card.properties.filter((entry) => entry.name === name)
}

const clean = (value: string | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim()

/** `BDAY` as ISO `YYYY-MM-DD`, `--MM-DD` without a year, or its original text. */
export function normalizeBirthdate(value: string): string {
  const text = value.trim()
  const full = /^(\d{4})-?(\d{2})-?(\d{2})(?:T.*)?$/.exec(text)
  if (full) return `${full[1]}-${full[2]}-${full[3]}`
  const partial = /^--(\d{2})-?(\d{2})$/.exec(text)
  if (partial) return `--${partial[1]}-${partial[2]}`
  return text
}

function birthdateValue(value: string): PropertyInput | null {
  const text = value.trim()
  if (!text) return null
  const full = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (full) return { name: 'BDAY', value: `${full[1]}${full[2]}${full[3]}` }
  const partial = /^--(\d{2})-(\d{2})$/.exec(text)
  if (partial) return { name: 'BDAY', value: `--${partial[1]}${partial[2]}` }
  return { name: 'BDAY', params: [['VALUE', 'text']], value: escapeText(text) }
}

function addressText(entry: VCardProperty): string {
  const label = param(entry, 'LABEL')[0]
  if (label?.trim()) return label.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(', ')
  const parts = structuredValue(entry).map((component) => component.filter(Boolean).join(' '))
  const [pobox, extended, street, locality, region, code, country] = parts
  return [street, extended, pobox, [code, locality].filter(Boolean).join(' '), region, country].map((part) => clean(part)).filter(Boolean).join(', ')
}

function organizations(card: VCardCard): Organization[] {
  const out: Organization[] = []
  const titles = all(card, 'TITLE')
  const used = new Set<VCardProperty>()
  for (const entry of all(card, 'ORG')) {
    const [name, ...units] = structuredValue(entry).map((component) => clean(component.join(', ')))
    const title = (entry.group ? titles.find((candidate) => candidate.group === entry.group && !used.has(candidate)) : undefined)
      ?? titles.find((candidate) => !candidate.group && !used.has(candidate))
    if (title) used.add(title)
    const org: Organization = {}
    if (name) org.name = name
    if (title && clean(textValue(title))) org.title = clean(textValue(title))
    const dept = units.filter(Boolean).join(', ')
    if (dept) org.dept = dept
    if (org.name || org.title || org.dept) out.push(org)
  }
  for (const title of titles) if (!used.has(title) && clean(textValue(title))) out.push({ title: clean(textValue(title)) })
  return out
}

function socials(card: VCardCard): Social[] {
  const out: Social[] = []
  for (const entry of card.properties) {
    if (entry.name !== 'SOCIALPROFILE' && entry.name !== 'X-SOCIALPROFILE') continue
    const value = clean(textValue(entry))
    const platform = clean(param(entry, 'SERVICE-TYPE')[0] ?? param(entry, 'TYPE')[0])
    let handle = clean(param(entry, 'USERNAME')[0] ?? param(entry, 'X-USER')[0])
    let url = ''
    if (/^https?:\/\//i.test(value)) url = value
    else if (value) handle ||= value.replace(/^x-apple:/i, '')
    const social: Social = {}
    if (platform) social.platform = platform
    if (handle) social.handle = handle
    if (url) social.url = url
    if (social.platform || social.handle || social.url) out.push(social)
  }
  return out
}

function relations(card: VCardCard): Relation[] {
  const out: Relation[] = []
  for (const entry of card.properties) {
    if (entry.name === 'RELATED') {
      const to = clean(textValue(entry))
      if (!to) continue
      const role = clean(param(entry, 'X-ROLE')[0]) || undefined
      const token = param(entry, 'TYPE').flatMap((value) => value.split(',')).map((value) => value.trim().toLowerCase()).find((value) => RELATED_TYPES[value])
      out.push({ to, type: token ? RELATED_TYPES[token] : inferRelationType(role), ...(role ? { role } : {}) })
    } else if (entry.name === 'X-ABRELATEDNAMES') {
      const to = clean(textValue(entry))
      if (!to) continue
      const role = appleLabel(card, entry) || undefined
      out.push({ to, type: inferRelationType(role), ...(role ? { role } : {}) })
    }
  }
  return out
}

function methods(card: VCardCard, name: 'EMAIL' | 'TEL'): ContactMethod[] {
  return all(card, name).flatMap((entry) => {
    // `tel:` URIs (vCard 4.0) read as plain numbers, with any extension spelled out.
    const value = clean(textValue(entry)).replace(/^(?:tel|mailto):/i, '').replace(/;ext=([^;]+)/i, ' ext. $1')
    if (!value) return []
    const type = labelOf(card, entry)
    return [type ? { value, type } : { value }]
  })
}

function fileBase(relPath: string): string {
  return (relPath.split('/').pop() ?? relPath).replace(/\.vcf$/i, '')
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    const key = value.toLowerCase()
    if (!value || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** A blank contact for `relPath` (a new or still empty `.vcf`). */
export function emptyContact(relPath = ''): Contact {
  const fileName = fileBase(relPath)
  return {
    relPath, fileName, displayName: fileName, firstName: '', middleName: '', lastName: '', nickname: '',
    birthdate: '', cover: '', groups: [], relations: [], organization: [], email: [], phone: [], place: [],
    socialMedia: [], websites: [], events: [], lastContact: '', profession: '', uid: '', note: '', photo: ''
  }
}

/** Best display name: nickname › first+middle+last › FN › file name. */
export function contactDisplayName(contact: Pick<Contact, 'nickname' | 'firstName' | 'middleName' | 'lastName' | 'fileName'>, formatted = ''): string {
  const full = [contact.firstName, contact.middleName, contact.lastName].filter(Boolean).join(' ')
  return contact.nickname || full || formatted || contact.fileName
}

export function contactFromCard(relPath: string, card: VCardCard): Contact {
  const base = emptyContact(relPath)
  const n = first(card, 'N')
  const [family = [], given = [], additional = []] = n ? structuredValue(n) : []
  const firstName = clean(given.join(' '))
  const middleName = clean(additional.join(' '))
  const lastName = clean(family.join(' '))
  const nicknameProperty = first(card, 'NICKNAME')
  const nickname = nicknameProperty ? clean(listValue(nicknameProperty).filter(Boolean).join(', ')) : ''
  const formatted = clean(first(card, 'FN') ? textValue(first(card, 'FN')!) : '')
  const birthday = first(card, 'BDAY')
  const photo = first(card, 'PHOTO')
  const contact: Contact = {
    ...base,
    firstName,
    middleName,
    lastName,
    nickname,
    birthdate: birthday ? normalizeBirthdate(textValue(birthday)) : '',
    cover: clean(first(card, 'X-VALLEY-COVER') ? textValue(first(card, 'X-VALLEY-COVER')!) : ''),
    groups: dedupe(all(card, 'CATEGORIES').flatMap(listValue).map((value) => clean(value))),
    relations: relations(card),
    organization: organizations(card),
    email: methods(card, 'EMAIL'),
    phone: methods(card, 'TEL'),
    place: all(card, 'ADR').flatMap((entry) => {
      const value = addressText(entry)
      if (!value) return []
      const type = labelOf(card, entry)
      return [type ? { value, type } : { value }]
    }),
    socialMedia: socials(card),
    websites: all(card, 'URL').map((entry) => clean(textValue(entry))).filter(Boolean),
    events: all(card, 'X-VALLEY-EVENT').map((entry) => clean(textValue(entry))).filter(Boolean),
    lastContact: clean(first(card, 'X-VALLEY-LASTCONTACT') ? textValue(first(card, 'X-VALLEY-LASTCONTACT')!) : ''),
    profession: clean(first(card, 'ROLE') ? textValue(first(card, 'ROLE')!) : ''),
    uid: clean(first(card, 'UID') ? textValue(first(card, 'UID')!) : ''),
    note: all(card, 'NOTE').map((entry) => textValue(entry).replace(/\s+$/, '')).filter(Boolean).join('\n\n'),
    photo: photo ? photoDataUri(photo) : ''
  }
  return { ...contact, displayName: contactDisplayName(contact, formatted) }
}

/**
 * Parse a `.vcf` file into its contact (the first card). An empty file is a
 * blank contact, so a `.vcf` created from the file tree can be filled in;
 * anything else without a card is not a contact.
 */
export function parseContactFile(relPath: string, raw: string): Contact {
  if (!raw.trim()) return emptyContact(relPath)
  const card = cardsOf(parseVCardFile(raw))[0]
  if (!card) throw new Error('The file contains no vCard.')
  return contactFromCard(relPath, card)
}

// --- Writing -----------------------------------------------------------------

const text = (name: string, value: string): PropertyInput[] => value.trim() ? [{ name, value: escapeText(value.trim()) }] : []

/** The properties a contact field serializes to (in card order). */
function fieldProperties(contact: Contact, key: FieldKey): PropertyInput[] {
  switch (key) {
    case 'names': {
      const formatted = contactDisplayName(contact, contact.displayName !== contact.fileName ? contact.displayName : '') || 'Unnamed'
      const out: PropertyInput[] = [{ name: 'FN', value: escapeText(formatted) }]
      if (contact.firstName || contact.middleName || contact.lastName) out.push({ name: 'N', value: `${escapeText(contact.lastName)};${escapeText(contact.firstName)};${escapeText(contact.middleName)};;` })
      return [...out, ...text('NICKNAME', contact.nickname)]
    }
    case 'birthdate': {
      const value = birthdateValue(contact.birthdate)
      return value ? [value] : []
    }
    case 'groups':
      return contact.groups.length ? [{ name: 'CATEGORIES', value: contact.groups.map((group) => escapeText(group)).join(',') }] : []
    case 'organization':
      return contact.organization.flatMap((org, index) => {
        const group = contact.organization.length > 1 ? `org${index + 1}` : ''
        const out: PropertyInput[] = []
        if (org.name || org.dept) out.push({ group, name: 'ORG', value: [org.name ?? '', org.dept ?? ''].map((part) => escapeText(part)).join(';').replace(/;$/, '') })
        if (org.title) out.push({ group, name: 'TITLE', value: escapeText(org.title) })
        return out
      })
    case 'profession':
      return text('ROLE', contact.profession)
    case 'phone':
    case 'email':
      return contact[key].map((method) => ({ name: key === 'phone' ? 'TEL' : 'EMAIL', params: typeParam(method.type), value: escapeText(method.value.trim()) }))
    case 'place':
      return contact.place.map((method) => ({ name: 'ADR', params: [...typeParam(method.type), ['LABEL', method.value.trim()]], value: `;;${escapeText(method.value.trim())};;;;` }))
    case 'websites':
      return contact.websites.filter((url) => url.trim()).map((url) => ({ name: 'URL', value: url.trim().replace(/\r?\n/g, '') }))
    case 'socialMedia':
      return contact.socialMedia.map((social) => {
        const params: Array<[string, string]> = []
        if (social.platform) params.push(['SERVICE-TYPE', social.platform])
        if (social.url && social.handle) params.push(['USERNAME', social.handle])
        if (!social.url) params.push(['VALUE', 'text'])
        return { name: 'SOCIALPROFILE', params, value: social.url ? social.url.trim() : escapeText(social.handle ?? '') }
      })
    case 'relations':
      return contact.relations.map((relation) => {
        const params: Array<[string, string]> = [['TYPE', RELATION_TOKENS[relation.type]]]
        if (relation.role) params.push(['X-ROLE', relation.role])
        const uid = /^urn:uuid:/i.test(relation.to)
        return { name: 'RELATED', params: uid ? params : [['VALUE', 'text'], ...params], value: uid ? relation.to : escapeText(relation.to) }
      })
    case 'cover':
      return text('X-VALLEY-COVER', contact.cover)
    case 'events':
      return contact.events.flatMap((event) => text('X-VALLEY-EVENT', event))
    case 'lastContact':
      return text('X-VALLEY-LASTCONTACT', contact.lastContact)
    case 'note':
      return contact.note.trim() ? [{ name: 'NOTE', value: escapeText(contact.note.replace(/\s+$/, '')) }] : []
    case 'uid':
      return contact.uid ? [{ name: 'UID', value: contact.uid }] : []
  }
}

export function newContactUid(): string {
  return `urn:uuid:${crypto.randomUUID()}`
}

/** A new `.vcf` file (vCard 4.0) for a contact. */
export function buildContactFile(contact: Contact): string {
  const withUid = contact.uid ? contact : { ...contact, uid: newContactUid() }
  const order: FieldKey[] = ['uid', ...FIELD_KEYS.filter((key) => key !== 'uid')]
  const properties = [property({ name: 'VERSION', value: '4.0' }), ...order.flatMap((key) => fieldProperties(withUid, key).map(property))]
  return serializeCard({ properties }) + '\r\n'
}

/**
 * Rewrite `raw` so its first card describes `contact`, replacing only the
 * properties of fields that differ from `previous` (the contact parsed from the
 * same bytes). A card without a UID gains one. Returns `raw` untouched when
 * nothing changed.
 */
export function updateContactFile(contact: Contact, previous: Contact, raw: string): string {
  if (!raw.trim()) return buildContactFile(contact)
  const file = parseVCardFile(raw)
  const card = cardsOf(file)[0]
  if (!card) throw new Error('The file contains no vCard.')
  const next = !contact.uid && !first(card, 'UID') ? { ...contact, uid: newContactUid() } : contact
  const changed = FIELD_KEYS.filter((key) => JSON.stringify(fieldProperties(next, key)) !== JSON.stringify(fieldProperties(previous, key)) || (key === 'uid' && !first(card, 'UID') && next.uid))
  if (!changed.length) return raw
  let properties = card.properties.slice()
  for (const key of changed) {
    const owned = new Set<string>(FIELDS[key])
    const removed = properties.filter((entry) => owned.has(entry.name))
    const oldN = key === 'names' ? removed.find((entry) => entry.name === 'N') : undefined
    const replacement = fieldProperties(next, key).map((input) => {
      // Name prefixes and suffixes are not edited here; keep the card's own.
      if (input.name !== 'N' || !oldN) return property(input)
      const [, , , prefix = '', suffix = ''] = oldN.value.split(/(?<!\\);/)
      return property({ ...input, value: input.value.replace(/;;$/, `;${prefix};${suffix}`) })
    })
    const at = removed.length ? properties.indexOf(removed[0]) : properties.length
    const groups = new Set(removed.map((entry) => entry.group).filter(Boolean))
    const kept = properties.filter((entry) => !removed.includes(entry))
    // Apple keeps labels in companion `X-AB*` lines of the same group.
    const orphaned = (entry: VCardProperty) => entry.group !== '' && groups.has(entry.group) && entry.name.startsWith('X-AB') &&
      !kept.some((other) => other.group === entry.group && !other.name.startsWith('X-AB'))
    const before = properties.slice(0, at).filter((entry) => !removed.includes(entry) && !orphaned(entry))
    const after = properties.slice(at).filter((entry) => !removed.includes(entry) && !orphaned(entry))
    properties = [...before, ...replacement, ...after]
  }
  if (!properties.some((entry) => entry.name === 'VERSION')) properties.unshift(property({ name: 'VERSION', value: '4.0' }))
  return replaceFirstCard(file, { properties })
}
