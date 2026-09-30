/**
 * The contacts plugin's command-bus surface (`contacts:*`) — query/list, full CRUD
 * on a contact card, and the small append/remove ops on its list-valued fields
 * (phone/email/group/relation), so the palette, terminal CLI, and the assistant
 * agent all drive the same address book through one typed catalog.
 *
 * Every write command captures the target card's exact prior bytes before
 * mutating and reverts by writing them back verbatim, which gives contacts
 * mutations a real ⌘Z entry.
 */
import type { PluginCommand, ValleyPluginApi } from '@valley/plugin-sdk'
import type { Contact, ContactMethod, RelationType } from './types'
import type { CommandSideEffect } from '@valley/plugin-sdk/commands'
import { getContactIndex } from './indexOwner'
import { api as runtimeApi } from './runtime'
import { emptyContact } from './schema'
import { RELATION_TYPES } from './types'
import {
  ALL,
  deleteContact,
  contactTrashWarning,
  filterByGroup,
  getGlobalGroups,
  normalizeGroupName,
  relationLabel,
  relationTarget,
  saveContact,
  readContactDocument,
  type SaveContactOptions
} from './data'
import { inferRelationType, parseContactFile } from './schema'
import { searchHaystack } from './util'
import { getStore, loadContacts } from './store'
import { groupForName } from '@valley/plugin-sdk/groups'

const MAX_NOTE_CHARS = 4000

const asStr = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))
const asPosIntOpt = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}
const asStrOpt = (v: unknown): string | undefined => {
  const s = asStr(v).trim()
  return s || undefined
}

/** Resolve a contact by exact relPath or by name (file/display/first+last/nickname). */
function resolveContact(contacts: Contact[], query: string): Contact | null {
  const q = query.trim()
  if (!q) return null
  const exact = contacts.find((c) => c.relPath === q)
  if (exact) return exact
  const matches = contacts.filter((c) => [c.fileName, c.displayName, c.nickname, [c.firstName, c.lastName].filter(Boolean).join(' ')].some((name) => name.toLowerCase() === q.toLowerCase()))
  if (matches.length > 1) throw new Error(`Multiple contacts match "${q}". Use the exact vault path.`)
  return matches[0] ?? null
}

function requireContact(contacts: Contact[], query: string): Contact {
  const found = resolveContact(contacts, query)
  if (!found) throw new Error(`No contact matches "${query}".`)
  return found
}

function summaryLine(c: Contact): string {
  const bits = [c.displayName]
  if (c.groups.length) bits.push(`[${c.groups.join(', ')}]`)
  if (c.phone[0]) bits.push(c.phone[0].value)
  if (c.email[0]) bits.push(c.email[0].value)
  return bits.join('  ')
}

/** Read a card's exact bytes, mutate the parsed contact, save, and return a revert that restores the original bytes verbatim. */
async function mutateContact(
  api: ValleyPluginApi,
  relPath: string,
  mutate: (contact: Contact) => Contact,
  saveOptions: SaveContactOptions = {}
): Promise<{ contact: Contact; restore(): Promise<void> }> {
  const document = await readContactDocument(relPath, api)
  const current = parseContactFile(relPath, document.content)
  const updated = mutate(current)
  const saved = await saveContact(updated, { ...saveOptions, previous: current, document }, api)
  if (!saved) throw new Error(`Failed to save "${current.displayName}".`)
  return { contact: { ...updated, relPath: saved.relPath }, restore: saved.restore }
}

async function contactRaw(api: ValleyPluginApi, relPath: string): Promise<string> {
  return (await readContactDocument(relPath, api)).content
}


function methodEquals(a: ContactMethod, value: string, type?: string): boolean {
  if (a.value.trim().toLowerCase() !== value.trim().toLowerCase()) return false
  if (type === undefined) return true
  return (a.type ?? '').trim().toLowerCase() === type.trim().toLowerCase()
}

const contactTextFields = ['firstName', 'middleName', 'lastName', 'nickname', 'birthdate', 'profession', 'cover', 'lastContact'] as const
const contactArrayFields = ['groups', 'phone', 'email', 'place', 'organization', 'socialMedia', 'websites', 'relations'] as const
const stringSchema = { type: 'string' }
const rowSchema = (keys: string[]) => ({ type: 'object', properties: Object.fromEntries(keys.map((key) => [key, stringSchema])), additionalProperties: false })
export const contactValuesSchema = { type: 'object', additionalProperties: false, properties: {
  ...Object.fromEntries([...contactTextFields, 'fileName', 'notes'].map((key) => [key, stringSchema])),
  ...Object.fromEntries(['groups', 'websites'].map((key) => [key, { type: 'array', items: stringSchema }])),
  ...Object.fromEntries(['phone', 'email', 'place'].map((key) => [key, { type: 'array', items: { ...rowSchema(['value', 'type']), required: ['value'] } }])),
  organization: { type: 'array', items: rowSchema(['name', 'title', 'dept']) },
  socialMedia: { type: 'array', items: rowSchema(['platform', 'handle', 'url']) },
  relations: { type: 'array', items: { ...rowSchema(['to', 'type', 'role']), required: ['to', 'type'], properties: { to: stringSchema, type: { type: 'string', enum: [...RELATION_TYPES] }, role: stringSchema } } }
} }

export function parseContactValues(raw: unknown): Partial<Contact> & { notes?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected contact values.')
  const values = raw as Record<string, unknown>
  const allowed = [...contactTextFields, ...contactArrayFields, 'fileName', 'notes'] as string[]
  for (const [key, value] of Object.entries(values)) {
    if (!allowed.includes(key)) throw new Error(`Unsupported contact property "${key}".`)
    if (![...contactArrayFields].includes(key as typeof contactArrayFields[number])) {
      if (typeof value !== 'string') throw new Error(`Expected text for "${key}".`)
    } else {
      if (!Array.isArray(value)) throw new Error(`Expected a list for "${key}".`)
      if (key === 'groups' || key === 'websites') {
        if (!value.every((entry) => typeof entry === 'string')) throw new Error(`Expected text entries for "${key}".`)
      } else {
        const fields = key === 'organization' ? ['name', 'title', 'dept'] : key === 'socialMedia' ? ['platform', 'handle', 'url'] : key === 'relations' ? ['to', 'type', 'role'] : ['value', 'type']
        for (const entry of value) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.entries(entry).some(([field, text]) => !fields.includes(field) || typeof text !== 'string')) throw new Error(`Invalid "${key}" entry.`)
          if (['phone', 'email', 'place'].includes(key) && typeof entry.value !== 'string') throw new Error(`Missing "${key}" value.`)
          if (key === 'relations' && (typeof entry.to !== 'string' || !entry.to.trim() || !RELATION_TYPES.includes(entry.type))) throw new Error('Invalid contact relation.')
        }
      }
    }
  }
  return values as Partial<Contact> & { notes?: string }
}

export async function editContactValues(path: string, values: ReturnType<typeof parseContactValues>, expectedRaw?: string, api = runtimeApi) {
  await getStore(api).ready()
  const document = await readContactDocument(path, api)
  const current = parseContactFile(path, document.content)
  if (expectedRaw !== undefined && expectedRaw !== document.content) throw new Error('This contact changed elsewhere. Reload it before saving; your draft is preserved.')
  const { notes, fileName, ...patch } = values
  const next = { ...current, ...patch, ...(notes !== undefined ? { note: notes } : {}) }
  const saved = await saveContact(next, { previous: current, fileName, document }, api)
  if (!saved) throw new Error('Could not save the contact.')
  return { value: { ...next, relPath: saved.relPath }, revert: { label: `Edit "${current.displayName}"`, run: saved.restore } }
}

export async function contactCommandRevision(raw: unknown, api = runtimeApi): Promise<unknown> {
  await getStore(api).ready()
  const input = (raw ?? {}) as { path?: string; name?: string }
  const query = input.path ?? input.name
  if (!query) return { settings: api.settings.get(), paths: loadContacts(api).map((contact) => contact.relPath).sort() }
  const contact = requireContact(loadContacts(api), query)
  return { path: contact.relPath, content: await contactRaw(api, contact.relPath) }
}

/** Register every `contacts:*` command; returns a combined disposer. */
export function registerContactsCommands(api: ValleyPluginApi): () => void {
  const index = getContactIndex(api)
  // Commands run against the complete list: the index and every card read.
  const ready = async (): Promise<void> => { await getStore(api).ready(); index.assertCurrent() }
  const register = <I, O, E extends CommandSideEffect = 'read'>(definition: PluginCommand<I, O, E>): (() => void) => api.commands.register<I, O, E>({
    ...definition,
    run: async (input, context) => { await ready(); return definition.run(input, context) },
    ...(definition.preview ? { preview: async (input: I) => { await ready(); return definition.preview!(input) } } : {}),
    ...(definition.revision ? { revision: async (input: I) => { await ready(); return definition.revision!(input) } } : {})
  })

  const parseUpdateInput = (raw: unknown) => {
    const o = (raw ?? {}) as Record<string, unknown>
    const name = asStr(o.name).trim()
    if (!name) throw new Error('Usage: contacts edit "<name>" [--firstName --lastName --nickname --birthdate --profession --cover --groups --lastContact --fileName]')
    return {
      name,
      firstName: typeof o.firstName === 'string' ? o.firstName.trim() : undefined,
      middleName: typeof o.middleName === 'string' ? o.middleName.trim() : undefined,
      lastName: typeof o.lastName === 'string' ? o.lastName.trim() : undefined,
      nickname: typeof o.nickname === 'string' ? o.nickname.trim() : undefined,
      birthdate: typeof o.birthdate === 'string' ? o.birthdate.trim() : undefined,
      profession: typeof o.profession === 'string' ? o.profession.trim() : undefined,
      cover: typeof o.cover === 'string' ? o.cover.trim() : undefined,
      lastContact: typeof o.lastContact === 'string' ? o.lastContact.trim() : undefined,
      fileName: asStrOpt(o.fileName),
      groups: typeof o.groups === 'string' ? o.groups.split(',').map((g) => normalizeGroupName(g)).filter(Boolean) : undefined
    }
  }
  const updateFromCli = (args: string[], flags: Record<string, string | boolean>) => ({
    name: args.join(' '),
    firstName: flags.firstName,
    middleName: flags.middleName,
    lastName: flags.lastName,
    nickname: flags.nickname,
    birthdate: flags.birthdate,
    profession: flags.profession,
    cover: flags.cover,
    lastContact: flags.lastContact,
    fileName: flags.fileName,
    groups: flags.groups
  })
  const runUpdate = async (input: ReturnType<typeof parseUpdateInput>) => {
    const contacts = loadContacts(api)
    const current = requireContact(contacts, input.name)
    const { contact, restore } = await mutateContact(
      api, current.relPath,
      (c) => ({
        ...c,
        firstName: input.firstName ?? c.firstName,
        middleName: input.middleName ?? c.middleName,
        lastName: input.lastName ?? c.lastName,
        nickname: input.nickname ?? c.nickname,
        birthdate: input.birthdate ?? c.birthdate,
        profession: input.profession ?? c.profession,
        cover: input.cover ?? c.cover,
        lastContact: input.lastContact ?? c.lastContact,
        groups: input.groups ?? c.groups
      }),
      { previous: current, fileName: input.fileName }
    )
    return {
      value: contact,
      revert: { label: `Update "${current.displayName}"`, run: restore }
    }
  }

  const offs = [
    register({
      id: 'edit-fields',
      label: 'Contacts: Edit contact fields',
      labelKey: 'contacts.command.editFields',
      sideEffect: 'write',
      paletteSafe: false,
      input: {
      schema: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, values: contactValuesSchema, expectedRaw: stringSchema }, required: ['path', 'values'], additionalProperties: false },
      parse: (raw) => { const input = raw as { path?: unknown; values?: unknown; expectedRaw?: unknown }; if (!input || typeof input.path !== 'string' || !input.path.trim() || (input.expectedRaw !== undefined && typeof input.expectedRaw !== 'string')) throw new Error('Expected a contact path and values.'); return { path: input.path, values: parseContactValues(input.values), expectedRaw: input.expectedRaw as string | undefined } }
    },
      run: ({ path, values, expectedRaw }) => editContactValues(path, values, expectedRaw, api),
      revision: (input) => contactCommandRevision(input, api),
      preview: (input) => ({ changes: input })
    }),

    register({
      id: 'open-page',
      label: 'Open Contacts page', labelKey: 'auto.da942ff2c46a',
      sideEffect: 'read',
      run: () => {
        api.workspace.openMainTab()
        return undefined
      },
      formatCli: () => 'Opened Contacts page.'
    }),

    register({
      id: 'open-graph',
      label: 'Open contact relationship graph', labelKey: 'auto.2f6a1a48144f',
      sideEffect: 'read',
      run: () => {
        getStore(api).showGraph({ persist: false })
        return undefined
      },
      formatCli: () => 'Opened the contact relationship graph.'
    }),

    // Takes a name OR a vault path; `resolveContact` resolves an exact relPath.
    register({
      id: 'open',
      label: 'Contacts: Open a contact', labelKey: 'auto.70b325ca96a8',
      paletteSafe: false,
      sideEffect: 'read',
      input: {
        schema: {"type":"object","properties":{"name":{"type":"string"},"path":{"type":"string"}},"required":[],"additionalProperties":false},
        parse: (raw) => {
          const o = (raw ?? {}) as Record<string, unknown>
          const name = asStr(o.name).trim() || asStr(o.path).trim()
          if (!name) throw new Error('Usage: contacts open "<name>"')
          return { name }
        },
        fromCli: (args) => ({ name: args.join(' ') })
      },
      run: ({ name }): Contact => {
        const contact = requireContact(loadContacts(api), name)
        getStore(api).openContact(contact.relPath, { persist: false })
        return contact
      },
      formatCli: (c) => `Opened ${c.displayName}.`
    }),

    register({
      id: 'new-contact',
      label: 'New contact', labelKey: 'auto.f4101c50fadc',
      sideEffect: 'read',
      run: () => {
        getStore(api).startCreate()
        api.workspace.openMainTab()
        return undefined
      },
      formatCli: () => 'Started a new contact.'
    }),

    register({
      id: 'list',
      label: 'Contacts: List / search contacts', labelKey: 'auto.3ced998141a7',
      paletteSafe: false,
      sideEffect: 'read',
      input: {
        schema: {"type":"object","properties":{"query":{"type":"string"},"group":{"type":"string"}},"required":[],"additionalProperties":false},
        parse: (raw) => {
          const o = (raw ?? {}) as Record<string, unknown>
          return { query: asStr(o.query), group: asStr(o.group) }
        },
        fromCli: (args, flags) => ({ query: args.join(' '), group: flags.group })
      },
      run: ({ query, group }): Contact[] => {
        let contacts = loadContacts(api)
        if (group) contacts = filterByGroup(contacts, group === 'all' ? ALL : group)
        const q = query.trim().toLowerCase()
        if (q) contacts = contacts.filter((c) => searchHaystack(c).includes(q))
        return contacts
      },
      formatCli: (contacts) =>
        contacts.length === 0 ? 'No contacts match.' : contacts.map((c) => `  ${summaryLine(c)}`).join('\n')
    }),

    register({
      id: 'get',
      label: 'Contacts: Get a contact', labelKey: 'auto.afb607d12c1c',
      paletteSafe: false,
      sideEffect: 'read',
      input: {
        schema: {"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false},
        parse: (raw) => {
          const name = asStr((raw as Record<string, unknown> | undefined)?.name).trim()
          if (!name) throw new Error('Usage: contacts get "<name>"')
          return { name }
        },
        fromCli: (args) => ({ name: args.join(' ') })
      },
      run: ({ name }): Contact => requireContact(loadContacts(api), name),
      formatCli: (c) => JSON.stringify(c, null, 2)
    }),

    register({
      id: 'note',
      label: "Contacts: Read a contact's note", labelKey: 'auto.2f5ad21dd051',
      paletteSafe: false,
      sideEffect: 'read',
      input: {
        schema: {"type":"object","properties":{"name":{"type":"string"},"maxChars":{"oneOf":[{"type":"integer","minimum":1},{"type":"string"}]}},"required":["name"],"additionalProperties":false},
        parse: (raw) => {
          const o = (raw ?? {}) as Record<string, unknown>
          const name = asStr(o.name).trim()
          if (!name) throw new Error('Usage: contacts note "<name>"')
          return { name, maxChars: asPosIntOpt(o.maxChars) }
        },
        fromCli: (args, flags) => ({ name: args.join(' '), maxChars: flags.maxChars })
      },
      run: async ({ name, maxChars }) => {
        const contact = requireContact(loadContacts(api), name)
        const body = parseContactFile(contact.relPath, await contactRaw(api, contact.relPath)).note.trim()
        const cap = maxChars ?? MAX_NOTE_CHARS
        const truncated = body.length > cap
        return {
          relPath: contact.relPath,
          displayName: contact.displayName,
          note: truncated ? body.slice(0, cap) : body,
          totalChars: body.length,
          truncated
        }
      },
      formatCli: (r) =>
        r.note
          ? r.truncated
            ? `${r.note}\n…(truncated, ${r.totalChars} chars total)`
            : r.note
          : '(no note)'
    }),

    register({
      id: 'create',
      label: 'Contacts: Create a contact',
      labelKey: 'auto.f3dd81a07c9a',
      paletteSafe: false,
      sideEffect: 'write',
      input: {
        schema: {"type":"object","properties":{"firstName":{"type":"string"},"middleName":{"type":"string"},"lastName":{"type":"string"},"nickname":{"type":"string"},"birthdate":{"type":"string"},"profession":{"type":"string"},"groups":{"type":"string"},"phone":{"type":"string"},"phoneType":{"type":"string"},"email":{"type":"string"},"emailType":{"type":"string"},"notes":{"type":"string"}},"required":[],"additionalProperties":false},
        parse: (raw) => {
          const o = (raw ?? {}) as Record<string, unknown>
          const firstName = asStr(o.firstName).trim()
          const lastName = asStr(o.lastName).trim()
          const nickname = asStr(o.nickname).trim()
          if (!firstName && !lastName && !nickname) throw new Error('Usage: contacts create "<first> <last>" [--nickname --profession --groups --phone --email]')
          return {
            firstName,
            lastName,
            middleName: asStr(o.middleName).trim(),
            nickname,
            birthdate: asStr(o.birthdate).trim(),
            profession: asStr(o.profession).trim(),
            groups: asStr(o.groups).split(',').map((g) => normalizeGroupName(g)).filter(Boolean),
            phone: asStrOpt(o.phone),
            phoneType: asStrOpt(o.phoneType),
            email: asStrOpt(o.email),
            emailType: asStrOpt(o.emailType),
            notes: asStr(o.notes)
          }
        },
        fromCli: (args, flags) => {
          const [first, ...rest] = args
          return {
            firstName: first,
            lastName: rest.join(' '),
            middleName: flags.middleName,
            nickname: flags.nickname,
            birthdate: flags.birthdate,
            profession: flags.profession,
            groups: flags.groups,
            phone: flags.phone,
            phoneType: flags.phoneType,
            email: flags.email,
            emailType: flags.emailType,
            notes: flags.notes
          }
        }
      },
      run: async (input) => {
        const blank: Contact = {
          ...emptyContact(),
          firstName: input.firstName,
          middleName: input.middleName,
          lastName: input.lastName,
          nickname: input.nickname,
          birthdate: input.birthdate,
          cover: '',
          groups: input.groups,
          relations: [],
          organization: [],
          email: input.email ? [{ value: input.email, type: input.emailType }] : [],
          phone: input.phone ? [{ value: input.phone, type: input.phoneType }] : [],
          place: [],
          socialMedia: [],
          websites: [],
          events: [],
          lastContact: '',
          profession: input.profession,
          note: input.notes
        }
        // No relPath: saveContact reserves a free one, so a namesake is never overwritten.
        const saved = await saveContact(blank, {}, api)
        if (!saved) throw new Error('Failed to create contact.')
        const contact: Contact = { ...blank, relPath: saved.relPath, displayName: blank.nickname || [blank.firstName, blank.lastName].filter(Boolean).join(' ') || saved.relPath }
        return {
          value: contact,
          revert: {
            label: `Create "${contact.displayName}"`,
            run: saved.restore
          }
        }
      },
      formatCli: (c) => `Created ${c.displayName} (${c.relPath}).`,
      revision: (input) => contactCommandRevision(input, api),
      preview: (input) => ({ changes: input })
    }),

    register({
      id: 'update',
      label: 'Contacts: Update a contact',
      labelKey: 'auto.a004459c59db',
      paletteSafe: false,
      sideEffect: 'write',
      input: {
        schema: {"type":"object","properties":{"name":{"type":"string"},"firstName":{"type":"string"},"middleName":{"type":"string"},"lastName":{"type":"string"},"nickname":{"type":"string"},"birthdate":{"type":"string"},"profession":{"type":"string"},"cover":{"type":"string"},"lastContact":{"type":"string"},"fileName":{"type":"string"},"groups":{"type":"string"}},"required":["name"],"additionalProperties":false},
        parse: parseUpdateInput,
        fromCli: updateFromCli
      },
      run: runUpdate,
      formatCli: (c) => `Updated ${c.displayName} (${c.relPath}).`,
      revision: (input) => contactCommandRevision(input, api),
      preview: (input) => ({ changes: input })
    }),

    register({
      id: 'delete',
      label: 'Contacts: Delete a contact',
      labelKey: 'auto.2ccff97369f0',
      paletteSafe: false,
      sideEffect: 'write',
      input: {
        schema: {"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false},
        parse: (raw) => {
          const name = asStr((raw as Record<string, unknown> | undefined)?.name).trim()
          if (!name) throw new Error('Usage: contacts delete "<name>"')
          return { name }
        },
        fromCli: (args) => ({ name: args.join(' ') })
      },
      run: async ({ name }) => {
        const contact = requireContact(loadContacts(api), name)
        const prior = await readContactDocument(contact.relPath, api)
        const removed = await deleteContact(contact.relPath, api, prior)
        const warning = contactTrashWarning(removed)
        let restoreAttempted = false
        return {
          value: { relPath: contact.relPath, displayName: contact.displayName, warning },
          revert: warning ? null : { label: `Delete "${contact.displayName}"`, run: async () => {
            index.assertCurrent()
            if (restoreAttempted) throw new Error('The contact restore was already attempted.')
            restoreAttempted = true
            const restored = await api.vault.createTextDocumentGuarded(contact.relPath, prior.content)
            if (!restored.ok) throw new Error('The contact path is occupied or could not be restored.')
            if (restored.editorConflict) throw new Error('The contact was restored, but newer editor text remains.')
          } }
        }
      },
      formatCli: (v) => `Deleted ${v.displayName}.${v.warning ? ` ${v.warning}` : ''}`,
      revision: (input) => contactCommandRevision(input, api),
      preview: (input) => ({ changes: input })
    }),

    register({
      id: 'add-phone',
      label: 'Contacts: Add a phone number',
      labelKey: 'auto.f5c54ec7cbb1',
      paletteSafe: false,
      sideEffect: 'write',
      input: {
        schema: {"type":"object","properties":{"name":{"type":"string"},"value":{"type":"string"},"type":{"type":"string"}},"required":["name","value"],"additionalProperties":false},
        parse: (raw) => {
          const o = (raw ?? {}) as Record<string, unknown>
          const name = asStr(o.name).trim()
          const value = asStr(o.value).trim()
          if (!name || !value) throw new Error('Usage: contacts add-phone "<name>" "<number>" [--type mobile]')
          return { name, value, type: asStrOpt(o.type) }
        },
        fromCli: (args, flags) => ({ name: args[0], value: args.slice(1).join(' '), type: flags.type })
      },
      run: async ({ name, value, type }) => {
        const current = requireContact(loadContacts(api), name)
        const { contact, restore } = await mutateContact(api, current.relPath, (c) => ({
          ...c,
          phone: [...c.phone, { value, type }]
        }))
        return { value: contact, revert: { label: `Add phone to "${current.displayName}"`, run: restore } }
      },
      formatCli: (c) => `Added phone for ${c.displayName}.`,
      revision: (input) => contactCommandRevision(input, api),
      preview: (input) => ({ changes: input })
    }),

    register({
      id: 'remove-phone',
      label: 'Contacts: Remove a phone number',
      labelKey: 'auto.6fc5aff071e9',
      paletteSafe: false,
      sideEffect: 'write',
      input: {
        schema: {"type":"object","properties":{"name":{"type":"string"},"value":{"type":"string"},"type":{"type":"string"}},"required":["name","value"],"additionalProperties":false},
        parse: (raw) => {
          const o = (raw ?? {}) as Record<string, unknown>
          const name = asStr(o.name).trim()
          const value = asStr(o.value).trim()
          if (!name || !value) throw new Error('Usage: contacts remove-phone "<name>" "<number>"')
          return { name, value, type: asStrOpt(o.type) }
        },
        fromCli: (args, flags) => ({ name: args[0], value: args.slice(1).join(' '), type: flags.type })
      },
      run: async ({ name, value, type }) => {
        const current = requireContact(loadContacts(api), name)
        const { contact, restore } = await mutateContact(api, current.relPath, (c) => ({
          ...c,
          phone: c.phone.filter((m) => !methodEquals(m, value, type))
        }))
        return { value: contact, revert: { label: `Remove phone from "${current.displayName}"`, run: restore } }
      },
      formatCli: (c) => `Removed phone from ${c.displayName}.`,
      revision: (input) => contactCommandRevision(input, api),
      preview: (input) => ({ changes: input })
    }),

    register({
      id: 'add-email',
      label: 'Contacts: Add an email address',
      labelKey: 'auto.be1cb1b91f78',
      paletteSafe: false,
      sideEffect: 'write',
      input: {
        schema: {"type":"object","properties":{"name":{"type":"string"},"value":{"type":"string"},"type":{"type":"string"}},"required":["name","value"],"additionalProperties":false},
        parse: (raw) => {
          const o = (raw ?? {}) as Record<string, unknown>
          const name = asStr(o.name).trim()
          const value = asStr(o.value).trim()
          if (!name || !value) throw new Error('Usage: contacts add-email "<name>" "<email>" [--type work]')
          return { name, value, type: asStrOpt(o.type) }
        },
        fromCli: (args, flags) => ({ name: args[0], value: args.slice(1).join(' '), type: flags.type })
      },
      run: async ({ name, value, type }) => {
        const current = requireContact(loadContacts(api), name)
        const { contact, restore } = await mutateContact(api, current.relPath, (c) => ({
          ...c,
          email: [...c.email, { value, type }]
        }))
        return { value: contact, revert: { label: `Add email to "${current.displayName}"`, run: restore } }
      },
      formatCli: (c) => `Added email for ${c.displayName}.`,
      revision: (input) => contactCommandRevision(input, api),
      preview: (input) => ({ changes: input })
    }),

    register({
      id: 'remove-email',
      label: 'Contacts: Remove an email address',
      labelKey: 'auto.e5954dae4ebb',
      paletteSafe: false,
      sideEffect: 'write',
      input: {
        schema: {"type":"object","properties":{"name":{"type":"string"},"value":{"type":"string"},"type":{"type":"string"}},"required":["name","value"],"additionalProperties":false},
        parse: (raw) => {
          const o = (raw ?? {}) as Record<string, unknown>
          const name = asStr(o.name).trim()
          const value = asStr(o.value).trim()
          if (!name || !value) throw new Error('Usage: contacts remove-email "<name>" "<email>"')
          return { name, value, type: asStrOpt(o.type) }
        },
        fromCli: (args, flags) => ({ name: args[0], value: args.slice(1).join(' '), type: flags.type })
      },
      run: async ({ name, value, type }) => {
        const current = requireContact(loadContacts(api), name)
        const { contact, restore } = await mutateContact(api, current.relPath, (c) => ({
          ...c,
          email: c.email.filter((m) => !methodEquals(m, value, type))
        }))
        return { value: contact, revert: { label: `Remove email from "${current.displayName}"`, run: restore } }
      },
      formatCli: (c) => `Removed email from ${c.displayName}.`,
      revision: (input) => contactCommandRevision(input, api),
      preview: (input) => ({ changes: input })
    }),

    register({
      id: 'add-group',
      label: 'Contacts: Add to a group',
      labelKey: 'auto.67d0090fcfd1',
      paletteSafe: false,
      sideEffect: 'write',
      input: {
        schema: {"type":"object","properties":{"name":{"type":"string"},"group":{"type":"string"}},"required":["name","group"],"additionalProperties":false},
        parse: (raw) => {
          const o = (raw ?? {}) as Record<string, unknown>
          const name = asStr(o.name).trim()
          const group = normalizeGroupName(asStr(o.group))
          if (!name || !group) throw new Error('Usage: contacts add-group "<name>" "<group>"')
          return { name, group }
        },
        fromCli: (args) => ({ name: args[0], group: args.slice(1).join(' ') })
      },
      run: async ({ name, group }) => {
        const current = requireContact(loadContacts(api), name)
        const configured = groupForName(getGlobalGroups(api), group)
        if (!configured) throw new Error(`Unknown group "${group}". Create it in Settings → Appearance → Groups first.`)
        const { contact, restore } = await mutateContact(api, current.relPath, (c) =>
          c.groups.some((g) => normalizeGroupName(g) === normalizeGroupName(configured.name))
            ? c
            : { ...c, groups: [...c.groups, configured.name] }
        )
        return { value: contact, revert: { label: `Add "${current.displayName}" to ${configured.name}`, run: restore } }
      },
      formatCli: (c) => `${c.displayName} is now in: ${c.groups.join(', ') || '(no groups)'}`,
      revision: (input) => contactCommandRevision(input, api),
      preview: (input) => ({ changes: input })
    }),

    register({
      id: 'remove-group',
      label: 'Contacts: Remove from a group',
      labelKey: 'auto.64762ee09d97',
      paletteSafe: false,
      sideEffect: 'write',
      input: {
        schema: {"type":"object","properties":{"name":{"type":"string"},"group":{"type":"string"}},"required":["name","group"],"additionalProperties":false},
        parse: (raw) => {
          const o = (raw ?? {}) as Record<string, unknown>
          const name = asStr(o.name).trim()
          const group = normalizeGroupName(asStr(o.group))
          if (!name || !group) throw new Error('Usage: contacts remove-group "<name>" "<group>"')
          return { name, group }
        },
        fromCli: (args) => ({ name: args[0], group: args.slice(1).join(' ') })
      },
      run: async ({ name, group }) => {
        const current = requireContact(loadContacts(api), name)
        const { contact, restore } = await mutateContact(api, current.relPath, (c) => ({
          ...c,
          groups: c.groups.filter((g) => normalizeGroupName(g) !== group)
        }))
        return { value: contact, revert: { label: `Remove "${current.displayName}" from ${group}`, run: restore } }
      },
      formatCli: (c) => `${c.displayName} is now in: ${c.groups.join(', ') || '(no groups)'}`,
      revision: (input) => contactCommandRevision(input, api),
      preview: (input) => ({ changes: input })
    }),

    register({
      id: 'add-relation',
      label: 'Contacts: Add a relation to another contact',
      labelKey: 'auto.928bdacd747e',
      paletteSafe: false,
      sideEffect: 'write',
      input: {
        schema: {"type":"object","properties":{"name":{"type":"string"},"to":{"type":"string"},"type":{"type":"string"},"role":{"type":"string"}},"required":["name","to"],"additionalProperties":false},
        parse: (raw) => {
          const o = (raw ?? {}) as Record<string, unknown>
          const name = asStr(o.name).trim()
          const to = asStr(o.to).trim()
          if (!name || !to) throw new Error('Usage: contacts add-relation "<name>" "<other name>" [--type friend --role "best friend"]')
          const role = asStrOpt(o.role)
          const typeRaw = asStr(o.type).trim().toLowerCase()
          const type = (RELATION_TYPES as readonly string[]).includes(typeRaw)
            ? (typeRaw as RelationType)
            : inferRelationType(role)
          return { name, to, type, role }
        },
        fromCli: (args, flags) => ({ name: args[0], to: args.slice(1).join(' '), type: flags.type, role: flags.role })
      },
      run: async ({ name, to, type, role }) => {
        const contacts = loadContacts(api)
        const current = requireContact(contacts, name)
        const { contact, restore } = await mutateContact(api, current.relPath, (c) => ({
          ...c,
          relations: [...c.relations, { to: relationTarget(to, contacts), type, ...(role ? { role } : {}) }]
        }))
        return { value: contact, revert: { label: `Add relation to "${current.displayName}"`, run: restore } }
      },
      formatCli: (c) => `Added relation for ${c.displayName}.`,
      revision: (input) => contactCommandRevision(input, api),
      preview: (input) => ({ changes: input })
    }),

    register({
      id: 'remove-relation',
      label: 'Contacts: Remove a relation to another contact',
      labelKey: 'auto.cf3c344f61bf',
      paletteSafe: false,
      sideEffect: 'write',
      input: {
        schema: {"type":"object","properties":{"name":{"type":"string"},"to":{"type":"string"}},"required":["name","to"],"additionalProperties":false},
        parse: (raw) => {
          const o = (raw ?? {}) as Record<string, unknown>
          const name = asStr(o.name).trim()
          const to = asStr(o.to).trim().toLowerCase()
          if (!name || !to) throw new Error('Usage: contacts remove-relation "<name>" "<other name>"')
          return { name, to }
        },
        fromCli: (args) => ({ name: args[0], to: args.slice(1).join(' ') })
      },
      run: async ({ name, to }) => {
        const contacts = loadContacts(api)
        const current = requireContact(contacts, name)
        const target = relationTarget(to, contacts).toLowerCase()
        const { contact, restore } = await mutateContact(api, current.relPath, (c) => ({
          ...c,
          relations: c.relations.filter((r) => r.to.toLowerCase() !== target && relationLabel(r.to, contacts).toLowerCase() !== to)
        }))
        return { value: contact, revert: { label: `Remove relation from "${current.displayName}"`, run: restore } }
      },
      formatCli: (c) => `Removed relation from ${c.displayName}.`,
      revision: (input) => contactCommandRevision(input, api),
      preview: (input) => ({ changes: input })
    })
  ]

  return () => offs.forEach((off) => off())
}
