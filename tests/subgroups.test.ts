import { describe, expect, it, vi } from 'vitest'
import { ALL, UNCATEGORIZED, buildGroupTree, filterByGroup, filterBySelectedGroups, pickGroup, selectionFromHidden } from '../src/data'
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
    expect(tree.find((node) => node.id === 'Lab')).toMatchObject({ count: 2, sub: true, parent: 'Uni', key: 'lab' })
    expect(tree.find((node) => node.id === 'Club')).toEqual({ id: 'Club', label: 'Club', count: 1, key: 'club' })
  })

  it('filters a group together with its subgroups', () => {
    expect(names(filterByGroup(contacts, 'uni', groups))).toEqual(['Ada', 'Bea', 'Cy'])
    expect(names(filterByGroup(contacts, 'Lab', groups))).toEqual(['Bea'])
  })

  it('shows the selected groups, a group covering its subgroups, and everyone when nothing is selected', () => {
    expect(names(filterBySelectedGroups(contacts, [], groups))).toEqual(['Ada', 'Bea', 'Cy', 'Dee', 'Eli'])
    expect(names(filterBySelectedGroups(contacts, ['Uni'], groups))).toEqual(['Ada', 'Bea', 'Cy'])
    expect(names(filterBySelectedGroups(contacts, ['Lab'], groups))).toEqual(['Bea'])
    expect(names(filterBySelectedGroups(contacts, ['Lab', 'Club'], groups))).toEqual(['Bea', 'Dee'])
    expect(names(filterBySelectedGroups(contacts, [UNCATEGORIZED], groups))).toEqual(['Eli'])
    expect(names(filterBySelectedGroups(contacts, ['Club', UNCATEGORIZED], groups))).toEqual(['Dee', 'Eli'])
  })

  it('picks one group, toggles exactly the clicked one with a modifier, and clears with All', () => {
    expect(pickGroup([], 'Uni')).toEqual(['Uni'])
    expect(pickGroup(['Uni'], 'Club')).toEqual(['Club'])
    expect(pickGroup(['Uni'], 'Uni')).toEqual([])
    expect(pickGroup(['Uni', 'Club'], 'Uni')).toEqual(['Uni'])
    expect(pickGroup(['Uni'], 'Club', true)).toEqual(['Uni', 'Club'])
    expect(pickGroup(['Uni', 'Club'], 'Uni', true)).toEqual(['Club'])
    expect(pickGroup(['Uni'], 'Uni', true)).toEqual([])
    expect(pickGroup([], UNCATEGORIZED, true)).toEqual([UNCATEGORIZED])
    expect(pickGroup(['Uni', 'Club'], ALL)).toEqual([])
    expect(pickGroup(['Uni'], ALL, true)).toEqual([])
  })

  it('reads a filter saved as hidden groups as the groups left shown', () => {
    const tree = buildGroupTree(contacts, groups)
    expect(selectionFromHidden(tree, [], false)).toEqual([])
    expect(selectionFromHidden(tree, ['club'], false)).toEqual(['Uni', UNCATEGORIZED])
    expect(selectionFromHidden(tree, ['Uni'], true)).toEqual(['Club'])
    expect(selectionFromHidden(tree, ['Gone'], false)).toEqual([])
  })
})
