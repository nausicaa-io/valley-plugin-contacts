import { describe, expect, it, vi } from 'vitest'
import { buildGroupTree, filterByGroup, filterByGroupVisibility } from '../src/data'
import type { Contact, ContactGroup } from '../src/types'

vi.mock('../src/localization', () => ({ uiText: (key: string) => key }))

const groups: ContactGroup[] = [
  { id: 'uni', name: 'Uni', color: 'palette:red' },
  { id: 'lab', name: 'Lab', color: 'palette:blue', parent: 'uni', aliases: ['Workshop'] },
  { id: 'club', name: 'Club', color: 'palette:green' }
]
const contact = (displayName: string, ...names: string[]): Contact => ({ displayName, relPath: `${displayName}.vcf`, groups: names } as Contact)
const contacts = [contact('Ada', 'Uni'), contact('Bea', 'Lab'), contact('Cy', 'workshop', 'Uni'), contact('Dee', 'Club'), contact('Eli')]
const names = (list: Contact[]): string[] => list.map((entry) => entry.displayName)

describe('Contacts subgroups', () => {
  it('counts a group with its subgroups, each contact once, and marks subgroups for the lists', () => {
    const tree = buildGroupTree(contacts, groups)
    expect(tree.find((node) => node.id === 'Uni')).toMatchObject({ count: 3 })
    expect(tree.find((node) => node.id === 'Lab')).toMatchObject({ count: 2, sub: true })
    expect(tree.find((node) => node.id === 'Club')).toEqual({ id: 'Club', label: 'Club', count: 1 })
  })

  it('filters a group together with its subgroups', () => {
    expect(names(filterByGroup(contacts, 'uni', groups))).toEqual(['Ada', 'Bea', 'Cy'])
    expect(names(filterByGroup(contacts, 'Lab', groups))).toEqual(['Bea'])
  })

  it('hides the subgroups of a hidden group, and only the subgroup when that is hidden', () => {
    expect(names(filterByGroupVisibility(contacts, ['Uni'], false, groups))).toEqual(['Dee', 'Eli'])
    expect(names(filterByGroupVisibility(contacts, ['Lab'], false, groups))).toEqual(['Ada', 'Cy', 'Dee', 'Eli'])
  })
})
