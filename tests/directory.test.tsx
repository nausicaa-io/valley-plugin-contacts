import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONTACTS_DIRECTORY_V1, CONTACTS_DIRECTORY_REVISION_V1 } from '@valley/plugin-sdk'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { registerDirectory } from '../src/directory'
import { initRuntime } from '../src/runtime'
import { getStore, disposeStore } from '../src/store'
import type { Contact } from '../src/types'
import { cardAt, fileEntry } from './cards'

/** Index entries plus files for cards and plain assets. */
function vault(cards: Record<string, Partial<Contact>>, assets: string[] = []) {
  const files: Record<string, string> = {}
  for (const [relPath, fields] of Object.entries(cards)) files[relPath] = cardAt(relPath, fields)
  return { files, indexEntries: [...Object.entries(files).map(([relPath, content]) => fileEntry(relPath, content)), ...assets.map((relPath) => ({ relPath, title: relPath, kind: 'asset' as const, mtimeMs: 1 }))] }
}

let off: (() => Promise<void>) | undefined
afterEach(async () => { await off?.(); await disposeStore() })
it('provides exact-address matches, preserves ambiguous contacts and aliases, and publishes changes', async () => {
  const card = (name: string, address: string) => ({ firstName: name, email: [{ value: address, type: 'Field' }, { value: `${name.toLowerCase()}+survey@example.com` }] })
  const { files, indexEntries: entries } = vault({ 'Meadow/Orbit/Canopy.vcf': card('Canopy', 'shared@example.com'), 'Meadow/Orbit/Moss.vcf': card('Moss', 'SHARED@example.com') })
  const mock = createMockValleyApi({ manifest: { id: 'contacts' }, indexEntries: entries, files, settings: { contactsRoot: 'Meadow/Orbit' } })
  initRuntime(mock.api)
  off = registerDirectory(mock.api)
  await getStore(mock.api).ready()
  const provider = mock.api.interop.services.providers(CONTACTS_DIRECTORY_V1)[0]
  const matched = await provider.invoke('resolveEmails', [[' shared@EXAMPLE.com ', 'canopy@example.com', 'canopy+survey@example.com']])
  expect(matched.ok).toBe(true)
  if (!matched.ok) return
  const rows = matched.value as { contacts: { id: string; emails: unknown[] }[] }[]
  expect(rows.map((row) => row.contacts.length)).toEqual([2, 0, 1])
  expect(Object.keys(rows[0].contacts[0]).sort()).toEqual(['displayName', 'emails', 'id'])
  expect(await provider.invoke('search', ['Canopy', 10])).toMatchObject({ ok: true, value: [{ displayName: 'Canopy' }] })
  const before = mock.api.interop.state.get(CONTACTS_DIRECTORY_REVISION_V1)!
  mock.emitState({ indexEntries: [entries[0]] })
  await vi.waitFor(() => expect(mock.api.interop.state.get(CONTACTS_DIRECTORY_REVISION_V1)).toBeGreaterThan(before))
  expect(await provider.invoke('open', [entries[1].relPath])).toMatchObject({ ok: false })
  expect(await provider.invoke('open', [entries[0].relPath, { newTab: true }])).toMatchObject({ ok: true })
  expect(mock.api.workspace.openMainTab).toHaveBeenLastCalledWith({ newTab: true })
  off(); off = undefined
  expect(await provider.invoke('search', ['Canopy', 10])).toMatchObject({ ok: false, error: { code: 'provider-unavailable' } })
})

describe('Contacts directory boundary', () => {
  it('limits cover metadata concurrency and ignores unrelated file changes', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'contacts' }, ...vault(
      Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`Meadow/Orbit/Contact-${index}.vcf`, { firstName: `Contact ${index}`, cover: `cover-${index}.png` }])),
      Array.from({ length: 10 }, (_, index) => `Meadow/Orbit/cover-${index}.png`)
    ) })
    let finish!: () => void
    const blocked = new Promise<void>((resolve) => { finish = resolve })
    const fileInfo = vi.spyOn(mock.api.vault, 'fileInfo').mockImplementation(async () => { await blocked; return { size: 10, mtimeMs: 1 } })
    initRuntime(mock.api)
    off = registerDirectory(mock.api)
    await getStore(mock.api).ready()
    expect(fileInfo).toHaveBeenCalledTimes(4)
    finish()
    await vi.waitFor(() => expect(fileInfo).toHaveBeenCalledTimes(10))
    await Promise.resolve()
    mock.emitVaultChanged({ changes: [{ relPath: 'Unrelated.md', kind: 'change' }] })
    expect(fileInfo).toHaveBeenCalledTimes(10)
    mock.emitVaultChanged({ changes: [{ relPath: 'Meadow/Orbit/cover-0.png', kind: 'change' }] })
    await vi.waitFor(() => expect(fileInfo).toHaveBeenCalledTimes(11))
  })

  it('merges pending cover revisions and never publishes after disposal', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'contacts' }, ...vault({ 'Meadow/Orbit/Fern.vcf': { firstName: 'Fern', cover: 'fern.png' } }, ['Meadow/Orbit/fern.png']) })
    let finish!: () => void
    const blocked = new Promise<void>((resolve) => { finish = resolve })
    const fileInfo = vi.spyOn(mock.api.vault, 'fileInfo').mockImplementationOnce(async () => { await blocked; return { size: 10, mtimeMs: 1 } })
    initRuntime(mock.api)
    off = registerDirectory(mock.api)
    await getStore(mock.api).ready()
    for (let index = 0; index < 20; index++) mock.emitVaultChanged({ changes: [{ relPath: 'Meadow/Orbit/fern.png', kind: 'change' }] })
    expect(fileInfo).toHaveBeenCalledTimes(1)
    fileInfo.mockResolvedValueOnce({ size: 10, mtimeMs: 2 })
    finish()
    await vi.waitFor(() => expect(fileInfo).toHaveBeenCalledTimes(2))
    await Promise.resolve()
    let finishLast!: () => void
    fileInfo.mockImplementationOnce(() => new Promise((resolve) => { finishLast = () => resolve({ size: 10, mtimeMs: 3 }) }))
    mock.emitVaultChanged({ full: true })
    await vi.waitFor(() => expect(fileInfo).toHaveBeenCalledTimes(3))
    const draining = off!()
    expect(off!()).toBe(draining)
    off = undefined
    const settled = vi.fn()
    void draining.then(settled)
    const publish = vi.spyOn(mock.api.interop.state, 'publish')
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    finishLast()
    await draining
    expect(settled).toHaveBeenCalledOnce()
    expect(publish).not.toHaveBeenCalled()
  })

  it('revises avatar URLs when an existing image is edited', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'contacts' }, ...vault({ 'Meadow/Orbit/Fern.vcf': { firstName: 'Fern', email: [{ value: 'fern@example.com' }], cover: 'fern.png' } }, ['Meadow/Orbit/fern.png']) })
    let mtimeMs = 1
    mock.api.vault.fileInfo = async () => ({ size: 12, mtimeMs })
    initRuntime(mock.api)
    off = registerDirectory(mock.api)
    await getStore(mock.api).ready()
    const provider = mock.api.interop.services.providers(CONTACTS_DIRECTORY_V1)[0]
    const avatar = async () => {
      const result = await provider.invoke('search', ['Fern', 10])
      return result.ok ? (result.value as { avatarUrl?: string }[])[0]?.avatarUrl : undefined
    }
    let original: string | undefined
    await vi.waitFor(async () => { original = await avatar(); expect(original).toContain('?v=') })
    mtimeMs++
    mock.emitVaultChanged({ changes: [{ relPath: 'Meadow/Orbit/fern.png', kind: 'change' }] })
    await vi.waitFor(async () => expect(await avatar()).not.toBe(original))
  })

  it('validates query limits and cloneable result shapes', () => {
    expect(CONTACTS_DIRECTORY_V1.serviceCalls!.search.args(['forest', 500])).toBe(false)
    expect(CONTACTS_DIRECTORY_V1.serviceCalls!.resolveEmails.args([Array(201).fill('forest@example.com')])).toBe(false)
    expect(CONTACTS_DIRECTORY_V1.serviceCalls!.search.result([{ id: 'x', displayName: 'Forest', emails: [{ address: 3 }] }])).toBe(false)
  })
})
