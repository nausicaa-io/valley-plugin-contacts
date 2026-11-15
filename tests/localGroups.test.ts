import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { initRuntime } from '../src/runtime'
import { buildGroupTree } from '../src/data'
import { getAllContactGroups, getContactGroups, normalizeLocalGroups, renameLocalGroup } from '../src/groups'
import { buildContactFile, parseContactFile, updateContactFile } from '../src/schema'
import type { Contact, ContactGroup } from '../src/types'

vi.mock('../src/localization', () => ({ uiText: (key: string) => key, initLocalization: () => {} }))

const shared: ContactGroup[] = [{ id: 'shared-1', name: 'Family', color: 'palette:red' }]
const local = [
  { id: 'local-abc', name: 'Climbing', color: 'palette:blue' },
  { id: 'local-def', name: 'Boulder', color: 'palette:green', parent: 'local-abc' }
]

function setup(settings: Record<string, unknown>): void {
  const mock = createMockValleyApi({ manifest: { id: 'contacts' }, settings, groups: shared })
  initRuntime(mock.api)
}

afterEach(() => vi.restoreAllMocks())

describe('Contacts-only groups', () => {
  it('keeps valid groups, drops a name a shared group already uses and keeps subgroups under their group', () => {
    const groups = normalizeLocalGroups([...local, { id: 'local-x1', name: 'family', color: 'palette:pink' }, { id: 'bad', name: 'Nope', color: 'x' }], shared)
    expect(groups.map((group) => group.name)).toEqual(['Climbing', 'Boulder'])
    expect(groups[1].parent).toBe('local-abc')
  })

  it('keeps the old name as an alias when renamed', () => {
    expect(renameLocalGroup(local[0], 'Alpine')).toMatchObject({ name: 'Alpine', aliases: ['Climbing'] })
  })

  it('offers each kind only while its switch is on, but keeps every group for colours', () => {
    setup({ localGroups: local, useSharedGroups: false })
    expect(getContactGroups().map((group) => group.name)).toEqual(['Climbing', 'Boulder'])
    expect(getAllContactGroups().map((group) => group.name)).toEqual(['Family', 'Climbing', 'Boulder'])
    setup({ localGroups: local, useLocalGroups: false })
    expect(getContactGroups().map((group) => group.name)).toEqual(['Family'])
  })

  it('does not list a switched-off kind in the group tree', () => {
    const contacts = [{ displayName: 'Ada', relPath: 'Ada.vcf', groups: ['Family'] }, { displayName: 'Bo', relPath: 'Bo.vcf', groups: ['Climbing'] }] as Contact[]
    const tree = buildGroupTree(contacts, normalizeLocalGroups(local), shared)
    expect(tree.map((node) => node.label)).toEqual(['contacts.group.all', 'Climbing', 'Boulder'])
  })
})

describe('embedded photo', () => {
  const photo = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD'

  it('writes the photo into the card and reads it back', () => {
    const card = buildContactFile({ ...parseContactFile('Ada.vcf', ''), firstName: 'Ada', photo })
    expect(card).toContain('PHOTO:data:image/jpeg;base64,')
    expect(parseContactFile('Ada.vcf', card).photo).toBe(photo)
  })

  it('replaces only the photo when it changes and removes it when cleared', () => {
    const raw = buildContactFile({ ...parseContactFile('Ada.vcf', ''), firstName: 'Ada', note: 'Keep me', photo })
    const previous = parseContactFile('Ada.vcf', raw)
    const next = 'data:image/jpeg;base64,AAAA'
    const changed = updateContactFile({ ...previous, photo: next }, previous, raw)
    expect(parseContactFile('Ada.vcf', changed)).toMatchObject({ photo: next, note: 'Keep me' })
    const cleared = updateContactFile({ ...previous, photo: '' }, previous, raw)
    expect(cleared).not.toContain('PHOTO')
    expect(updateContactFile(previous, previous, raw)).toBe(raw)
  })
})
