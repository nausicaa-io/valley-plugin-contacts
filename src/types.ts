/** Relation edge kinds — describes how two contacts relate (colors graph edges). */
export const RELATION_TYPES = [
  'family',
  'partner',
  'friend',
  'school',
  'work',
  'party',
  'military',
  'other'
] as const

export type RelationType = (typeof RELATION_TYPES)[number]

/**
 * A typed relation to another contact. `to` is the other card's `urn:uuid:`
 * UID when it has one (so renames never break it), else the person's name.
 */
export interface Relation {
  to: string
  type: RelationType
  role?: string
}

/** A labeled contact method (email / phone / place): value plus an optional type. */
export interface ContactMethod {
  value: string
  type?: string
}

/** A workplace / affiliation. */
export interface Organization {
  name?: string
  title?: string
  dept?: string
}

/** A social-media presence. */
export interface Social {
  platform?: string
  handle?: string
  url?: string
}

/** Persisted group color entry in the Contacts plugin settings. */
export interface ContactGroup {
  id: string
  name: string
  color: string
}

/**
 * A configurable social-media platform in the Contacts settings: a display
 * label and a URL template. The template's `{}` placeholder is replaced by the
 * contact's username (a template with no placeholder is treated as a base URL
 * the username is appended to).
 */
export interface SocialLink {
  icon?: string
  id: string
  label: string
  url: string
}

/** A contact read from one `.vcf` file (its first card). */
export interface Contact {
  /** Vault-relative path of the `.vcf` file. */
  relPath: string
  /** File basename without extension — the stable identity / display fallback. */
  fileName: string
  /** Best display name: nickname › first+middle+last › FN › file name. */
  displayName: string
  firstName: string
  middleName: string
  lastName: string
  nickname: string
  birthdate: string
  /** Optional vault image file name/path used as the contact cover/avatar. */
  cover: string
  /** Ordered virtual groups — first one drives the contact accent color. */
  groups: string[]
  relations: Relation[]
  organization: Organization[]
  email: ContactMethod[]
  phone: ContactMethod[]
  place: ContactMethod[]
  socialMedia: Social[]
  websites: string[]
  events: string[]
  lastContact: string
  profession: string
  /** Card `UID` (normally `urn:uuid:…`); '' until the card is first saved. */
  uid: string
  /** Markdown notes kept in the card's `NOTE`. */
  note: string
  /** Embedded `PHOTO` as a data URI, shown when there is no vault cover. */
  photo: string
}

/** A node in the virtual group tree. */
export interface GroupNode {
  id: string
  label: string
  count: number
}
