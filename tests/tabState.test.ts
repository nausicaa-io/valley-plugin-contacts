import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { initRuntime } from '../src/runtime'
import { getStore, disposeStore } from '../src/store'
import { createContactProjection, getSettings } from '../src/data'
import { initLocalization } from '../src/localization'
import type { Contact } from '../src/types'
import { cardAt, cardVault, fileEntry } from './cards'

const FOX = { firstName: 'Fox', lastName: 'Woodland', groups: ['fungi'], note: 'Note' }
const OTTER = { firstName: 'Otter', lastName: 'Riverbank', groups: ['plants'], note: 'Note' }

function setup(extraSettings: Record<string, unknown> = {}): ReturnType<typeof createMockValleyApi> {
  return createMockValleyApi({
    manifest: { id: 'contacts' },
    settings: { contactsRoot: 'Meadow/Orbit', groups: [], ...extraSettings },
    ...cardVault({ 'Meadow/Orbit/Fox Woodland.vcf': FOX, 'Meadow/Orbit/Otter Riverbank.vcf': OTTER })
  })
}

/** Rewrite cards on disk and report them to the index with a newer mtime. */
async function rewrite(mock: ReturnType<typeof createMockValleyApi>, cards: Record<string, Partial<Contact>>, mtimeMs = Date.now()): Promise<void> {
  const changed = new Map<string, string>()
  for (const [relPath, fields] of Object.entries(cards)) {
    const content = cardAt(relPath, fields)
    await mock.api.vault.writeFile(relPath, content)
    changed.set(relPath, content)
  }
  const entries = mock.api.getState().indexEntries.map((entry) => changed.has(entry.relPath) ? fileEntry(entry.relPath, changed.get(entry.relPath)!, mtimeMs) : entry)
  for (const [relPath, content] of changed) if (!entries.some((entry) => entry.relPath === relPath)) entries.push(fileEntry(relPath, content, mtimeMs))
  mock.emitState({ indexEntries: entries })
}

afterEach(async () => {
  await disposeStore()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('contact projection subscriptions', () => {
  it('retains the contact projection for unrelated host state and navigation settings', async () => {
    vi.useFakeTimers()
    const mock = setup()
    initRuntime(mock.api)
    const store = getStore(mock.api)
    await store.ready()
    const initial = store.getSnapshot()
    const listener = vi.fn()
    store.subscribe(listener)
    mock.emitState({ activePath: 'Garden/Journal.md', canGoBack: true, timeFormat: '12h' })
    await mock.api.settings.set('lastOpen', { selectedPath: null, mode: 'graph' })
    await vi.runAllTimersAsync()
    expect(store.getSnapshot()).toBe(initial)
    expect(listener).not.toHaveBeenCalled()
  })

  it('updates changed contacts and groups', async () => {
    const mock = setup({ contactsRoot: '/' })
    initRuntime(mock.api)
    const store = getStore(mock.api)
    await store.ready()
    await rewrite(mock, { 'Meadow/Orbit/Fox Woodland.vcf': { ...FOX, firstName: 'Updated' }, 'Meadow/Orbit/Otter Riverbank.vcf': { ...OTTER, firstName: 'Updated' } })
    await vi.waitFor(() => expect(store.getSnapshot().contacts.every((contact) => contact.firstName === 'Updated')).toBe(true))
    mock.emitState({ groups: [{ id: 'group_fungi', name: 'Fungi', color: '#123456' }] })
    expect(store.getSnapshot().groupConfigs).toEqual([{ id: 'group_fungi', name: 'Fungi', color: '#123456' }])
  })

  it('coalesces contact settings changes and cancels pending work at disposal', async () => {
    vi.useFakeTimers()
    const mock = setup()
    initRuntime(mock.api)
    const store = getStore(mock.api)
    await store.ready()
    const listener = vi.fn()
    store.subscribe(listener)
    await mock.api.settings.set('contactsRoot', 'Garden')
    await mock.api.settings.set('contactsRoot', '/')
    await vi.advanceTimersByTimeAsync(30)
    expect(listener).toHaveBeenCalledTimes(1)
    const last = store.getSnapshot()
    await mock.api.settings.set('contactsRoot', 'Garden')
    store.dispose()
    await vi.runAllTimersAsync()
    expect(store.getSnapshot()).toBe(last)
  })
})

describe('store tab title sync', () => {
  it('sets the main tab title to the open contact name', async () => {
    const mock = setup()
    initRuntime(mock.api)
    const store = getStore(mock.api)
    await store.ready()
    store.openContact('Meadow/Orbit/Fox Woodland.vcf')
    expect(mock.api.workspace.setMainTabTitle).toHaveBeenLastCalledWith('Fox Woodland')
  })

  it('clears the title when leaving detail mode (graph/create)', async () => {
    const mock = setup()
    initRuntime(mock.api)
    const store = getStore(mock.api)
    await store.ready()
    store.openContact('Meadow/Orbit/Fox Woodland.vcf')
    expect(mock.api.workspace.setMainTabTitle).toHaveBeenLastCalledWith('Fox Woodland')

    store.showGraph()
    expect(mock.api.workspace.setMainTabTitle).toHaveBeenLastCalledWith(null)

    store.openContact('Meadow/Orbit/Fox Woodland.vcf')
    store.startCreate()
    expect(mock.api.workspace.setMainTabTitle).toHaveBeenLastCalledWith(null)
  })

})

describe('store cross-reload persistence', () => {
  it('persists the open contact across a dispose + fresh getStore (reload simulation)', async () => {
    const mock = setup()
    initRuntime(mock.api)
    const store = getStore(mock.api)
    await store.ready()
    store.openContact('Meadow/Orbit/Otter Riverbank.vcf')
    expect(mock.api.settings.get().lastOpen).toEqual({ selectedPath: 'Meadow/Orbit/Otter Riverbank.vcf', mode: 'detail' })

    disposeStore()
    const reopened = getStore(mock.api)

    await reopened.ready()
    expect(reopened.getSnapshot().selectedPath).toBe('Meadow/Orbit/Otter Riverbank.vcf')
    expect(reopened.getSnapshot().mode).toBe('detail')
  })

  it('persists graph mode across reload', async () => {
    const mock = setup()
    initRuntime(mock.api)
    const store = getStore(mock.api)
    await store.ready()
    store.showGraph()
    expect(mock.api.settings.get().lastOpen).toEqual({ selectedPath: null, mode: 'graph' })

    disposeStore()
    const reopened = getStore(mock.api)

    await reopened.ready()
    expect(reopened.getSnapshot().mode).toBe('graph')
  })

  it('does not persist transient create/edit modes', async () => {
    const mock = setup()
    initRuntime(mock.api)
    const store = getStore(mock.api)
    await store.ready()
    store.openContact('Meadow/Orbit/Otter Riverbank.vcf')
    const persistedAfterOpen = mock.api.settings.get().lastOpen

    store.startCreate()
    expect(mock.api.settings.get().lastOpen).toEqual(persistedAfterOpen)

    store.startEdit()
    expect(mock.api.settings.get().lastOpen).toEqual(persistedAfterOpen)
  })

  it('restores a previously-persisted contact on first load (fresh app start)', async () => {
    const mock = setup({ lastOpen: { selectedPath: 'Meadow/Orbit/Fox Woodland.vcf', mode: 'detail' } })
    initRuntime(mock.api)
    const store = getStore(mock.api)
    await store.ready()
    expect(store.getSnapshot().selectedPath).toBe('Meadow/Orbit/Fox Woodland.vcf')
    expect(store.getSnapshot().mode).toBe('detail')
    expect(mock.api.workspace.setMainTabTitle).toHaveBeenLastCalledWith('Fox Woodland')
  })

  it('falls back to no selection when the persisted contact no longer exists', async () => {
    const mock = setup({ lastOpen: { selectedPath: 'Meadow/Orbit/Ghost.vcf', mode: 'detail' } })
    initRuntime(mock.api)
    const store = getStore(mock.api)
    await store.ready()
    expect(store.getSnapshot().selectedPath).toBeNull()
  })
})

describe('store follows a renamed contact card', () => {
  const from = 'Meadow/Orbit/Fox Woodland.vcf'
  const to = 'Meadow/Orbit/Fox Mäander.vcf'

  it('keeps the open contact selected and serves it under the new path', async () => {
    const mock = setup()
    initRuntime(mock.api)
    const store = getStore(mock.api)
    await store.ready()
    store.openContact(from)

    // The index still lists the old path at this point (watcher round-trip).
    mock.emitFileRenamed(from, to)
    const snap = store.getSnapshot()
    expect(snap.selectedPath).toBe(to)
    const renamed = snap.contacts.find((c) => c.relPath === to)
    expect(renamed?.fileName).toBe('Fox Mäander')
    expect(renamed?.displayName).toBe('Fox Woodland')
    expect(snap.contacts.some((c) => c.relPath === from)).toBe(false)
    expect(mock.api.settings.get().lastOpen).toEqual({ selectedPath: to, mode: 'detail' })
  })

  it('remaps the history so Back still resolves', async () => {
    const mock = setup()
    initRuntime(mock.api)
    const store = getStore(mock.api)
    await store.ready()
    store.openContact('Meadow/Orbit/Otter Riverbank.vcf')
    store.openContact(from)
    mock.emitFileRenamed(from, to)

    store.goBack()
    expect(store.getSnapshot().selectedPath).toBe('Meadow/Orbit/Otter Riverbank.vcf')
    store.goForward()
    expect(store.getSnapshot().selectedPath).toBe(to)
  })

  it('ignores a rename of an unrelated file', async () => {
    const mock = setup()
    initRuntime(mock.api)
    const store = getStore(mock.api)
    await store.ready()
    store.openContact(from)
    mock.emitFileRenamed('Garden/Journal.md', 'Garden/Diary.md')
    expect(store.getSnapshot().selectedPath).toBe(from)
    expect(store.getSnapshot().contacts.map((c) => c.relPath)).toEqual([
      from,
      'Meadow/Orbit/Otter Riverbank.vcf'
    ])
  })
})

it('reads only the changed card while retaining unrelated projections and shared consumers', async () => {
  const cards = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`Meadow/Orbit/Contact ${index}.vcf`, { firstName: `Contact ${index}`, groups: ['plants'], email: [{ value: `contact-${index}@example.com` }] }]))
  const mock = createMockValleyApi({ manifest: { id: 'contacts' }, ...cardVault(cards) })
  initRuntime(mock.api)
  const read = vi.spyOn(mock.api.vault, 'readFile')
  const store = getStore(mock.api)
  await store.ready()
  expect(getStore(mock.api)).toBe(store)
  expect(read).toHaveBeenCalledTimes(500)
  const before = store.getSnapshot()
  const listener = vi.fn()
  store.subscribe(listener)
  mock.emitState({ indexEntries: [...mock.api.getState().indexEntries, fileEntry('Journal.md', '# Journal', 2)] })
  expect(read).toHaveBeenCalledTimes(500)
  expect(store.getSnapshot()).toBe(before)
  expect(listener).not.toHaveBeenCalled()
  const changed = 'Meadow/Orbit/Contact 123.vcf'
  await rewrite(mock, { [changed]: { ...cards[changed], email: [{ value: 'changed@example.com' }] } })
  await vi.waitFor(() => expect(store.getSnapshot()).not.toBe(before))
  const after = store.getSnapshot()
  expect(read).toHaveBeenCalledTimes(501)
  expect(after.contacts.find((contact) => contact.relPath === changed)?.email[0].value).toBe('changed@example.com')
  for (const contact of before.contacts) if (contact.relPath !== changed) expect(after.contacts.find((next) => next.relPath === contact.relPath)).toBe(contact)
  expect(after.groupTree).toBe(before.groupTree)
  expect(after.coverPaths).toBe(before.coverPaths)
  expect(listener).toHaveBeenCalledOnce()
  mock.emitState({ indexEntries: mock.api.getState().indexEntries.map((entry) => ({ ...entry, title: `${entry.title} (renamed title)` })) })
  expect(read).toHaveBeenCalledTimes(501)
  expect(store.getSnapshot()).toBe(after)
})

it('updates canonical groups and locale without rereading contacts or dropping filters', async () => {
  const mock = setup()
  let languageChanged!: () => void
  mock.api.ui.onLanguageChanged = (listener) => { languageChanged = listener; return () => {} }
  initRuntime(mock.api)
  initLocalization(mock.api)
  const read = vi.spyOn(mock.api.vault, 'readFile')
  const store = getStore(mock.api)
  await store.ready()
  const before = store.getSnapshot()
  mock.emitState({ groups: [{ id: 'fungi', name: 'Fungi', color: '#123456' }] })
  const grouped = store.getSnapshot()
  expect(read).toHaveBeenCalledTimes(2)
  expect(grouped.contacts[0].groups).toEqual(['Fungi'])
  expect(grouped.contacts[1]).toBe(before.contacts[1])
  store.setGroupFilter(['Fungi'], false)
  mock.emitState({ groups: [{ id: 'fungi', name: 'Fungi', color: '#654321' }] })
  const recolored = store.getSnapshot()
  expect(recolored.contacts).toBe(grouped.contacts)
  expect(recolored.groupTree).toBe(grouped.groupTree)
  expect(recolored.hiddenGroups).toEqual(['Fungi'])
  expect(recolored.groupConfigs[0].color).toBe('#654321')
  mock.api.ui.t = (key) => key === 'contacts.group.all' ? 'Alle' : key
  languageChanged()
  expect(store.getSnapshot().groupTree[0].label).toBe('Alle')
  expect(store.getSnapshot().contacts).toBe(grouped.contacts)
  expect(read).toHaveBeenCalledTimes(2)
})

it('preserves the first cover filename match when image order, names or membership change', async () => {
  const relPath = 'Meadow/Orbit/Fern.vcf'
  const vault = cardVault({ [relPath]: { firstName: 'Fern', cover: 'cover.png' } })
  const contact = vault.indexEntries[0]
  const image = (path: string) => ({ relPath: path, title: path, kind: 'asset' as const, mtimeMs: 0 })
  const first = image('Meadow/Cover.png')
  const second = image('Archive/COVER.PNG')
  const mock = createMockValleyApi({ manifest: { id: 'contacts' }, files: vault.files, indexEntries: [contact, first, second] })
  initRuntime(mock.api)
  const read = vi.spyOn(mock.api.vault, 'readFile')
  const projection = createContactProjection(mock.api, () => mock.api.getState().indexEntries)
  const getSnapshot = () => {
    const contacts = projection.contacts(getSettings(mock.api))
    return { contacts, coverPaths: projection.covers(contacts) }
  }
  getSnapshot()
  await vi.waitFor(() => expect(projection.settled()).toBe(true))
  const original = getSnapshot()
  expect(original.coverPaths[relPath]).toBe(first.relPath)
  mock.emitState({ indexEntries: [contact, { ...first, mtimeMs: 5 }, second, image('Other.png')] })
  expect(getSnapshot()).toEqual(original)
  mock.emitState({ indexEntries: [contact, second, first] })
  expect(getSnapshot().coverPaths[relPath]).toBe(second.relPath)
  expect(getSnapshot().contacts).toBe(original.contacts)
  mock.emitState({ indexEntries: [contact, first] })
  expect(getSnapshot().coverPaths[relPath]).toBe(first.relPath)
  mock.emitState({ indexEntries: [contact] })
  expect(getSnapshot().coverPaths[relPath]).toBeNull()
  expect(read).toHaveBeenCalledOnce()
})

it('rereads a card only when its size or modification time moves, and evicts removed cards', async () => {
  const mock = setup({ contactsRoot: '/' })
  initRuntime(mock.api)
  const read = vi.spyOn(mock.api.vault, 'readFile')
  const projection = createContactProjection(mock.api, () => mock.api.getState().indexEntries)
  const settings = getSettings(mock.api)
  const settle = async () => { projection.contacts(settings); await vi.waitFor(() => expect(projection.settled()).toBe(true)); return projection.contacts(settings) }
  const initial = await settle()
  expect(read).toHaveBeenCalledTimes(2)
  const entries = mock.api.getState().indexEntries
  mock.emitState({ indexEntries: entries.slice() })
  expect(await settle()).toBe(initial)
  expect(read).toHaveBeenCalledTimes(2)
  await rewrite(mock, { 'Meadow/Orbit/Fox Woodland.vcf': { ...FOX, firstName: 'Changed' } }, 50)
  const changed = await settle()
  expect(read).toHaveBeenCalledTimes(3)
  expect(changed.some((contact) => contact.firstName === 'Changed')).toBe(true)
  mock.emitState({ indexEntries: [mock.api.getState().indexEntries[1]] })
  expect(await settle()).toHaveLength(1)
  // A card that comes back is read again, from its current bytes.
  mock.emitState({ indexEntries: entries })
  expect((await settle()).find((contact) => contact.relPath === 'Meadow/Orbit/Fox Woodland.vcf')?.firstName).toBe('Changed')
  expect(read).toHaveBeenCalledTimes(4)
  projection.dispose()
})

it('retains pending rename overlays through unrelated revisions and reconciles the indexed destination', async () => {
  const mock = setup()
  initRuntime(mock.api)
  const store = getStore(mock.api)
  await store.ready()
  const before = store.getSnapshot()
  const from = before.contacts[0].relPath
  const to = 'Meadow/Orbit/Fern.vcf'
  store.openContact(from)
  await mock.api.vault.writeFile(to, await mock.api.vault.readFile(from))
  mock.emitFileRenamed(from, to)
  const pending = store.getSnapshot()
  mock.emitState({ indexEntries: mock.api.getState().indexEntries.slice() })
  expect(store.getSnapshot()).toBe(pending)
  expect(store.getSnapshot().selectedPath).toBe(to)
  expect(store.getSnapshot().contacts.find((contact) => contact.relPath === to)?.fileName).toBe('Fern')
  expect(store.getSnapshot().contacts[1]).toBe(before.contacts[1])
  mock.emitState({ indexEntries: mock.api.getState().indexEntries.map((entry) => entry.relPath === from ? { ...entry, relPath: to } : entry) })
  await vi.waitFor(() => expect(store.getSnapshot().contacts.some((contact) => contact.relPath === from)).toBe(false))
  expect(store.getSnapshot().selectedPath).toBe(to)
})

it('revokes the old index on A to B to A and keeps old-owner cleanup isolated', async () => {
  vi.useFakeTimers()
  const first = setup()
  initRuntime(first.api)
  const old = getStore(first.api)

  await old.ready()
  const original = old.getSnapshot().contacts[0]
  first.emitState({ vault: { path: '/managed/b', name: 'b', displayName: 'B' } })
  const middle = old.getSnapshot().contacts[0]
  expect(middle).toBe(original)
  await expect(old.ready()).rejects.toThrow('revoked')
  first.emitState({ vault: { path: '/managed/a', name: 'a', displayName: 'A' } })
  expect(old.getSnapshot().contacts[0]).toBe(middle)
  await expect(old.ready()).rejects.toThrow('revoked')
  await first.api.settings.set('contactsRoot', 'Elsewhere')
  const second = setup()
  initRuntime(second.api)
  const next = getStore(second.api)

  await next.ready()
  const accepted = next.getSnapshot()
  disposeStore(first.api)
  await vi.runAllTimersAsync()
  vi.useRealTimers()
  await rewrite(second, { 'Meadow/Orbit/Fox Woodland.vcf': { ...FOX, nickname: 'Updated' }, 'Meadow/Orbit/Otter Riverbank.vcf': { ...OTTER, nickname: 'Updated' } })
  await vi.waitFor(() => expect(next.getSnapshot()).not.toBe(accepted))
  expect(next.getSnapshot().contacts.every((contact) => contact.nickname === 'Updated')).toBe(true)
})

it('does not carry a pending rename or its delayed refresh into another vault', async () => {
  vi.useFakeTimers()
  const mock = setup()
  initRuntime(mock.api)
  const store = getStore(mock.api)
  await store.ready()
  const from = store.getSnapshot().contacts[0].relPath
  const to = 'Meadow/Orbit/Renamed.vcf'
  store.openContact(from)
  mock.emitFileRenamed(from, to)
  expect(store.getSnapshot().contacts.some((contact) => contact.relPath === to)).toBe(true)
  expect(vi.getTimerCount()).toBe(1)
  mock.emitState({ vault: { path: '/managed/destination', name: 'destination', displayName: 'Destination' } })
  await expect(store.ready()).rejects.toThrow('revoked')
  expect(store.getSnapshot().contacts.some((contact) => contact.relPath === to)).toBe(true)
  expect(store.getSnapshot().selectedPath).toBe(to)
  expect(vi.getTimerCount()).toBe(0)
  const settled = store.getSnapshot()
  await vi.runAllTimersAsync()
  expect(store.getSnapshot()).toBe(settled)
})
