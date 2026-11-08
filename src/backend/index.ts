import { createWorkflowAdapter } from './workflow'
import { z } from 'zod'
import type { PluginBackendApi, PluginBackendOperationContext } from '@valley/plugin-sdk'
import type { FileBaseline, TextDocumentRead } from '@valley/plugin-sdk/types'
import { CONFIG_DIR } from '@valley/plugin-sdk/paths'
import { deleteContact, renameContactFile, saveContact, type ContactDocumentOwner } from '../contactDocuments'
import { emptyContact, parseContactFile } from '../schema'

/** Largest NOTE a command accepts: measured to save and read back well inside one 1000 ms guest CPU turn. */
export const NOTE_LIMIT = 256 * 1024
/** Largest set of fields (as JSON text) one create or update accepts, for the same reason: every field is folded and parsed again. */
export const FIELDS_LIMIT = 384 * 1024
/**
 * Largest encoded result a command returns. The command bus carries an ordinary command's result up to 1 MiB and a larger
 * one after a write leaves its outcome unknown, so a save whose result would not fit is refused before writing. A read
 * returns the file text and its photo, so it is refused for a photo above about 500 KiB; the Contacts view is not limited.
 */
export const RESULT_LIMIT = 1024 * 1024 - 16 * 1024
const text = z.string().max(65536), list = z.array(text).max(1000)
const path = z.string().min(5).max(4096).regex(/\.[vV][cC][fF]$/).refine(value => !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && value.split('/').every(part => part && part !== '.' && part !== '..'))
const baseline = z.object({ mtimeMs: z.number().finite(), size: z.number().int().nonnegative(), hash: z.string().min(1).max(128) }).strict()
const method = z.object({ value: text, type: text.optional() }).strict()
const editable = z.object({
  firstName: text, middleName: text, lastName: text, nickname: text, birthdate: text, cover: text, groups: list,
  relations: z.array(z.object({ to: text, type: z.enum(['family', 'partner', 'friend', 'school', 'work', 'party', 'military', 'other']), role: text.optional() }).strict()).max(1000),
  organization: z.array(z.object({ name: text.optional(), title: text.optional(), dept: text.optional() }).strict()).max(1000),
  email: z.array(method).max(1000), phone: z.array(method).max(1000), place: z.array(method).max(1000),
  socialMedia: z.array(z.object({ platform: text.optional(), handle: text.optional(), url: text.optional() }).strict()).max(1000), websites: list, events: list,
  lastContact: text, profession: text, note: z.string().max(NOTE_LIMIT)
}).strict()
export const contactSchema = editable.extend({ relPath: path, fileName: text, displayName: text, uid: text, photo: z.string().max(4 * 1024 * 1024) }).strict()
export const inputSchemas = {
  'contacts.list': z.object({ query: z.string().max(500).default(''), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(50) }).strict(),
  'contacts.read': z.object({ path }).strict(),
  'contacts.create': z.object({ fields: editable.partial().strict(), fileName: z.string().max(500).optional() }).strict(),
  'contacts.update': z.object({ path, patch: editable.partial().strict().refine(value => Object.keys(value).length > 0), expected: baseline, fileName: z.string().max(500).optional() }).strict(),
  'contacts.delete': z.object({ path, expected: baseline }).strict(),
  'contacts.rename': z.object({ path, fileName: z.string().min(1).max(500), expected: baseline }).strict(),
  'contacts.restore': z.object({ token: z.string().min(1).max(256) }).strict()
}
const summarySchema = contactSchema.pick({ relPath: true, fileName: true, displayName: true, firstName: true, lastName: true, nickname: true, groups: true })
const savedSchema = z.object({ contact: contactSchema, baseline: baseline.nullable(), editorConflict: z.boolean() }).strict()
export const outputSchemas = {
  'contacts.list': z.object({ contacts: z.array(summarySchema), errors: z.array(z.object({ path: z.string(), message: z.string() }).strict()), next: z.number().int().nonnegative().nullable() }).strict(),
  'contacts.read': z.object({ contact: contactSchema, content: z.string(), baseline }).strict(),
  'contacts.create': savedSchema,
  'contacts.update': savedSchema,
  'contacts.delete': z.object({ ok: z.literal(true), destination: z.enum(['system', 'realm']), token: z.string().optional(), editorConflict: z.boolean(), recoverySaved: z.boolean() }).strict(),
  'contacts.rename': savedSchema,
  'contacts.restore': z.object({ ok: z.literal(true), restoredPath: z.string() }).strict()
}
function bounded<T>(fields: T): T {
  if (JSON.stringify(fields).length > FIELDS_LIMIT) throw Object.assign(new Error('Contact fields exceed their size limit'), { code: 'RESOURCE_LIMIT', outcome: 'not-applied', retryable: false })
  return fields
}
const refused = (code: string, message: string): Error => Object.assign(new Error(message), { code, outcome: 'not-applied' as const, retryable: false })
/**
 * UTF-8 bytes of the result envelope the host encodes. Only the non-ASCII remainder is walked character by character:
 * a photo is several MiB of ASCII, and a per-character loop over it costs more than the whole read.
 */
function encodedBytes(value: unknown): number {
  // Match single characters: a run quantifier over MiBs of ASCII exhausts the guest's regular-expression memory.
  const json = JSON.stringify({ value }), wide = json.match(/[^\x00-\x7f]/g) ?? []
  let bytes = json.length
  for (const char of wide) {
    const code = char.charCodeAt(0)
    bytes += code < 0x800 || (code >= 0xd800 && code <= 0xdbff) ? 1 : 2
  }
  return bytes
}
/** Refuses before any effect when `value` would not fit in an operation result. */
function fits<T>(value: T): T {
  if (encodedBytes(value) > RESULT_LIMIT) throw refused('RESOURCE_LIMIT', 'This contact is too large to return through a command; open it in Contacts')
  return value
}
function parse<M extends keyof typeof inputSchemas>(method: M, raw: unknown): z.infer<(typeof inputSchemas)[M]> {
  const result = inputSchemas[method].safeParse(raw)
  if (!result.success) throw refused('INVALID_INPUT', result.error.issues.map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ').slice(0, 1000))
  const path = (result.data as { path?: unknown }).path
  if (typeof path === 'string' && path.split('/')[0].toLowerCase() === CONFIG_DIR) throw refused('PATH_REFUSED', 'Contacts cannot use files in the realm configuration folder')
  return result.data as z.infer<(typeof inputSchemas)[M]>
}
function conflict(): never { throw Object.assign(new Error('Contact changed; read its current revision before editing'), { code: 'REVISION_CONFLICT', outcome: 'not-applied' }) }
function rootFor(api: PluginBackendOperationContext['api']): string {
  const value = api.settings.get().contactsRoot
  const root = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : ''
  return root === '.' || root === '/' ? '' : root
}
function documentOwner(context: PluginBackendOperationContext) {
  let committed = false, attempted = false
  const attempt = () => { attempted = true }
  const mutationResult = <T extends { ok: boolean }>(result: T): T => { if (result.ok) committed = true; return result }
  const receipts = new Map<string, { path: string; content: string; baseline: FileBaseline }>()
  const issue = (path: string, content: string, baseline: FileBaseline): TextDocumentRead => { const revisionToken = crypto.randomUUID(); receipts.set(revisionToken, { path, content, baseline }); return { content, revisionToken } }
  const take = (path: string, token: string) => { const value = receipts.get(token); if (!value || value.path !== path) conflict(); receipts.delete(token); return value }
  const assertCurrent = () => context.cancellation.throwIfAborted()
  const owner: ContactDocumentOwner = {
    root: () => rootFor(context.api), assertCurrent,
    realm: {
      stat: file => context.api.realm.stat(file),
      readTextDocument: async file => { assertCurrent(); const value = await context.api.realm.read(file); assertCurrent(); return value?.baseline ? issue(file, value.content, value.baseline) : null },
      createTextDocumentGuarded: async (file, content) => { assertCurrent(); attempt(); const result = mutationResult(await context.api.realm.write(file, content, null)); return result.ok ? { ok: true, revisionToken: issue(file, content, result.baseline).revisionToken, editorConflict: false } : result },
      writeTextDocumentGuarded: async (file, content, token) => { const previous = take(file, token); assertCurrent(); attempt(); const result = mutationResult(await context.api.realm.write(file, content, previous.baseline)); return result.ok ? { ok: true, revisionToken: issue(file, content, result.baseline).revisionToken, editorConflict: false } : result },
      renameTextDocumentGuarded: async (file, target, token) => { const previous = take(file, token); assertCurrent(); attempt(); const result = await context.api.realm.rename(file, target, previous.baseline); if (!result.ok) throw Object.assign(new Error(`Contact rename failed: ${result.reason}`), { code: 'RENAME_CONFLICT', outcome: committed ? 'unknown' : 'not-applied' }); mutationResult(result); return result.ok ? { ok: true, relPath: result.relPath, revisionToken: result.baseline.hash === previous.baseline.hash ? issue(result.relPath, previous.content, result.baseline).revisionToken : null, editorConflict: result.baseline.hash !== previous.baseline.hash } : result },
      trashTextDocumentGuarded: async (file, token) => {
        const previous = take(file, token); assertCurrent(); attempt()
        const result = await context.api.realm.trash(file, previous.baseline)
        if (!result.ok && !committed) throw refused('REVISION_CONFLICT', 'Contact changed; read its current revision before deleting')
        return result.ok ? { ...result, editorConflict: false, recoverySaved: true } : result
      }
    }
  }
  return { owner, attempt, untouched: () => !attempted, baselineFor: (document: TextDocumentRead | null) => document ? receipts.get(document.revisionToken)?.baseline ?? null : null }
}
/** Trash receipts this backend issued; the host accepts only its own session's receipts, so any other token is refused before the call. */
export interface ContactSession { trashTokens: Set<string> }
export function handlers(context: PluginBackendOperationContext, session: ContactSession = { trashTokens: new Set() }) {
  const { owner, attempt, untouched, baselineFor } = documentOwner(context)
  const read = async (file: string, expected?: FileBaseline) => {
    owner.assertCurrent()
    const document = await owner.realm.readTextDocument(file)
    if (!document) throw refused('NOT_FOUND', 'Contact file does not exist')
    const observed = baselineFor(document)!
    if (expected && (expected.hash !== observed.hash || expected.size !== observed.size)) conflict()
    let contact: ReturnType<typeof parseContactFile>
    try { contact = parseContactFile(file, document.content) } catch (cause) { throw refused('INVALID_CONTACT', cause instanceof Error ? cause.message : 'The file is not a vCard') }
    return { document, contact, baseline: observed }
  }
  const saved = (result: Awaited<ReturnType<typeof saveContact>>, fallback: ReturnType<typeof emptyContact>) => {
    if (!result) conflict()
    return { contact: result.document ? parseContactFile(result.relPath, result.document.content) : { ...fallback, relPath: result.relPath }, baseline: baselineFor(result.document), editorConflict: result.editorConflict }
  }
  const methods = {
    'contacts.list': async (raw: unknown) => {
      const input = parse('contacts.list', raw), root = rootFor(context.api)
      const observation = await context.api.index.observe({ extensions: ['.vcf'], ...(root ? { pathPrefix: root } : {}), fields: [] }, () => {})
      try {
        const page = await observation.read({ offset: input.offset, limit: input.limit })
        if (page.status !== 'ready') throw Object.assign(new Error(page.error ?? 'Contact index is loading'), { code: 'INDEX_NOT_READY' })
        const contacts: Array<z.infer<typeof summarySchema>> = [], errors: Array<{ path: string; message: string }> = []
        for (const entry of page.entries) {
          context.cancellation.throwIfAborted()
          try { const value = (await read(entry.relPath)).contact; if (!input.query || JSON.stringify(value).toLocaleLowerCase().includes(input.query.toLocaleLowerCase())) contacts.push(summarySchema.parse({ relPath: value.relPath, fileName: value.fileName, displayName: value.displayName, firstName: value.firstName, lastName: value.lastName, nickname: value.nickname, groups: value.groups })) }
          catch (error) { context.cancellation.throwIfAborted(); errors.push({ path: entry.relPath, message: error instanceof Error ? error.message : String(error) }) }
        }
        return { contacts, errors, next: page.next }
      } finally { await observation.dispose() }
    },
    'contacts.read': async (raw: unknown) => { const input = parse('contacts.read', raw), value = await read(input.path); return fits({ contact: value.contact, content: value.document.content, baseline: value.baseline }) },
    'contacts.create': async (raw: unknown) => { const input = parse('contacts.create', raw), contact = { ...emptyContact(), ...bounded(input.fields) }; return saved(await saveContact(contact, { fileName: input.fileName }, owner), contact) },
    'contacts.update': async (raw: unknown) => { const input = parse('contacts.update', raw), patch = bounded(input.patch), previous = await read(input.path, input.expected), contact = { ...previous.contact, ...patch }; fits({ contact, baseline: previous.baseline, editorConflict: false }); return saved(await saveContact(contact, { previous: previous.contact, document: previous.document, fileName: input.fileName }, owner), contact) },
    'contacts.delete': async (raw: unknown) => {
      const input = parse('contacts.delete', raw), previous = await read(input.path, input.expected), result = await deleteContact(input.path, owner, previous.document)
      if (result.token) session.trashTokens.add(result.token)
      return result
    },
    'contacts.rename': async (raw: unknown) => {
      const input = parse('contacts.rename', raw), previous = await read(input.path, input.expected)
      fits({ contact: previous.contact, baseline: previous.baseline, editorConflict: false })
      const result = await renameContactFile(input.path, input.fileName, previous.document, owner)
      return { contact: result.document ? parseContactFile(result.relPath, result.document.content) : { ...previous.contact, relPath: result.relPath }, baseline: baselineFor(result.document), editorConflict: !result.document }
    },
    'contacts.restore': async (raw: unknown) => {
      const input = parse('contacts.restore', raw)
      if (!session.trashTokens.has(input.token)) throw refused('RESTORE_TOKEN_UNKNOWN', 'This trash receipt was not issued by the running Contacts backend')
      attempt()
      const result = await context.api.realm.restore(input.token)
      if (!result.ok) throw refused('RESTORE_CONFLICT', result.message ?? 'Contact could not be restored')
      session.trashTokens.delete(input.token)
      if (!result.restoredPath) throw Object.assign(new Error('Contact restore returned no path'), { code: 'RESTORE_CONFLICT' })
      return { ok: true as const, restoredPath: result.restoredPath }
    }
  }
  // A failure before any realm mutation was attempted (a malformed card, cancellation, a refused read) left nothing
  // applied; once one was attempted only an explicit refusal is not-applied and anything else stays uncertain.
  return Object.fromEntries(Object.entries(methods).map(([name, run]) => [name, async (raw: unknown) => {
    try { return await run(raw) } catch (cause) {
      if (!untouched()) throw cause
      const error: Error & { outcome?: string } = cause && typeof cause === 'object' ? cause as Error : new Error(String(cause))
      if (error.outcome === undefined) error.outcome = 'not-applied'
      throw error
    }
  }])) as typeof methods
}
export function register(api: PluginBackendApi): () => void {
  const workflow = createWorkflowAdapter(api)
  const session: ContactSession = { trashTokens: new Set() }
  const disposers = Object.keys(inputSchemas).map(method => workflow.operation(`command.${method}`, async (input, context) => {
    const value = await handlers(context, session)[method as keyof typeof inputSchemas](input)
    // The host encodes the result in the turn the operation resolves in; a large one (a photo) gets that turn to itself.
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    return value
  }))
  return () => { workflow.dispose(); disposers.forEach(dispose => dispose()) }
}
