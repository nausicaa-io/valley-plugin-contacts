import { afterEach, expect, it, vi } from 'vitest'
import * as React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { CONTACTS_DIRECTORY_V1, PLUGIN_SURFACE_V1, type PluginIndexPage } from '@valley/plugin-sdk'
import type { IndexEntry } from '@valley/plugin-sdk/types'
import { IMAGE_EXTENSIONS } from '@valley/plugin-sdk/fileTypes'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { getContactIndex } from '../src/indexOwner'
import { initRuntime } from '../src/runtime'
import { disposeStore, getStore } from '../src/store'
import { registerContactsCommands } from '../src/commands'
import { registerDirectory } from '../src/directory'
import { registerContactSurfaces } from '../src/surfaces'
import { DetailView } from '../src/DetailView'
import { loadContacts } from '../src/store'
import { cardAt, fileEntry } from './cards'

const FILES: Record<string, string> = {}
const contact = (name: string, cover = '', note = 'Body'): IndexEntry => {
  const relPath = `Meadow/Orbit/${name}.vcf`
  FILES[relPath] = cardAt(relPath, { firstName: name, cover, note })
  return fileEntry(relPath, FILES[relPath])
}
const asset = (relPath: string): IndexEntry => ({ relPath, title: relPath, kind: 'asset' as const, mtimeMs: 1 })
const cleanups: (() => unknown)[] = []
const releases: (() => void)[] = []
afterEach(async () => { for (const release of releases.splice(0)) release(); for (const dispose of cleanups.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })

function setup(entries: IndexEntry[], selectedPath: string | null = null) {
  const mock = createMockValleyApi({ manifest: { id: 'contacts', indexState: 'scoped' }, indexEntries: entries, settings: { contactsRoot: 'Meadow/Orbit', lastOpen: { selectedPath, mode: 'detail' } }, files: { ...FILES } })
  initRuntime(mock.api)
  return mock
}

it('renders the card notes through the shared Markdown view with the card as link source', async () => {
  const mock = setup([contact('Fern', '', 'See [[Named target]]'), asset('Images/Fern.png')])
  const store = getStore(mock.api)
  cleanups.push(() => store.dispose())
  await store.ready()
  const MarkdownView = vi.fn((props: { value: string; context: { sourcePath?: string } }) => React.createElement('div', { 'data-source': props.context.sourcePath }, props.value))
  mock.api.ui.MarkdownView = MarkdownView as unknown as typeof mock.api.ui.MarkdownView
  const mounted = render(React.createElement(DetailView, { contact: loadContacts(mock.api)[0] }))
  cleanups.push(mounted.unmount)
  const notes = await screen.findByText('See [[Named target]]')
  expect(notes.getAttribute('data-source')).toBe('Meadow/Orbit/Fern.vcf')
  expect(mock.api.getState().indexEntries).toEqual([])
})

function holdRead(mock: ReturnType<typeof setup>, offset = 0) {
  const observe = mock.api.index.observe
  let captured: PluginIndexPage | undefined
  let release!: (page: PluginIndexPage) => void
  const gate = new Promise<PluginIndexPage>(resolve => { release = resolve })
  const closed = vi.fn()
  releases.push(() => release(captured!))
  vi.spyOn(mock.api.index, 'observe').mockImplementation(async (scope, listener) => {
    const observation = await observe(scope, listener)
    return { read: async request => {
      const page = await observation.read(request)
      if (request?.offset === offset && !captured) { captured = page; return gate }
      return page
    }, dispose: async () => { closed(); await observation.dispose() } }
  })
  return { captured: () => captured, release: () => release(captured!), closed }
}

it('publishes complete contact and cover hydration before commands, directory and bookmark decisions', async () => {
  const fern = contact('Fern', 'cover.png')
  const mock = setup([...Array.from({ length: 128 }, (_, i) => asset(`Other/${i}.png`)), fern, asset('Images/cover.png')], fern.relPath)
  const held = holdRead(mock, 128)
  const store = getStore(mock.api)
  cleanups.push(() => store.dispose(), registerContactsCommands(mock.api), registerDirectory(mock.api), registerContactSurfaces(mock.api))
  await vi.waitFor(() => expect(held.captured()).toBeDefined())
  const before = store.getSnapshot()
  const listener = vi.fn()
  store.subscribe(listener)
  const command = mock.api.commands.execute('contacts:get', { name: 'Fern' })
  const service = mock.api.interop.services.providers(CONTACTS_DIRECTORY_V1)[0].invoke('search', ['Fern', 10])
  const surface = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1)[0].extension
  const restore = surface.restore!({ v: 1, path: fern.relPath })
  const settled = vi.fn()
  void Promise.all([command, service, restore]).then(settled)
  await Promise.resolve()
  expect(settled).not.toHaveBeenCalled()
  expect(store.getSnapshot()).toBe(before)
  expect(before.selectedPath).toBe(fern.relPath)
  expect(mock.api.settings.get().lastOpen).toEqual({ selectedPath: fern.relPath, mode: 'detail' })
  expect(mock.api.getState().indexEntries).toEqual([])
  expect(listener).not.toHaveBeenCalled()
  held.release()
  await expect(command).resolves.toMatchObject({ ok: true, value: { firstName: 'Fern' } })
  await expect(service).resolves.toMatchObject({ ok: true, value: [{ displayName: 'Fern' }] })
  await restore
  expect(store.getSnapshot().coverPaths[fern.relPath]).toBe('Images/cover.png')
  expect(mock.api.index.observe).toHaveBeenCalledOnce()
  expect(mock.api.index.observe).toHaveBeenCalledWith({ extensions: ['.vcf', ...IMAGE_EXTENSIONS].sort(), fields: ['mtimeMs', 'size'] }, expect.any(Function))
  expect(getContactIndex(mock.api).read().find(entry => entry.relPath === fern.relPath)).toEqual({ relPath: fern.relPath, mtimeMs: 1, size: FILES[fern.relPath].length })
})

it('resynchronizes a dropped revision without publishing partial membership', async () => {
  const moss = contact('Moss', 'cover.png')
  const mock = setup([contact('Fern', 'cover.png')])
  const observe = mock.api.index.observe
  let drop = true
  vi.spyOn(mock.api.index, 'observe').mockImplementation((scope, listener) => observe(scope, change => { if (drop) { drop = false; return }; listener(change) }))
  const store = getStore(mock.api)
  cleanups.push(() => store.dispose())
  await store.ready()
  const before = store.getSnapshot()
  const listener = vi.fn()
  store.subscribe(listener)
  mock.emitState({ indexEntries: [moss] })
  expect(store.getSnapshot()).toBe(before)
  mock.emitState({ indexEntries: [moss, asset('Images/cover.png')] })
  await vi.waitFor(() => expect(store.getSnapshot().coverPaths[moss.relPath]).toBe('Images/cover.png'))
  expect(store.getSnapshot().contacts.map(entry => entry.firstName)).toEqual(['Moss'])
  expect(listener).toHaveBeenCalledOnce()
  expect(mock.api.getState().indexEntries).toEqual([])
})

it('joins a held read when disposed and prevents late snapshots or readiness success', async () => {
  const mock = setup([contact('Fern')])
  const held = holdRead(mock)
  const store = getStore(mock.api)
  const ready = expect(store.ready()).rejects.toThrow('revoked')
  await vi.waitFor(() => expect(held.captured()).toBeDefined())
  const before = store.getSnapshot()
  const listener = vi.fn()
  store.subscribe(listener)
  const disposed = store.dispose()
  const settled = vi.fn()
  void disposed.then(settled)
  expect(store.dispose()).toBe(disposed)
  await ready
  expect(settled).not.toHaveBeenCalled()
  held.release()
  await disposed
  expect(held.closed).toHaveBeenCalledOnce()
  expect(store.getSnapshot()).toBe(before)
  expect(listener).not.toHaveBeenCalled()
  expect(() => store.openContact('Meadow/Orbit/Fern.vcf')).toThrow('revoked')
})

it('keeps stale cleanup isolated and joins predecessor reads when APIs share a runtime', async () => {
  const first = setup([contact('Fern')])
  const held = holdRead(first)
  const old = getStore(first.api)
  await vi.waitFor(() => expect(held.captured()).toBeDefined())
  const second = setup([contact('Moss')])
  second.api.runtime = first.api.runtime
  const next = getStore(second.api)
  await next.ready()
  await expect(old.ready()).rejects.toThrow('revoked')
  const oldDisposal = disposeStore(first.api, old)
  expect(getStore(second.api)).toBe(next)
  expect(next.getSnapshot().contacts[0].firstName).toBe('Moss')
  const closed = vi.fn()
  const nextDisposal = next.dispose().then(closed)
  await Promise.resolve()
  expect(closed).not.toHaveBeenCalled()
  held.release()
  await Promise.all([oldDisposal, nextDisposal])
  expect(closed).toHaveBeenCalledOnce()
})

it('clears stale persisted selection exactly once after an authoritative empty snapshot', async () => {
  const mock = setup([], 'Meadow/Orbit/Missing.vcf')
  const write = vi.spyOn(mock.api.settings, 'set')
  const held = holdRead(mock)
  const store = getStore(mock.api)
  cleanups.push(() => store.dispose())
  await vi.waitFor(() => expect(held.captured()).toBeDefined())
  expect(store.getSnapshot().selectedPath).toBe('Meadow/Orbit/Missing.vcf')
  expect(write).not.toHaveBeenCalled()
  held.release()
  await store.ready()
  expect(store.getSnapshot().selectedPath).toBeNull()
  expect(write).toHaveBeenCalledOnce()
  expect(write).toHaveBeenCalledWith('lastOpen', { selectedPath: null, mode: 'detail' })
})

it('keeps a held command write and undo attached to the API that accepted it', async () => {
  const first = setup([contact('Fern')])
  cleanups.push(registerContactsCommands(first.api), () => getContactIndex(first.api).dispose())
  await getStore(first.api).ready()
  const read = first.api.vault.readTextDocument
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  releases.push(release)
  const readSpy = vi.spyOn(first.api.vault, 'readTextDocument').mockImplementationOnce(async path => { const captured = await read(path); await blocked; return captured })
  const writing = first.api.commands.execute('contacts:edit-fields', { path: 'Meadow/Orbit/Fern.vcf', values: { nickname: 'Old owner' } })
  await vi.waitFor(() => expect(readSpy).toHaveBeenCalled())
  const second = setup([contact('Moss')])
  cleanups.push(registerContactsCommands(second.api), () => getContactIndex(second.api).dispose())
  await getStore(second.api).ready()
  release()
  await expect(writing).resolves.toMatchObject({ ok: true, value: { nickname: 'Old owner' } })
  expect(first.api.vault.writeTextDocumentGuarded).toHaveBeenCalledOnce()
  expect(second.driverCalls).toEqual([])
})
