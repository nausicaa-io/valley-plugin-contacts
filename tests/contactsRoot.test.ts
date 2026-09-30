import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { getSettings, resolveContactCovers, resolveCoverPath } from '../src/data'
import { initRuntime } from '../src/runtime'
import { disposeStore, getStore, loadContacts } from '../src/store'
import { cardVault, contactAt, fileEntry } from './cards'

let installed = false
afterEach(async () => { if (installed) await disposeStore() })

it('shares cover lookup while preserving exact paths, first filename matches, and missing references', () => {
  const entries = [
    fileEntry('People/Cover.png', ''),
    fileEntry('Archive/Cover.png', ''),
    fileEntry('Cover.vcf', '')
  ]
  const covers = ['Cover.png', 'COVER.PNG', 'Archive/Cover.png', 'Missing/Cover.png', 'Cover.vcf', 'missing.png', undefined]
  const contacts = covers.map((cover, index) => contactAt(`Contact ${index}.vcf`, { cover: cover ?? '' }))
  expect(resolveContactCovers(contacts, entries)).toEqual(Object.fromEntries(
    contacts.map((contact) => [contact.relPath, resolveCoverPath(entries, contact.cover)])
  ))
})

const VAULT = cardVault({
  'Steve Wozniak.vcf': { firstName: 'Steve' },
  'Role - Design Partner.vcf': { firstName: 'Design' },
  'Meadow/Orbit/Moss.vcf': { firstName: 'Moss' },
  'Meadow/Orbit/Nested/Lichen.vcf': { firstName: 'Lichen' }
}, {
  'Templates/Template - Contact.md': '---\ntype: contact\n---\n',
  'Meadow/Orbit/Notes.md': '# Not a contact\n',
  'Meadow/Orbit/Broken.vcf': 'this is not a vCard',
  'Meadow/Orbit/Empty.vcf': ''
})

async function install(contactsRoot: unknown): Promise<void> {
  const mock = createMockValleyApi({ manifest: { id: 'contacts', indexState: 'scoped' }, settings: { contactsRoot }, indexEntries: VAULT.indexEntries, files: VAULT.files, templateFolder: 'Templates' })
  initRuntime(mock.api)
  installed = true
  await getStore(mock.api).ready()
}

const names = (): string[] => loadContacts().map((c) => c.relPath)

describe('contactsRoot scoping', () => {
  it('scopes to a folder and its subfolders, keeping empty cards and skipping unreadable files', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await install('Meadow/Orbit')
    expect(getSettings().contactsRoot).toBe('Meadow/Orbit')
    expect(names()).toEqual(['Meadow/Orbit/Empty.vcf', 'Meadow/Orbit/Nested/Lichen.vcf', 'Meadow/Orbit/Moss.vcf'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Meadow/Orbit/Broken.vcf is not a readable vCard'))
    warn.mockRestore()
  })

  it('falls back to the default folder when unset', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await install('')
    expect(getSettings().contactsRoot).toBe('Meadow/Orbit')
    expect(names()).toContain('Meadow/Orbit/Moss.vcf')
    vi.restoreAllMocks()
  })

  it('reads every card in the vault when the root is "/" or "."', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const sentinel of ['/', '.']) {
      await install(sentinel)
      expect(getSettings().contactsRoot).toBe('')
      expect(names()).toEqual(['Role - Design Partner.vcf', 'Meadow/Orbit/Empty.vcf', 'Meadow/Orbit/Nested/Lichen.vcf', 'Meadow/Orbit/Moss.vcf', 'Steve Wozniak.vcf'])
      await disposeStore()
    }
    vi.restoreAllMocks()
  })
})
