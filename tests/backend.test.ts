import { createHash } from 'node:crypto'
import Ajv from 'ajv'
import { expect, it, vi } from 'vitest'
import type { PluginBackendApi, PluginBackendOperationContext } from '@valley/plugin-sdk'
import type { FileBaseline } from '@valley/plugin-sdk/types'
import config from '../config.json'
import { FIELDS_LIMIT, NOTE_LIMIT, register } from '../src/backend'

const card = 'BEGIN:VCARD\r\nVERSION:4.0\r\nUID:test-person\r\nFN:River Moss\r\nN:Moss;River;;;\r\nX-CUSTOM:keep-me\r\nPHOTO:data:image/png;base64,AA==\r\nEND:VCARD\r\n'
function fixture() {
  const files = new Map([['People/River Moss.vcf', card]]), trash = new Map<string, { path: string; content: string }>()
  const registrations = new Map<string, Parameters<PluginBackendApi['rpc']['handleOperation']>[1]>()
  const controller = new AbortController()
  let dirty = false
  const observed = (content: string): FileBaseline => ({ mtimeMs: 1, size: Buffer.byteLength(content), hash: createHash('sha256').update(content).digest('hex') })
  const check = (path: string, expected: FileBaseline | null) => {
    controller.signal.throwIfAborted()
    if (dirty) throw new Error('Contact has unsaved editor changes')
    const content = files.get(path)
    return expected ? content !== undefined && observed(content).hash === expected.hash && observed(content).size === expected.size : content === undefined
  }
  const api = {
    settings: { get: () => ({ contactsRoot: 'People' }) },
    vault: {
      read: vi.fn(async (path: string) => { controller.signal.throwIfAborted(); const content = files.get(path); return { content: content ?? '', baseline: content === undefined ? null : observed(content) } }),
      stat: vi.fn(async (path: string) => files.has(path) ? { relPath: path } : null),
      write: vi.fn(async (path: string, content: string, expected: FileBaseline | null) => { if (!check(path, expected)) return { ok: false, reason: 'conflict' }; files.set(path, content); return { ok: true, baseline: observed(content) } }),
      rename: vi.fn(async (path: string, target: string, expected: FileBaseline) => { if (!check(path, expected) || files.has(target)) return { ok: false, reason: 'conflict' }; const content = files.get(path)!; files.delete(path); files.set(target, content); return { ok: true, relPath: target, baseline: observed(content) } }),
      trash: vi.fn(async (path: string, expected: FileBaseline) => { if (!check(path, expected)) return { ok: false, reason: 'conflict' }; const token = crypto.randomUUID(); trash.set(token, { path, content: files.get(path)! }); files.delete(path); return { ok: true, destination: 'vault', token } }),
      restore: vi.fn(async (token: string) => { const item = trash.get(token); if (!item || !check(item.path, null)) return { ok: false }; files.set(item.path, item.content); trash.delete(token); return { ok: true, restoredPath: item.path } })
    },
    index: { observe: vi.fn(async () => ({ read: async ({ offset, limit }: { offset: number; limit: number }) => { const entries = [...files.keys()].filter(path => path.startsWith('People/') && path.endsWith('.vcf')); return { status: 'ready', entries: entries.slice(offset, offset + limit).map(relPath => ({ relPath })), next: entries.length > offset + limit ? offset + limit : null } }, dispose: vi.fn() })) },
    rpc: { handle: () => () => {}, handleOperation: (name: string, handler: Parameters<PluginBackendApi['rpc']['handleOperation']>[1]) => { registrations.set(name, handler); return () => registrations.delete(name) } }
  }
  register(api as unknown as PluginBackendApi)
  const context = { api, cancellation: { throwIfAborted: () => controller.signal.throwIfAborted(), get aborted() { return controller.signal.aborted }, onCancel: () => () => {} } } as unknown as PluginBackendOperationContext
  const call = async (name: string, input: unknown): Promise<any> => {
    const descriptor = config.runtime.services.find(service => service.metadata?.command?.id === name)!.metadata!.command!
    const ajv = new Ajv({ strictSchema: true, strictTypes: false, ownProperties: true })
    const validateInput = ajv.compile(descriptor.inputSchema), validateOutput = ajv.compile(descriptor.outputSchema)
    expect(validateInput(input), JSON.stringify(validateInput.errors)).toBe(true)
    const result = await registrations.get(`command.${name}`)!(input, context)
    expect(validateOutput(result), JSON.stringify(validateOutput.errors)).toBe(true)
    return result
  }
  return { files, api, controller, call, setDirty: () => { dirty = true } }
}

it('registers concrete input and output contracts for every supported data operation', () => {
  const descriptors = config.runtime.services.flatMap(service => service.metadata?.command ? [service.metadata.command] : [])
  expect(descriptors).toHaveLength(7)
  for (const descriptor of descriptors) {
    expect(descriptor.inputSchema.type).toBe('object')
    expect(descriptor.outputSchema.type).toBe('object')
    expect(Object.keys(descriptor.outputSchema.properties).length).toBeGreaterThan(0)
  }
})

it('keeps an empty folder in backend reads and creates cards at the vault root', async () => {
  const f = fixture()
  vi.spyOn(f.api.settings, 'get').mockReturnValue({ contactsRoot: '' })
  await f.call('contacts.list', { limit: 1 })
  expect(f.api.index.observe).toHaveBeenCalledWith({ extensions: ['.vcf'], fields: [] }, expect.any(Function))
  const created = await f.call('contacts.create', { fields: { firstName: 'Fern' } })
  expect(created.contact.relPath).toBe('Fern.vcf')
})

it('reads paginated summaries and creates, updates, renames, deletes and restores exact vCards', async () => {
  const f = fixture(), listed = await f.call('contacts.list', { limit: 1 })
  expect(listed.contacts[0].displayName).toBe('River Moss')
  expect(listed.contacts[0]).not.toHaveProperty('photo')
  const before = await f.call('contacts.read', { path: 'People/River Moss.vcf' })
  const updated = await f.call('contacts.update', { path: before.contact.relPath, expected: before.baseline, patch: { note: 'Reviewed' } })
  expect(f.files.get(updated.contact.relPath)).toContain('X-CUSTOM:keep-me')
  expect(f.files.get(updated.contact.relPath)).toContain('PHOTO:data:image/png;base64,AA==')
  const renamed = await f.call('contacts.rename', { path: updated.contact.relPath, expected: updated.baseline, fileName: 'River' })
  expect(renamed.contact.relPath).toBe('People/River.vcf')
  const removed = await f.call('contacts.delete', { path: renamed.contact.relPath, expected: renamed.baseline })
  expect(f.files.has(renamed.contact.relPath)).toBe(false)
  expect((await f.call('contacts.restore', { token: removed.token })).restoredPath).toBe(renamed.contact.relPath)
  const created = await f.call('contacts.create', { fields: { firstName: 'River' } })
  expect(created.contact.relPath).toBe('People/River 2.vcf')
})

it('allows only one of ten updates against the same baseline', async () => {
  const f = fixture(), before = await f.call('contacts.read', { path: 'People/River Moss.vcf' })
  const writes = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => f.call('contacts.update', { path: before.contact.relPath, expected: before.baseline, patch: { note: `Writer ${index}` } })))
  expect(writes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(writes.filter(result => result.status === 'rejected')).toHaveLength(9)
})

it('rejects external edits, unsaved editor conflicts, and cancellation without writing', async () => {
  const f = fixture(), before = await f.call('contacts.read', { path: 'People/River Moss.vcf' })
  f.files.set(before.contact.relPath, card.replace('X-CUSTOM:keep-me', 'X-CUSTOM:external'))
  await expect(f.call('contacts.delete', { path: before.contact.relPath, expected: before.baseline })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  const current = await f.call('contacts.read', { path: before.contact.relPath })
  f.setDirty()
  await expect(f.call('contacts.update', { path: current.contact.relPath, expected: current.baseline, patch: { note: 'Unsafe' } })).rejects.toThrow('unsaved')
  f.controller.abort()
  await expect(f.call('contacts.create', { fields: { firstName: 'Cancelled' } })).rejects.toThrow()
  expect(f.files.size).toBe(1)
  expect(f.files.get(before.contact.relPath)).toContain('X-CUSTOM:external')
})

it('reports a failed rename as an error instead of a completed rename', async () => {
  const f = fixture(), before = await f.call('contacts.read', { path: 'People/River Moss.vcf' })
  f.api.vault.rename.mockResolvedValueOnce({ ok: false, reason: 'conflict' })
  await expect(f.call('contacts.rename', { path: before.contact.relPath, expected: before.baseline, fileName: 'Renamed' })).rejects.toMatchObject({ code: 'RENAME_CONFLICT', outcome: 'not-applied' })
  expect(f.files.has(before.contact.relPath)).toBe(true)
})

it('declares a NOTE limit the backend saves inside one guest turn and refuses oversized fields before writing', async () => {
  const notes = JSON.stringify(config).match(/"note":\{"type":"string","maxLength":\d+/g) ?? []
  expect(notes.length).toBeGreaterThan(0)
  for (const note of notes) expect(note.endsWith(`"maxLength":${NOTE_LIMIT}`)).toBe(true)
  const f = fixture(), before = await f.call('contacts.read', { path: 'People/River Moss.vcf' })
  const note = 'Moos wächst an der Nordseite. '.repeat(NOTE_LIMIT / 30 + 1).slice(0, NOTE_LIMIT - 1) + '.'
  const saved = await f.call('contacts.update', { path: before.contact.relPath, expected: before.baseline, patch: { note } })
  expect(saved.contact.note).toBe(note)
  const large = Array.from({ length: Math.ceil(FIELDS_LIMIT / 60000) + 1 }, (_, index) => `https://example.org/${index}/${'m'.repeat(60000)}`)
  const content = f.files.get(saved.contact.relPath)
  await expect(f.call('contacts.update', { path: saved.contact.relPath, expected: saved.baseline, patch: { websites: large } })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT', outcome: 'not-applied' })
  await expect(f.call('contacts.create', { fields: { firstName: 'Fern', websites: large } })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT', outcome: 'not-applied' })
  expect(f.files.get(saved.contact.relPath)).toBe(content)
  expect(f.files.size).toBe(1)
})
