import { createWorkflowAdapter } from './workflow'
import { z } from 'zod'
import type { PluginBackendApi, PluginBackendOperationContext } from '@valley/plugin-sdk'
import type { FileBaseline, TextDocumentRead } from '@valley/plugin-sdk/types'
import { deleteContact, readContactDocument, renameContactFile, saveContact, type ContactDocumentOwner } from '../contactDocuments'
import { emptyContact, parseContactFile } from '../schema'

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
  lastContact: text, profession: text, note: z.string().max(2 * 1024 * 1024)
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
  'contacts.delete': z.object({ ok: z.literal(true), destination: z.enum(['system', 'vault']), token: z.string().optional(), editorConflict: z.boolean(), recoverySaved: z.boolean() }).strict(),
  'contacts.rename': savedSchema,
  'contacts.restore': z.object({ ok: z.literal(true), restoredPath: z.string() }).strict()
}
function conflict(): never { throw Object.assign(new Error('Contact changed; read its current revision before editing'), { code: 'REVISION_CONFLICT', outcome: 'not-applied' }) }
function rootFor(api: PluginBackendOperationContext['api']): string {
  const value = api.settings.get().contactsRoot
  const root = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : ''
  return root === '.' || root === '/' ? '' : root
}
function documentOwner(context: PluginBackendOperationContext) {
  let committed = false
  const mutationResult = <T extends { ok: boolean }>(result: T): T => { if (result.ok) committed = true; return result }
  const receipts = new Map<string, { path: string; content: string; baseline: FileBaseline }>()
  const issue = (path: string, content: string, baseline: FileBaseline): TextDocumentRead => { const revisionToken = crypto.randomUUID(); receipts.set(revisionToken, { path, content, baseline }); return { content, revisionToken } }
  const take = (path: string, token: string) => { const value = receipts.get(token); if (!value || value.path !== path) conflict(); receipts.delete(token); return value }
  const assertCurrent = () => context.cancellation.throwIfAborted()
  const owner: ContactDocumentOwner = {
    root: () => rootFor(context.api), assertCurrent,
    vault: {
      stat: file => context.api.vault.stat(file),
      readTextDocument: async file => { assertCurrent(); const value = await context.api.vault.read(file); assertCurrent(); return value?.baseline ? issue(file, value.content, value.baseline) : null },
      createTextDocumentGuarded: async (file, content) => { assertCurrent(); const result = mutationResult(await context.api.vault.write(file, content, null)); return result.ok ? { ok: true, revisionToken: issue(file, content, result.baseline).revisionToken, editorConflict: false } : result },
      writeTextDocumentGuarded: async (file, content, token) => { const previous = take(file, token); assertCurrent(); const result = mutationResult(await context.api.vault.write(file, content, previous.baseline)); return result.ok ? { ok: true, revisionToken: issue(file, content, result.baseline).revisionToken, editorConflict: false } : result },
      renameTextDocumentGuarded: async (file, target, token) => { const previous = take(file, token); assertCurrent(); const result = await context.api.vault.rename(file, target, previous.baseline); if (!result.ok) throw Object.assign(new Error(`Contact rename failed: ${result.reason}`), { code: 'RENAME_CONFLICT', outcome: committed ? 'unknown' : 'not-applied' }); mutationResult(result); return result.ok ? { ok: true, relPath: result.relPath, revisionToken: result.baseline.hash === previous.baseline.hash ? issue(result.relPath, previous.content, result.baseline).revisionToken : null, editorConflict: result.baseline.hash !== previous.baseline.hash } : result },
      trashTextDocumentGuarded: async (file, token) => { const previous = take(file, token); assertCurrent(); const result = await context.api.vault.trash(file, previous.baseline); return result.ok ? { ...result, editorConflict: false, recoverySaved: true } : result }
    }
  }
  return { owner, baselineFor: (document: TextDocumentRead | null) => document ? receipts.get(document.revisionToken)?.baseline ?? null : null }
}
export function handlers(context: PluginBackendOperationContext) {
  const { owner, baselineFor } = documentOwner(context)
  const read = async (file: string, expected?: FileBaseline) => {
    const document = await readContactDocument(file, owner), observed = baselineFor(document)!
    if (expected && (expected.hash !== observed.hash || expected.size !== observed.size)) conflict()
    return { document, contact: parseContactFile(file, document.content), baseline: observed }
  }
  const saved = (result: Awaited<ReturnType<typeof saveContact>>, fallback: ReturnType<typeof emptyContact>) => {
    if (!result) conflict()
    return { contact: result.document ? parseContactFile(result.relPath, result.document.content) : { ...fallback, relPath: result.relPath }, baseline: baselineFor(result.document), editorConflict: result.editorConflict }
  }
  return {
    'contacts.list': async (raw: unknown) => {
      const input = inputSchemas['contacts.list'].parse(raw), root = rootFor(context.api)
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
    'contacts.read': async (raw: unknown) => { const input = inputSchemas['contacts.read'].parse(raw), value = await read(input.path); return { contact: value.contact, content: value.document.content, baseline: value.baseline } },
    'contacts.create': async (raw: unknown) => { const input = inputSchemas['contacts.create'].parse(raw), contact = { ...emptyContact(), ...input.fields }; return saved(await saveContact(contact, { fileName: input.fileName }, owner), contact) },
    'contacts.update': async (raw: unknown) => { const input = inputSchemas['contacts.update'].parse(raw), previous = await read(input.path, input.expected), contact = { ...previous.contact, ...input.patch }; return saved(await saveContact(contact, { previous: previous.contact, document: previous.document, fileName: input.fileName }, owner), contact) },
    'contacts.delete': async (raw: unknown) => { const input = inputSchemas['contacts.delete'].parse(raw), previous = await read(input.path, input.expected); return deleteContact(input.path, owner, previous.document) },
    'contacts.rename': async (raw: unknown) => {
      const input = inputSchemas['contacts.rename'].parse(raw), previous = await read(input.path, input.expected)
      const result = await renameContactFile(input.path, input.fileName, previous.document, owner)
      return { contact: result.document ? parseContactFile(result.relPath, result.document.content) : { ...previous.contact, relPath: result.relPath }, baseline: baselineFor(result.document), editorConflict: !result.document }
    },
    'contacts.restore': async (raw: unknown) => {
      const input = inputSchemas['contacts.restore'].parse(raw), result = await context.api.vault.restore(input.token)
      if (!result.ok || !result.restoredPath) throw Object.assign(new Error(result.message ?? 'Contact could not be restored'), { code: 'RESTORE_CONFLICT' })
      return { ok: true as const, restoredPath: result.restoredPath }
    }
  }
}
export function register(api: PluginBackendApi): () => void {
  const workflow = createWorkflowAdapter(api)
  const disposers = Object.keys(inputSchemas).map(method => workflow.operation(`command.${method}`, (input, context) => handlers(context)[method as keyof typeof inputSchemas](input)))
  return () => { workflow.dispose(); disposers.forEach(dispose => dispose()) }
}
