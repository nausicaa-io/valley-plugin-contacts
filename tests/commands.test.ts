import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLUGIN_SURFACE_V1 } from '@valley/plugin-sdk'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { initRuntime } from '../src/runtime'
import { disposeStore, getStore } from '../src/store'
import { registerContactsCommands } from '../src/commands'
import { registerContactSurfaces } from '../src/surfaces'
import type { Contact } from '../src/types'
import { cardVault, uidFor } from './cards'

function setup(): ReturnType<typeof createMockValleyApi> {
  const { files, indexEntries } = cardVault({
    'Meadow/Orbit/Fox Woodland.vcf': { firstName: 'Fox', lastName: 'Woodland', groups: ['fungi'], phone: [{ value: '0000000000', type: 'Mobile' }], note: 'Woodland observation' },
    'Meadow/Orbit/Otter Riverbank.vcf': { firstName: 'Otter', lastName: 'Riverbank', groups: ['plants'], note: 'Woodland observation' }
  })
  const mock = createMockValleyApi({
    manifest: { id: 'contacts' },
    settings: { contactsRoot: 'Meadow/Orbit' },
    groups: [
      { id: 'fungi', name: 'fungi', color: '#a855f7' },
      { id: 'plants', name: 'plants', color: '#eab308' }
    ],
    indexEntries,
    files
  })
  initRuntime(mock.api)
  registerContactsCommands(mock.api)
  return mock
}

function writes(mock: ReturnType<typeof createMockValleyApi>): Array<{ relPath: string; content: string }> {
  return [mock.api.vault.writeTextDocumentGuarded, mock.api.vault.createTextDocumentGuarded, mock.api.vault.writeFileGuarded].flatMap(write => {
    const calls = vi.mocked(write).mock
    return calls.calls.map(([relPath, content], index) => ({ relPath, content, order: calls.invocationCallOrder[index] }))
  }).sort((a, b) => a.order - b.order)
}

function lastWrite(mock: ReturnType<typeof createMockValleyApi>): { relPath: string; content: string } {
  return writes(mock).at(-1)!
}

function writesTo(mock: ReturnType<typeof createMockValleyApi>, relPath: string): string[] {
  return writes(mock).filter(write => write.relPath === relPath).map(write => write.content)
}

function renames(mock: ReturnType<typeof createMockValleyApi>): { relPath: string; newRelPath: string }[] {
  return vi.mocked(mock.api.vault.renameTextDocumentGuarded).mock.calls.map(([relPath, newRelPath]) => ({ relPath, newRelPath }))
}

afterEach(() => {
  disposeStore()
})

it('releases surface subscriptions without accessing a revoked session', () => {
  const mock = setup()
  const dispose = registerContactSurfaces(mock.api)
  const surface = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1)[0].extension
  const unsubscribe = surface.subscribe(vi.fn())
  const state = mock.api.runtime.getOrCreate('contacts.surfaceActions', () => ({ listeners: new Set() }))
  expect(state.listeners.size).toBe(1)
  dispose()
  const runtime = vi.spyOn(mock.api.runtime, 'getOrCreate').mockImplementation(() => { throw new Error('Plugin session is no longer active') })
  try {
    unsubscribe()
    expect(state.listeners.size).toBe(0)
    expect(runtime).not.toHaveBeenCalled()
  } finally { runtime.mockRestore() }
})

describe('contacts:list / get', () => {
  it('lists every contact and filters by free-text query', async () => {
    const mock = setup()
    const all = await mock.api.commands.execute('contacts:list', { query: '' })
    expect(all.ok).toBe(true)
    expect((all as { value: Contact[] }).value.map((c) => c.displayName)).toEqual(['Fox Woodland', 'Otter Riverbank'])

    const filtered = await mock.api.commands.execute('contacts:list', { query: 'fox' })
    expect((filtered as { value: Contact[] }).value.map((c) => c.displayName)).toEqual(['Fox Woodland'])
  })

  it('filters by group', async () => {
    const mock = setup()
    const result = await mock.api.commands.execute('contacts:list', { group: 'plants' })
    expect((result as { value: Contact[] }).value.map((c) => c.displayName)).toEqual(['Otter Riverbank'])
  })

  it('gets a contact by name, case-insensitively', async () => {
    const mock = setup()
    const result = await mock.api.commands.execute('contacts:get', { name: 'fox woodland' })
    expect(result.ok).toBe(true)
    expect((result as { value: Contact }).value.firstName).toBe('Fox')
  })

  it('fails clearly when no contact matches', async () => {
    const mock = setup()
    const result = await mock.api.commands.execute('contacts:get', { name: 'Missing Species' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('No contact matches')
  })

  it('reads only the card notes, trimmed and without other properties', async () => {
    const mock = setup()
    const result = await mock.api.commands.execute('contacts:note', { name: 'Fox Woodland' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const v = result.value as { note: string; truncated: boolean; totalChars: number }
      expect(v.note).toBe('Woodland observation')
      expect(v.note).not.toContain('FN:')
      expect(v.truncated).toBe(false)
      expect(v.totalChars).toBe('Woodland observation'.length)
    }
  })

  it('truncates a long note and reports the total length', async () => {
    const vault = cardVault({ 'Meadow/Orbit/Long Observation.vcf': { firstName: 'Long', lastName: 'Observation', note: 'x'.repeat(50) } })
    const mock = createMockValleyApi({
      manifest: { id: 'contacts' },
      settings: { contactsRoot: 'Meadow/Orbit', groups: [] },
      ...vault
    })
    initRuntime(mock.api)
    registerContactsCommands(mock.api)

    const result = await mock.api.commands.execute('contacts:note', { name: 'Long Observation', maxChars: 10 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const v = result.value as { note: string; truncated: boolean; totalChars: number }
      expect(v.note).toHaveLength(10)
      expect(v.truncated).toBe(true)
      expect(v.totalChars).toBe(50)
    }
  })
})

describe('contacts:open', () => {
  it('opens a contact by vault path as well as by name', async () => {
    const mock = setup()
    const byPath = await mock.api.commands.execute('contacts:open', {
      path: 'Meadow/Orbit/Fox Woodland.vcf'
    })
    expect(byPath.ok, JSON.stringify(byPath)).toBe(true)
    expect((byPath as { value: Contact }).value.displayName).toBe('Fox Woodland')
    expect(mock.driverCalls).not.toContainEqual(expect.objectContaining({
      driver: 'settings',
      method: 'updatePluginSettings'
    }))

    const byName = await mock.api.commands.execute('contacts:open', { name: 'Otter Riverbank' })
    expect(byName.ok).toBe(true)
    expect((byName as { value: Contact }).value.displayName).toBe('Otter Riverbank')
  })

  it('refuses a path that is not a contact', async () => {
    const mock = setup()
    const result = await mock.api.commands.execute('contacts:open', { path: 'Habitats/Fungi Survey.md' })
    expect(result.ok).toBe(false)
  })
})

describe('contacts:create', () => {
  it('creates a contact and reverts by deleting it', async () => {
    const mock = setup()
    const result = await mock.api.commands.execute('contacts:create', {
      firstName: 'Badger',
      lastName: 'Burrow',
      profession: 'Botany',
      phone: '0000000002',
      phoneType: 'mobile'
    })
    expect(result.ok).toBe(true)
    const value = (result as { value: Contact }).value
    expect(value.relPath).toBe('Meadow/Orbit/Badger Burrow.vcf')
    const written = lastWrite(mock)
    expect(written.relPath).toBe('Meadow/Orbit/Badger Burrow.vcf')
    expect(written.content).toContain('0000000002')

    expect(mock.busUndo).toHaveLength(1)
    await mock.busUndo[0].undo()
    expect(mock.api.vault.trashTextDocumentGuarded).toHaveBeenCalledWith('Meadow/Orbit/Badger Burrow.vcf', expect.any(String))
    expect(await mock.api.vault.readFile('Meadow/Orbit/Badger Burrow.vcf')).toBe('')
  })

  it('keeps the creation receipt when newer typing arrives before the create result returns', async () => {
    const mock = setup()
    const create = vi.mocked(mock.api.vault.createTextDocumentGuarded).getMockImplementation()!
    vi.mocked(mock.api.vault.createTextDocumentGuarded).mockImplementationOnce(async (...args) => {
      const result = await create(...args)
      await mock.api.vault.writeFile(args[0], `${args[1]}Newer editor text`)
      return result
    })
    expect((await mock.api.commands.execute('contacts:create', { firstName: 'Badger' })).ok).toBe(true)
    const read = vi.spyOn(mock.api.vault, 'readTextDocument')
    await expect(mock.busUndo[0].undo()).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
    expect(await mock.api.vault.readFile('Meadow/Orbit/Badger.vcf')).toContain('Newer editor text')
  })

  it('never retries created-file undo after the host rejects a dirty editor', async () => {
    const mock = setup()
    await mock.api.commands.execute('contacts:create', { firstName: 'Badger' })
    const original = await mock.api.vault.readFile('Meadow/Orbit/Badger.vcf')
    vi.mocked(mock.api.vault.trashTextDocumentGuarded).mockResolvedValueOnce({ ok: false, reason: 'stale' })
    await expect(mock.busUndo[0].undo()).rejects.toThrow()
    await expect(mock.busUndo[0].undo()).rejects.toThrow()
    expect(mock.api.vault.trashTextDocumentGuarded).toHaveBeenCalledOnce()
    expect(await mock.api.vault.readFile('Meadow/Orbit/Badger.vcf')).toBe(original)
  })

  it.each([true, false])('reports committed deletion with newer text and recoverySaved=%s without replaying', async recoverySaved => {
    const mock = setup()
    await mock.api.commands.execute('contacts:create', { firstName: 'Badger' })
    const trash = vi.mocked(mock.api.vault.trashTextDocumentGuarded).getMockImplementation()!
    vi.mocked(mock.api.vault.trashTextDocumentGuarded).mockImplementationOnce(async (...args) => {
      const result = await trash(...args)
      return result.ok ? { ...result, editorConflict: true, recoverySaved } : result
    })
    await expect(mock.busUndo[0].undo()).rejects.toThrow('file was deleted')
    await expect(mock.busUndo[0].undo()).rejects.toThrow()
    expect(mock.api.vault.trashTextDocumentGuarded).toHaveBeenCalledOnce()
    expect(await mock.api.vault.readFile('Meadow/Orbit/Badger.vcf')).toBe('')
  })

  it('does not replay an uncertain trash result', async () => {
    const mock = setup()
    await mock.api.commands.execute('contacts:create', { firstName: 'Badger' })
    const trash = vi.mocked(mock.api.vault.trashTextDocumentGuarded).getMockImplementation()!
    vi.mocked(mock.api.vault.trashTextDocumentGuarded).mockImplementationOnce(async (...args) => { await trash(...args); throw new Error('Acknowledgement lost') })
    await expect(mock.busUndo[0].undo()).rejects.toThrow('Acknowledgement lost')
    await expect(mock.busUndo[0].undo()).rejects.toThrow()
    expect(mock.api.vault.trashTextDocumentGuarded).toHaveBeenCalledOnce()
  })
})

describe('contacts:update', () => {
  it('updates scalar fields and preserves the notes', async () => {
    const mock = setup()
    const result = await mock.api.commands.execute('contacts:update', { name: 'Fox Woodland', profession: 'Mycology' })
    expect(result.ok).toBe(true)
    const written = lastWrite(mock)
    expect(written.content).toContain('ROLE:Mycology')
    expect(written.content).toContain('NOTE:Woodland observation')
  })

  it('reverts to the exact prior file content', async () => {
    const mock = setup()
    const relPath = 'Meadow/Orbit/Fox Woodland.vcf'
    const before = await mock.api.vault.readFile(relPath)
    await mock.api.commands.execute('contacts:update', { name: 'Fox Woodland', profession: 'Mycology' })

    await mock.busUndo[0].undo()
    const writes = writesTo(mock, relPath)
    expect(writes.at(-1)).toBe(before)
  })

})

describe('contact file names', () => {
  it('renames the card when the name changes', async () => {
    const mock = setup()
    const result = await mock.api.commands.execute('contacts:update', { name: 'Fox Woodland', lastName: 'Mäander' })
    expect(result.ok).toBe(true)
    expect(renames(mock)).toEqual([
      { relPath: 'Meadow/Orbit/Fox Woodland.vcf', newRelPath: 'Meadow/Orbit/Fox Mäander.vcf' }
    ])
    expect((result as { value: Contact }).value.relPath).toBe('Meadow/Orbit/Fox Mäander.vcf')
    // The new card bytes land first, at the old path before the rename.
    expect(lastWrite(mock).relPath).toBe('Meadow/Orbit/Fox Woodland.vcf')
  })

  it('leaves the file alone when the name did not change', async () => {
    const mock = setup()
    await mock.api.commands.execute('contacts:update', { name: 'Fox Woodland', profession: 'Mycology' })
    await mock.api.commands.execute('contacts:add-group', { name: 'Fox Woodland', group: 'wetlands' })
    expect(renames(mock)).toEqual([])
  })

  it('never renames a hand-named card', async () => {
    const relPath = 'Meadow/Orbit/Fox (Field).vcf'
    const mock = createMockValleyApi({
      manifest: { id: 'contacts' },
      settings: { contactsRoot: 'Meadow/Orbit', groups: [] },
      ...cardVault({ [relPath]: { firstName: 'Fox', lastName: 'Woodland' } })
    })
    initRuntime(mock.api)
    registerContactsCommands(mock.api)

    await mock.api.commands.execute('contacts:update', { name: 'Fox Woodland', lastName: 'Mäander' })
    expect(renames(mock)).toEqual([])
    expect(lastWrite(mock).relPath).toBe(relPath)
  })

  it('renames to an explicit file name even when the name is unchanged', async () => {
    const mock = setup()
    await mock.api.commands.execute('contacts:update', { name: 'Fox Woodland', fileName: 'Fox (Field)' })
    expect(renames(mock)).toEqual([
      { relPath: 'Meadow/Orbit/Fox Woodland.vcf', newRelPath: 'Meadow/Orbit/Fox (Field).vcf' }
    ])
  })

  it('auto-numbers instead of overwriting an occupied name', async () => {
    const mock = setup()
    const result = await mock.api.commands.execute('contacts:update', {
      name: 'Fox Woodland',
      firstName: 'Otter',
      lastName: 'Riverbank'
    })
    expect(renames(mock)).toEqual([
      { relPath: 'Meadow/Orbit/Fox Woodland.vcf', newRelPath: 'Meadow/Orbit/Otter Riverbank 2.vcf' }
    ])
    expect((result as { value: Contact }).value.relPath).toBe('Meadow/Orbit/Otter Riverbank 2.vcf')
    expect(await mock.api.vault.readFile('Meadow/Orbit/Otter Riverbank.vcf')).toContain('N:Riverbank;Otter;;;')
  })

  it('reverts a renaming update back to the old name and bytes', async () => {
    const mock = setup()
    const relPath = 'Meadow/Orbit/Fox Woodland.vcf'
    const before = await mock.api.vault.readFile(relPath)
    await mock.api.commands.execute('contacts:update', { name: 'Fox Woodland', lastName: 'Mäander' })

    await mock.busUndo[0].undo()
    expect(renames(mock).at(-1)).toEqual({
      relPath: 'Meadow/Orbit/Fox Mäander.vcf',
      newRelPath: relPath
    })
    expect(await mock.api.vault.readFile(relPath)).toBe(before)
    expect(await mock.api.vault.readFile('Meadow/Orbit/Fox Mäander.vcf')).toBe('')
  })

  it('creates a namesake beside the original instead of overwriting it', async () => {
    const mock = setup()
    const original = await mock.api.vault.readFile('Meadow/Orbit/Fox Woodland.vcf')
    const result = await mock.api.commands.execute('contacts:create', { firstName: 'Fox', lastName: 'Woodland' })
    expect(result.ok).toBe(true)
    expect((result as { value: Contact }).value.relPath).toBe('Meadow/Orbit/Fox Woodland 2.vcf')
    expect(lastWrite(mock).relPath).toBe('Meadow/Orbit/Fox Woodland 2.vcf')
    expect(await mock.api.vault.readFile('Meadow/Orbit/Fox Woodland.vcf')).toBe(original)
  })
})

describe('contacts:delete', () => {
  it('soft-deletes and reverts by rewriting the original content', async () => {
    const mock = setup()
    const relPath = 'Meadow/Orbit/Otter Riverbank.vcf'
    const before = await mock.api.vault.readFile(relPath)

    const result = await mock.api.commands.execute('contacts:delete', { name: 'Otter Riverbank' })
    expect(result.ok).toBe(true)
    expect(mock.api.vault.trashTextDocumentGuarded).toHaveBeenCalledWith(relPath, expect.any(String))

    await mock.busUndo[0].undo()
    expect(writesTo(mock, relPath).at(-1)).toBe(before)
  })

  it('keeps a changed note when deletion loses its captured revision', async () => {
    const mock = setup()
    const path = 'Meadow/Orbit/Otter Riverbank.vcf'
    const trash = vi.mocked(mock.api.vault.trashTextDocumentGuarded).getMockImplementation()!
    vi.mocked(mock.api.vault.trashTextDocumentGuarded).mockImplementationOnce(async (...args) => {
      await mock.api.vault.writeFile(path, 'Newer text')
      return trash(...args)
    })
    expect((await mock.api.commands.execute('contacts:delete', { name: path })).ok).toBe(false)
    expect(await mock.api.vault.readFile(path)).toBe('Newer text')
    expect(mock.busUndo).toHaveLength(0)
  })

  it('fails closed before deletion when the current document cannot be read', async () => {
    const mock = setup()
    vi.spyOn(mock.api.vault, 'readTextDocument').mockRejectedValue(new Error('Read failed'))
    expect((await mock.api.commands.execute('contacts:delete', { name: 'Otter Riverbank' })).ok).toBe(false)
    expect(mock.api.vault.trashTextDocumentGuarded).not.toHaveBeenCalled()
  })

  it('reports committed deletion and withholds recreation when newer text needs recovery', async () => {
    const mock = setup()
    const trash = vi.mocked(mock.api.vault.trashTextDocumentGuarded).getMockImplementation()!
    vi.mocked(mock.api.vault.trashTextDocumentGuarded).mockImplementationOnce(async (...args) => {
      const result = await trash(...args)
      return result.ok ? { ...result, editorConflict: true, recoverySaved: false } : result
    })
    expect(await mock.api.commands.execute('contacts:delete', { name: 'Otter Riverbank' })).toMatchObject({ ok: true, value: { warning: expect.stringContaining('file was deleted') } })
    expect(mock.busUndo).toHaveLength(0)
  })
})

describe('contacts:add-phone / remove-phone', () => {
  it('adds a phone number', async () => {
    const mock = setup()
    const result = await mock.api.commands.execute('contacts:add-phone', { name: 'Otter Riverbank', value: '0000000001', type: 'work' })
    expect(result.ok).toBe(true)
    expect(lastWrite(mock).content).toContain('0000000001')
  })

  it('removes a matching phone number', async () => {
    const mock = setup()
    const result = await mock.api.commands.execute('contacts:remove-phone', { name: 'Fox Woodland', value: '0000000000' })
    expect(result.ok).toBe(true)
    expect(lastWrite(mock).content).not.toContain('0000000000')
  })
})

describe('contacts:add-group / remove-group', () => {
  it('adds and removes group membership without duplicating', async () => {
    const mock = setup()
    const added = await mock.api.commands.execute('contacts:add-group', { name: 'Otter Riverbank', group: 'fungi' })
    expect((added as { value: Contact }).value.groups).toEqual(['plants', 'fungi'])

    const addedAgain = await mock.api.commands.execute('contacts:add-group', { name: 'Otter Riverbank', group: 'plants' })
    expect((addedAgain as { value: Contact }).value.groups).toEqual(['plants', 'fungi'])

    const removed = await mock.api.commands.execute('contacts:remove-group', { name: 'Fox Woodland', group: 'fungi' })
    expect((removed as { value: Contact }).value.groups).toEqual([])
  })

  it('rejects a membership that does not exist in the shared registry', async () => {
    const mock = setup()
    const result = await mock.api.commands.execute('contacts:add-group', {
      name: 'Otter Riverbank',
      group: 'unregistered'
    })
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('Settings → Appearance → Groups') } })
  })
})

describe('contacts:add-relation / remove-relation', () => {
  it('adds a relation inferring the type from the role, then removes it', async () => {
    const mock = setup()
    const added = await mock.api.commands.execute('contacts:add-relation', { name: 'Fox Woodland', to: 'Otter Riverbank', role: 'colleague' })
    expect(added.ok).toBe(true)
    expect((added as { value: Contact }).value.relations).toEqual([{ to: uidFor('Meadow/Orbit/Otter Riverbank.vcf'), type: 'work', role: 'colleague' }])
    expect(lastWrite(mock).content.replace(/\r\n /g, '')).toContain(`RELATED;TYPE=colleague;X-ROLE=colleague:${uidFor('Meadow/Orbit/Otter Riverbank.vcf')}`)

    const removed = await mock.api.commands.execute('contacts:remove-relation', { name: 'Fox Woodland', to: 'Otter Riverbank' })
    expect((removed as { value: Contact }).value.relations).toEqual([])
  })
})

describe('contacts explicit field edits', () => {
  it('updates existing list fields and clears text without replacing the notes', async () => {
    const mock = setup()
    const result = await mock.api.commands.execute('contacts:edit-fields', { path: 'Meadow/Orbit/Fox Woodland.vcf', values: { profession: '', phone: [{ value: '01234', type: 'work' }], websites: ['https://example.org'] } })
    expect(result.ok).toBe(true)
    expect(lastWrite(mock).content).toContain('01234')
    expect(lastWrite(mock).content).toContain('Woodland observation')
    expect(mock.busUndo).toHaveLength(1)
    await mock.busUndo[0].undo()
    expect(lastWrite(mock).content).toContain('0000000000')
  })

  it('rejects missing targets, unknown fields and stale revisions before writing', async () => {
    const mock = setup()
    for (const input of [
      { path: 'Missing.vcf', values: { profession: 'Surveyor' } },
      { path: 'Meadow/Orbit/Fox Woodland.vcf', values: { custom: 'not a contact field' } },
      { path: 'Meadow/Orbit/Fox Woodland.vcf', values: { profession: 'Surveyor' }, expectedRaw: 'stale' }
    ]) expect((await mock.api.commands.execute('contacts:edit-fields', input)).ok).toBe(false)
    expect(writes(mock)).toHaveLength(0)
  })
})

describe('Contacts document revisions', () => {
  const path = 'Meadow/Orbit/Fox Woodland.vcf'

  it('edits the live card and preserves unsaved editor text and unknown properties', async () => {
    const mock = setup()
    const original = await mock.api.vault.readFile(path)
    const draft = original.replace('NOTE:Woodland observation', 'NOTE:Unsaved ä ö ü notes\r\nX-CUSTOM;X-PARAM="a;b":retained')
    await mock.api.vault.writeFile(path, draft)
    await getStore(mock.api).ready()
    const readDisk = vi.spyOn(mock.api.vault, 'readFile').mockRejectedValue(new Error('Edits must read the live document'))
    const result = await mock.api.commands.execute('contacts:add-phone', { name: path, value: '01234' })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(lastWrite(mock).content).toContain('X-CUSTOM;X-PARAM="a;b":retained')
    expect(lastWrite(mock).content).toContain('NOTE:Unsaved ä ö ü notes')
    expect(lastWrite(mock).content).toContain('TEL:01234')
    expect(readDisk).not.toHaveBeenCalled()
    await mock.busUndo[0].undo()
    expect(lastWrite(mock).content).toBe(draft)
  })

  it('rejects unreadable and malformed documents before any mutation', async () => {
    const mock = setup()
    vi.spyOn(mock.api.vault, 'readTextDocument').mockRejectedValueOnce(new Error('Read failed'))
    expect((await mock.api.commands.execute('contacts:add-phone', { name: path, value: '01234' })).ok).toBe(false)
    await mock.api.vault.writeFile(path, 'BEGIN:VCARD\r\nFN:Unterminated\r\n')
    expect((await mock.api.commands.execute('contacts:add-phone', { name: path, value: '01234' })).ok).toBe(false)
    await mock.api.vault.writeFile(path, 'Plain text, not a card')
    expect((await mock.api.commands.execute('contacts:edit-fields', { path, values: { profession: 'Botany' } })).ok).toBe(false)
    expect(writes(mock)).toEqual([])
  })

  it('rejects a changed document between capture and save without renaming', async () => {
    const mock = setup()
    const write = vi.mocked(mock.api.vault.writeTextDocumentGuarded).getMockImplementation()!
    vi.mocked(mock.api.vault.writeTextDocumentGuarded).mockImplementationOnce(async (...args) => {
      await mock.api.vault.writeFile(path, 'Newer draft')
      return write(...args)
    })
    expect((await mock.api.commands.execute('contacts:update', { name: path, lastName: 'Mäander' })).ok).toBe(false)
    expect(await mock.api.vault.readFile(path)).toBe('Newer draft')
    expect(renames(mock)).toEqual([])
  })

  it('retains the exact undo token and rejects an edit/revert ABA without a new read', async () => {
    const mock = setup()
    await mock.api.commands.execute('contacts:update', { name: path, profession: 'Botany' })
    const content = await mock.api.vault.readFile(path)
    await mock.api.vault.writeFile(path, `${content}newer`)
    await mock.api.vault.writeFile(path, content)
    const read = vi.spyOn(mock.api.vault, 'readTextDocument')
    await expect(mock.busUndo[0].undo()).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
    expect(await mock.api.vault.readFile(path)).toBe(content)
  })

  it('keeps a completed rename but refuses undo when the moved card changed afterwards', async () => {
    const mock = setup()
    const moved = 'Meadow/Orbit/Fox Mäander.vcf'
    const result = await mock.api.commands.execute('contacts:update', { name: path, lastName: 'Mäander' })
    expect(result.ok).toBe(true)
    await mock.api.vault.writeFile(moved, 'Newer moved draft')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(mock.busUndo[0].undo()).rejects.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not rename'))
    warn.mockRestore()
    expect(renames(mock)).toHaveLength(2)
    expect(await mock.api.vault.readFile(moved)).toBe('Newer moved draft')
  })

  it('does not fail a committed save or fabricate undo when the rename reports newer editor text', async () => {
    const mock = setup()
    const rename = vi.mocked(mock.api.vault.renameTextDocumentGuarded).getMockImplementation()!
    vi.mocked(mock.api.vault.renameTextDocumentGuarded).mockImplementationOnce(async (...args) => {
      const renamed = await rename(...args)
      return renamed.ok ? { ...renamed, revisionToken: null, editorConflict: true } : renamed
    })
    expect((await mock.api.commands.execute('contacts:update', { name: path, lastName: 'Mäander' })).ok).toBe(true)
    await expect(mock.busUndo[0].undo()).rejects.toThrow()
    expect(await mock.api.vault.readFile('Meadow/Orbit/Fox Mäander.vcf')).toContain('N:Mäander;Fox;;;')
  })

  it('keeps guarded undo on the original path when renaming fails', async () => {
    const mock = setup()
    const original = await mock.api.vault.readFile(path)
    vi.mocked(mock.api.vault.renameTextDocumentGuarded).mockResolvedValue({ ok: false, reason: 'error' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await mock.api.commands.execute('contacts:update', { name: path, lastName: 'Mäander' })
      expect(result).toMatchObject({ ok: true, value: { relPath: path } })
      expect((await mock.busUndo[0].undo()).ok).toBe(true)
      expect(await mock.api.vault.readFile(path)).toBe(original)
    } finally { warn.mockRestore() }
  })

  it('does not overwrite a new file when restoring a deleted contact', async () => {
    const mock = setup()
    await mock.api.commands.execute('contacts:delete', { name: path })
    await mock.api.vault.writeFile(path, 'Replacement')
    await expect(mock.busUndo[0].undo()).rejects.toThrow()
    expect(await mock.api.vault.readFile(path)).toBe('Replacement')
  })
})

it('preserves typing during a committed property write and does not rename or offer undo', async () => {
  const mock = setup()
  const path = 'Meadow/Orbit/Fox Woodland.vcf'
  const write = vi.mocked(mock.api.vault.writeTextDocumentGuarded).getMockImplementation()!
  vi.mocked(mock.api.vault.writeTextDocumentGuarded).mockImplementationOnce(async (...args) => {
    const result = await write(...args)
    if (!result.ok) return result
    await mock.api.vault.writeFile(path, `${args[1]}Newer typing\n`)
    return { ok: true, revisionToken: null, editorConflict: true }
  })
  expect((await mock.api.commands.execute('contacts:update', { name: path, lastName: 'Mäander' })).ok).toBe(true)
  expect(renames(mock)).toEqual([])
  await expect(mock.busUndo[0].undo()).rejects.toThrow()
  expect(await mock.api.vault.readFile(path)).toContain('Newer typing')
})

it('leaves the renamed card untouched when undo cannot rename it back, without replaying', async () => {
  const mock = setup()
  const path = 'Meadow/Orbit/Fox Woodland.vcf'
  const moved = 'Meadow/Orbit/Fox Mäander.vcf'
  expect((await mock.api.commands.execute('contacts:update', { name: path, lastName: 'Mäander' })).ok).toBe(true)
  const renamed = await mock.api.vault.readFile(moved)
  vi.mocked(mock.api.vault.renameTextDocumentGuarded).mockResolvedValue({ ok: false, reason: 'error' })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const count = vi.mocked(mock.api.vault.writeTextDocumentGuarded).mock.calls.length
    await expect(mock.busUndo[0].undo()).rejects.toThrow()
    expect(await mock.api.vault.readFile(moved)).toBe(renamed)
    await expect(mock.busUndo[0].undo()).rejects.toThrow()
    expect(mock.api.vault.writeTextDocumentGuarded).toHaveBeenCalledTimes(count)
  } finally { warn.mockRestore() }
})
