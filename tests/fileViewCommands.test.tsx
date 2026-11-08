import * as React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Ajv from 'ajv'
import type { MountedPluginView } from '@valley/plugin-sdk'
import type { CommandContext } from '@valley/plugin-sdk/commands'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { initRuntime } from '../src/runtime'
import { ContactFileView } from '../src/FileView'
import { disposeStore, getStore } from '../src/store'
import { registerContactFileCommands, type ContactCollection, type ContactFileAction } from '../src/fileViewCommands'
import { cardRealm, uidFor } from './cards'

const path = 'Plants/Fern.vcf', relatedPath = 'Plants/Moss.vcf'
const mountedView: MountedPluginView = { mountId: 'contact-main', generation: 1, area: 'main', paneId: 'pane', tabId: 'tab', filePath: path, pluginId: 'contacts' }
const target = { mountId: mountedView.mountId, generation: mountedView.generation }
type Observation = { revision: string; view: { mode: string }; form: Record<string, unknown> | null; reader: Record<string, unknown> | null }
const disposals: Array<() => void | Promise<void>> = []
afterEach(async () => { cleanup(); for (const dispose of disposals.splice(0).reverse()) await dispose(); await disposeStore(); vi.restoreAllMocks() })

function setup() {
  const mock = createMockValleyApi({ manifest: { id: 'contacts' }, groups: [{ id: 'friends', name: 'Friends', color: '#eab308' }, { id: 'work', name: 'Work', color: '#a855f7' }, { id: 'family', name: 'Family', color: '#16a34a' }], settings: { contactsRoot: 'Plants' },
    ...cardRealm({ [path]: { firstName: 'Fern', groups: ['Friends'], email: [{ value: 'fern@example.test' }], phone: [{ value: '+41 123' }], place: [{ value: 'Zurich' }], websites: ['https://example.com/fern'], socialMedia: [{ platform: 'github', handle: 'fern' }], relations: [{ to: uidFor(relatedPath), type: 'friend' }], birthdate: '--06-21', note: 'Original' }, [relatedPath]: { firstName: 'Moss' } }) })
  initRuntime(mock.api); disposals.push(registerContactFileCommands(mock.api))
  const command = (id: string) => mock.commands.find(command => command.id === id || command.id.endsWith(`:${id}`))!
  const ajv = new Ajv({ strict: true })
  const inspectionValidator = ajv.compile(command('file-view-inspect').outputSchema!)
  const inspect = async (exact = target): Promise<Observation> => {
    const definition = command('file-view-inspect'), value = await definition.run(definition.input!.parse({ target: exact }), { caller: 'agent' })
    expect(inspectionValidator(value), JSON.stringify(inspectionValidator.errors)).toBe(true)
    return value as Observation
  }
  const invoke = async (action: ContactFileAction, route = 'control', context: Partial<CommandContext> = {}, exact = target, expectedRevision?: string) => {
    const observation = await inspect(exact), definition = command(`file-view-${route}`)
    let result: unknown, failure: unknown
    await act(async () => { try { result = await definition.run(definition.input!.parse({ target: exact, expectedRevision: expectedRevision ?? observation.revision, action }), { caller: 'agent', validateBeforeRun: async () => true, ...context }) } catch (cause) { failure = cause } })
    if (failure) throw failure
    return result
  }
  const ready = async () => { await act(async () => getStore(mock.api).ready()); await screen.findByText('Original'); await waitFor(async () => expect((await inspect()).reader?.documentRevision).toBeTypeOf('string')) }
  const editing = async () => { await invoke({ type: 'mode', value: 'editing' }); await waitFor(async () => expect((await inspect()).form?.ready).toBe(true)) }
  // Main refuses RESOURCE_TARGET_CHANGED unless every validateBeforeRun target set equals the command's declared fileTargets.
  const invokeDeclared = async (action: ContactFileAction, route = 'execute') => {
    const definition = command(`file-view-${route}`), calls: unknown[] = []
    const declared = await definition.fileTargets!(definition.input!.parse({ target, expectedRevision: (await inspect()).revision, action }))
    await invoke(action, route, { validateBeforeRun: async targets => { calls.push(targets); return true } })
    expect(calls.length, action.type).toBeGreaterThan(0)
    for (const validated of calls) expect(validated, action.type).toEqual(declared)
    return declared
  }
  return { mock, command, inspect, invoke, invokeDeclared, ready, editing }
}

describe('exact mounted Contact file actions', () => {
  it('changes all scalar/raw row fields, group/social order, platform choice and flushes through the exact native owner', async () => {
    const fixture = setup(), rendered = render(<ContactFileView relPath={path} mountedView={mountedView} />)
    await fixture.ready(); await fixture.editing()
    await fixture.invoke({ type: 'patch', fields: { firstName: 'Bäume', middleName: 'Canopy', lastName: 'Forest', nickname: 'Birch', birthdate: '2000-06-21', profession: 'Botanist', cover: 'assets/cover.png', fileName: 'Fern', note: 'Raw **Markdown**' } })
    expect(rendered.container.querySelector('textarea.ct-notes-editor')).toHaveValue('Raw **Markdown**')
    expect((await fixture.inspect()).form).toMatchObject({ firstName: 'Bäume', middleName: 'Canopy', lastName: 'Forest', nickname: 'Birch', birthdate: '2000-06-21', profession: 'Botanist', cover: 'assets/cover.png', fileName: 'Fern', note: 'Raw **Markdown**' })
    const fields: Record<ContactCollection, Record<string, string>> = { phone: { value: '+41 456', type: 'work' }, email: { value: 'birch@example.test', type: 'work' }, place: { value: 'Basel', type: 'home' }, organization: { name: 'Valley', title: 'Engineer', dept: 'Forest' }, social: { platform: 'github', handle: 'birch' }, website: { value: 'https://example.com/birch' }, relation: { toName: 'Moss', type: 'work', role: 'colleague' } }
    for (const collection of Object.keys(fields) as ContactCollection[]) {
      await fixture.invoke({ type: 'row-add', collection })
      const key = collection === 'website' ? 'websites' : collection === 'relation' ? 'relations' : collection
      const rows = (await fixture.inspect()).form![key] as unknown[]
      await fixture.invoke({ type: 'row-edit', collection, index: rows.length - 1, fields: fields[collection] })
      const current = (await fixture.inspect()).form![key] as unknown[]
      expect(current.at(-1)).toEqual(collection === 'social' ? expect.objectContaining({ value: fields[collection] }) : collection === 'website' ? fields[collection].value : expect.objectContaining(fields[collection]))
      await fixture.invoke({ type: 'row-remove', collection, index: rows.length - 1 }); expect(((await fixture.inspect()).form![key] as unknown[])).toHaveLength(rows.length - 1)
    }
    await fixture.invoke({ type: 'group-add', value: 'Work' }); await fixture.invoke({ type: 'group-add', value: 'Family' }); await fixture.invoke({ type: 'group-move', from: 2, to: 0 }); expect((await fixture.inspect()).form?.groups).toEqual(['Family', 'Friends', 'Work'])
    await fixture.invoke({ type: 'group-remove', value: 'Work' }); expect((await fixture.inspect()).form?.groups).toEqual(['Family', 'Friends'])
    await fixture.invoke({ type: 'row-add', collection: 'social' }); await fixture.invoke({ type: 'social-platform', index: 1, value: 'Instagram' }); await fixture.invoke({ type: 'row-edit', collection: 'social', index: 1, fields: { handle: 'canopy' } }); await fixture.invoke({ type: 'social-move', from: 1, to: 0 })
    expect(((await fixture.inspect()).form?.social as { value: { platform: string } }[])[0].value.platform).toBe('Instagram')
    await fixture.invoke({ type: 'flush' }, 'save')
    expect(fixture.mock.api.realm.editors.save).toHaveBeenCalledWith(mountedView, expect.stringContaining('NOTE:Raw **Markdown**'), expect.any(Object), expect.any(String))
    const saved = await fixture.mock.api.realm.readFile(path)
    expect(saved).toContain('Bäume'); expect(saved).toContain('CATEGORIES:Family,Friends'); expect(saved).toContain('SOCIALPROFILE'); expect((await fixture.inspect()).form?.dirty).toBe(false)
    await fixture.invoke({ type: 'mode', value: 'reading' }); expect(rendered.container.querySelector('.ct-form')).not.toBeVisible()
  })

  it('saves reading group chips and executes the existing exact related, phone, email, web, social, address and settings actions', async () => {
    const fixture = setup(); render(<ContactFileView relPath={path} mountedView={mountedView} />); await fixture.ready()
    await fixture.invoke({ type: 'reading-group-add', value: 'Work' }, 'save', { validateBeforeRun: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return true } }); expect(await fixture.mock.api.realm.readFile(path)).toContain('CATEGORIES:Friends,Work')
    await fixture.invoke({ type: 'reading-group-remove', value: 'Work' }, 'save'); expect((await fixture.inspect()).reader?.groups).toEqual(['Friends'])
    const links = vi.spyOn(fixture.mock.api.links, 'open'), settings = vi.spyOn(fixture.mock.api.workspace, 'openSettings'), open = vi.spyOn(fixture.mock.api.workspace, 'openMainTab')
    const values = { phone: { category: 'phone', value: '+41 123' }, email: { category: 'email', value: 'fern@example.test' }, website: 'https://example.com/fern', social: 'https://github.com/fern', address: { category: 'location', value: 'Zurich' } }
    const own = { kind: 'file', path, fileOperation: 'read' }
    for (const [kind, value] of Object.entries(values)) { expect(await fixture.invokeDeclared({ type: 'link-open', kind: kind as 'phone', index: 0 })).toEqual([own]); expect(links).toHaveBeenLastCalledWith(value) }
    expect(await fixture.invokeDeclared({ type: 'link-open', kind: 'relation', index: 0 })).toEqual(expect.arrayContaining([own, { kind: 'file', path: relatedPath, fileOperation: 'read' }])); expect(getStore(fixture.mock.api).getSnapshot().selectedPath).toBe(relatedPath); expect(open).toHaveBeenCalledWith({ newTab: undefined })
    expect(await fixture.invokeDeclared({ type: 'settings' })).toEqual([own]); expect(settings).toHaveBeenCalledWith('groups')
  })

  it('opens clicked reading phone and email links as typed host links, not raw tel:/mailto: URLs', async () => {
    const fixture = setup(); render(<ContactFileView relPath={path} mountedView={mountedView} />); await fixture.ready()
    const links = vi.spyOn(fixture.mock.api.links, 'open')
    const phone = screen.getByText('+41 123'), email = screen.getByText('fern@example.test')
    expect(phone.closest('a')?.getAttribute('href')).toBe('tel:+41 123'); expect(email.closest('a')?.getAttribute('href')).toBe('mailto:fern@example.test')
    fireEvent.click(phone); expect(links).toHaveBeenLastCalledWith({ category: 'phone', value: '+41 123' })
    fireEvent.click(email); expect(links).toHaveBeenLastCalledWith({ category: 'email', value: 'fern@example.test' })
    expect(links).toHaveBeenCalledTimes(2)
  })

  it('reports a confirmed web/social link-open as applied when its own opened view replaces the Contacts file view', async () => {
    for (const kind of ['website', 'social'] as const) {
      const fixture = setup(), rendered = render(<ContactFileView relPath={path} mountedView={mountedView} />); await fixture.ready()
      vi.mocked(fixture.mock.api.links.open).mockImplementationOnce(async () => { rendered.unmount(); return { status: 'opened' } })
      await expect(fixture.invoke({ type: 'link-open', kind, index: 0 }, 'execute')).resolves.toMatchObject({ status: 'queued', action: 'link-open', target })
      expect(fixture.mock.api.links.open).toHaveBeenCalledTimes(1)
      cleanup(); for (const dispose of disposals.splice(0).reverse()) await dispose(); await disposeStore()
    }
    for (const status of ['cancelled', 'failed'] as const) {
      const fixture = setup(), rendered = render(<ContactFileView relPath={path} mountedView={mountedView} />); await fixture.ready()
      vi.mocked(fixture.mock.api.links.open).mockImplementationOnce(async () => { rendered.unmount(); return { status } })
      await expect(fixture.invoke({ type: 'link-open', kind: 'website', index: 0 }, 'execute')).rejects.toMatchObject({ code: 'EFFECT_UNVERIFIED', outcome: 'unknown', retryable: false })
      cleanup(); for (const dispose of disposals.splice(0).reverse()) await dispose(); await disposeStore()
    }
    const fixture = setup(), rendered = render(<ContactFileView relPath={path} mountedView={mountedView} />); await fixture.ready()
    vi.mocked(fixture.mock.api.links.open).mockImplementationOnce(async () => { rendered.unmount(); throw new Error('Lost link acknowledgement') })
    await expect(fixture.invoke({ type: 'link-open', kind: 'social', index: 0 }, 'execute')).rejects.toMatchObject({ code: 'EFFECT_UNVERIFIED', outcome: 'unknown', retryable: false })
    const remounted = render(<ContactFileView relPath={path} mountedView={mountedView} />); await screen.findByText('Original')
    vi.spyOn(fixture.mock.api.workspace, 'openSettings').mockImplementationOnce(async () => { remounted.unmount() })
    await expect(fixture.invoke({ type: 'settings' }, 'execute')).rejects.toMatchObject({ code: 'EFFECT_UNVERIFIED', outcome: 'unknown' })
  })

  it('fences the retained shared raw draft to its exact owner and refuses stale, denied, replaced and unacknowledged effects', async () => {
    const fixture = setup(), other = { ...mountedView, mountId: 'contact-other', paneId: 'other', tabId: 'other' }
    const rendered = render(<><ContactFileView relPath={path} mountedView={mountedView} /><ContactFileView relPath={path} mountedView={other} /></>)
    await act(async () => getStore(fixture.mock.api).ready()); await screen.findAllByText('Original'); await waitFor(async () => expect((await fixture.inspect()).reader?.documentRevision).toBeTypeOf('string'))
    await expect(fixture.invoke({ type: 'mode', value: 'editing' }, 'control', { validateBeforeRun: async () => false })).rejects.toMatchObject({ code: 'PERMISSION_DENIED', outcome: 'not-applied' })
    await fixture.editing(); const old = await fixture.inspect()
    await fixture.invoke({ type: 'patch', fields: { note: 'Retained exact owner draft' } }); expect(rendered.container.querySelectorAll('textarea.ct-notes-editor')[1]).toHaveValue('Retained exact owner draft')
    await expect(fixture.invoke({ type: 'patch', fields: { note: 'Alias overwrite' } }, 'control', {}, { mountId: other.mountId, generation: 1 })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE', outcome: 'not-applied' })
    await expect(fixture.invoke({ type: 'flush' }, 'save', {}, target, old.revision)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    vi.mocked(fixture.mock.api.realm.editors.save).mockRejectedValueOnce(new Error('Lost save acknowledgement'))
    await expect(fixture.invoke({ type: 'flush' }, 'save')).rejects.toMatchObject({ outcome: 'unknown', code: 'EFFECT_UNVERIFIED', retryable: false })
    expect((await fixture.inspect()).form).toMatchObject({ note: 'Retained exact owner draft', dirty: true, error: 'Lost save acknowledgement' })
    await fixture.invoke({ type: 'reload' }); await waitFor(async () => expect((await fixture.inspect()).form).toMatchObject({ note: 'Original', dirty: false, error: '', ready: true }))
    const before = await fixture.mock.api.realm.readFile(path)
    let resume!: (value: boolean) => void
    const pending = fixture.invoke({ type: 'patch', fields: { note: 'Late change' } }, 'control', { validateBeforeRun: () => new Promise(resolve => { resume = resolve }) })
    await waitFor(() => expect(resume).toBeTypeOf('function')); const refused = expect(pending).rejects.toMatchObject({ code: 'TARGET_REPLACED', outcome: 'not-applied' }); rendered.unmount(); await act(async () => resume(true)); await refused
    expect(await fixture.mock.api.realm.readFile(path)).toBe(before)
  })

  it('rejects unsupported schemas/routes/identities and malformed raw rows before dispatch', () => {
    const fixture = setup(), ajv = new Ajv({ strict: true })
    for (const command of fixture.mock.commands) { expect(() => ajv.compile(command.input!.schema!)).not.toThrow(); expect(() => ajv.compile(command.outputSchema!)).not.toThrow() }
    const control = fixture.command('file-view-control')
    for (const action of [{ type: 'patch', fields: { unknown: 'value' } }, { type: 'patch', fields: {} }, { type: 'row-edit', collection: 'phone', index: 0, fields: { url: 'bad' } }, { type: 'row-edit', collection: 'relation', index: 0, fields: { type: 'invalid' } }, { type: 'row-remove', collection: 'social', index: -1 }, { type: 'flush' }, { type: 'mode', value: 'editing', extra: true }]) expect(() => control.input!.parse({ target, expectedRevision: 'r', action })).toThrow()
    expect(() => control.input!.parse({ target: { ...target, path }, expectedRevision: 'r', action: { type: 'mode', value: 'editing' } })).toThrow()
    expect(fixture.command('file-view-save')).toMatchObject({ sideEffect: 'write', recovery: 'non-replayable', idempotent: false }); expect(fixture.command('file-view-execute')).toMatchObject({ sideEffect: 'execute', recovery: 'non-replayable', idempotent: false })
  })

  it('keeps an applied save unknown when the later filename destination is denied', async () => {
    const fixture = setup(); render(<ContactFileView relPath={path} mountedView={mountedView} />); await fixture.ready(); await fixture.editing()
    await fixture.invoke({ type: 'patch', fields: { note: 'Committed before rename', fileName: 'Renamed Fern' } })
    const validateBeforeRun = vi.fn(async (targets?: { path: string }[]) => { await new Promise(resolve => setTimeout(resolve, 5)); return !targets?.some(target => target.path === 'Plants/Renamed Fern.vcf') })
    await expect(fixture.invoke({ type: 'flush' }, 'save', { validateBeforeRun })).rejects.toMatchObject({ outcome: 'unknown', code: 'EFFECT_UNVERIFIED', retryable: false })
    expect(await fixture.mock.api.realm.readFile(path)).toContain('NOTE:Committed before rename')
    expect(await fixture.mock.api.realm.stat('Plants/Renamed Fern.vcf')).toBeNull()
    expect(validateBeforeRun).toHaveBeenCalledWith([{ kind: 'file', path, fileOperation: 'write' }, { kind: 'file', path: 'Plants/Renamed Fern.vcf', fileOperation: 'write' }])
    expect((await fixture.inspect()).form).toMatchObject({ note: 'Committed before rename', fileName: 'Renamed Fern' })
  })
})
