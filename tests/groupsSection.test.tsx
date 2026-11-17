import * as React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { PLUGIN_SURFACE_V1 } from '@valley/plugin-sdk'
import { initRuntime } from '../src/runtime'
import { disposeStore, getStore } from '../src/store'
import { Panel } from '../src/Panel'
import { registerContactSurfaces } from '../src/surfaces'
import { UNCATEGORIZED } from '../src/data'
import { cardRealm } from './cards'

function setup(settings: Record<string, unknown> = {}): ReturnType<typeof createMockValleyApi> {
  const mock = createMockValleyApi({
    manifest: { id: 'contacts' },
    groups: [
      { id: 'fungi', name: 'fungi', color: '#a855f7' },
      { id: 'moss', name: 'moss', color: '#16a34a', parent: 'fungi' },
      { id: 'plants', name: 'plants', color: '#eab308' }
    ],
    settings: {
      contactsRoot: 'Meadow',
      localGroups: [{ id: 'local-aa11bb22cc33', name: 'pond', color: '#0ea5e9' }],
      ...settings
    },
    ...cardRealm({
      'Meadow/Chanterelle.vcf': { firstName: 'Chanterelle', groups: ['fungi'] },
      'Meadow/Lichen.vcf': { firstName: 'Lichen', groups: ['moss'] },
      'Meadow/Otter.vcf': { firstName: 'Otter', groups: ['plants'] },
      'Meadow/Heron.vcf': { firstName: 'Heron', groups: ['pond'] },
      'Meadow/Badger.vcf': { firstName: 'Badger', groups: [] }
    })
  })
  initRuntime(mock.api)
  registerContactSurfaces(mock.api)
  return mock
}

afterEach(() => {
  cleanup()
  disposeStore()
})

async function renderPanel(mock: ReturnType<typeof createMockValleyApi>): Promise<{ container: HTMLElement; list: HTMLElement; section: () => HTMLElement }> {
  await getStore(mock.api).ready()
  const { container } = render(React.createElement(Panel))
  return {
    container,
    list: container.querySelector('.ct-list') as HTMLElement,
    section: () => container.querySelector('.ct-groups') as HTMLElement
  }
}

const row = (name: string): HTMLElement => screen.getByRole('button', { name })
const shown = (list: HTMLElement): string[] => [...list.querySelectorAll('.ct-row-name')].map((node) => node.textContent ?? '')

describe('Contacts sidebar Groups section', () => {
  it('replaces the header popover with rows for All contacts, every group and No group', async () => {
    const mock = setup()
    const { container, section } = await renderPanel(mock)
    expect(container.querySelector('.ct-group-filter-btn')).toBeNull()
    expect(mock.popovers).toHaveLength(0)
    const labels = [...section().querySelectorAll('.ct-groups-row')].map((node) => node.textContent)
    expect(labels).toEqual(['All contacts5', 'fungi2', 'moss1', 'plants1', 'pond1', 'No group1'])
    expect(row('All contacts 5')).toHaveAttribute('aria-pressed', 'true')
    expect(row('moss 1')).toHaveClass('sub')
    expect(section().querySelectorAll('.ct-groups-fold')).toHaveLength(1)
  })

  it('shows one group on a click, everyone on a second click, and toggles exactly the clicked group with Shift or ⌘', async () => {
    const mock = setup()
    const { list } = await renderPanel(mock)
    fireEvent.click(row('plants 1'))
    await waitFor(() => expect(shown(list)).toEqual(['Otter']))
    expect(row('plants 1')).toHaveClass('active')
    expect(row('All contacts 5')).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(row('plants 1'))
    await waitFor(() => expect(shown(list)).toHaveLength(5))

    fireEvent.click(row('plants 1'))
    fireEvent.click(row('pond 1'), { shiftKey: true })
    await waitFor(() => expect(shown(list).sort()).toEqual(['Heron', 'Otter']))
    fireEvent.click(row('No group 1'), { metaKey: true })
    await waitFor(() => expect(shown(list).sort()).toEqual(['Badger', 'Heron', 'Otter']))
    fireEvent.click(row('plants 1'), { shiftKey: true })
    await waitFor(() => expect(shown(list).sort()).toEqual(['Badger', 'Heron']))
    expect(getStore(mock.api).getSnapshot().selectedGroups).toEqual(['pond', UNCATEGORIZED])

    fireEvent.click(row('All contacts 5'))
    await waitFor(() => expect(shown(list)).toHaveLength(5))
  })

  it('lets a group cover its subgroups and folds them under a saved chevron', async () => {
    const mock = setup()
    const { list, section } = await renderPanel(mock)
    fireEvent.click(row('fungi 2'))
    await waitFor(() => expect(shown(list).sort()).toEqual(['Chanterelle', 'Lichen']))
    fireEvent.click(row('moss 1'))
    await waitFor(() => expect(shown(list)).toEqual(['Lichen']))

    fireEvent.click(screen.getByRole('button', { name: 'Hide the subgroups of fungi' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'moss 1' })).toBeNull())
    expect(mock.api.settings.get().collapsedGroups).toEqual(['fungi'])
    fireEvent.click(within(section()).getByRole('button', { name: 'Expand all groups' }))
    await waitFor(() => expect(row('moss 1')).toBeTruthy())
    expect(mock.api.settings.get().collapsedGroups).toEqual([])
    fireEvent.click(within(section()).getByRole('button', { name: 'Collapse all groups' }))
    await waitFor(() => expect(mock.api.settings.get().collapsedGroups).toEqual(['fungi']))
  })

  it('folds the whole section from its title, keeps the selection in view and remembers the fold', async () => {
    const mock = setup()
    const { list, section } = await renderPanel(mock)
    fireEvent.click(row('plants 1'))
    fireEvent.click(row('pond 1'), { shiftKey: true })
    const title = within(section()).getByRole('button', { name: /^Groups/ })
    expect(title).toHaveAttribute('aria-expanded', 'true')
    expect(title).toHaveTextContent('Groups· 2 selected')
    fireEvent.click(title)
    await waitFor(() => expect(section().querySelector('.ct-groups-list')).toBeNull())
    expect(mock.api.settings.get().groupsSectionFolded).toBe(true)
    expect(title).toHaveAttribute('aria-expanded', 'false')
    expect(shown(list).sort()).toEqual(['Heron', 'Otter'])

    cleanup()
    const again = render(React.createElement(Panel))
    const folded = again.container.querySelector('.ct-groups') as HTMLElement
    expect(folded.querySelector('.ct-groups-list')).toBeNull()
    fireEvent.click(within(folded).getByRole('button', { name: 'Show all contacts' }))
    await waitFor(() => expect(again.container.querySelectorAll('.ct-row')).toHaveLength(5))
    expect(within(folded).getByRole('button', { name: /^Groups/ })).toHaveTextContent(/^Groups$/)
    expect(within(folded).queryByRole('button', { name: 'Show all contacts' })).toBeNull()
  })

  it('lists only the kinds that are switched on and hides the section without groups', async () => {
    const mock = setup({ useSharedGroups: false })
    const { section } = await renderPanel(mock)
    expect([...section().querySelectorAll('.ct-groups-label')].map((node) => node.textContent)).toEqual(['All contacts', 'pond', 'No group'])
    await act(async () => { await mock.api.settings.set('useLocalGroups', false) })
    await waitFor(() => expect(section()).toBeNull())
  })

  it('moves with the arrow keys, selects with Enter and toggles with Shift+Enter', async () => {
    const mock = setup()
    const { list } = await renderPanel(mock)
    const all = row('All contacts 5')
    expect(all).toHaveAttribute('tabindex', '0')
    act(() => all.focus())
    fireEvent.keyDown(all, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(row('fungi 2'))
    fireEvent.keyDown(row('fungi 2'), { key: 'ArrowLeft' })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'moss 1' })).toBeNull())
    fireEvent.keyDown(row('fungi 2'), { key: 'ArrowRight' })
    await waitFor(() => expect(row('moss 1')).toBeTruthy())
    fireEvent.keyDown(row('fungi 2'), { key: 'End' })
    expect(document.activeElement).toBe(row('No group 1'))
    fireEvent.keyDown(row('No group 1'), { key: 'Enter' })
    await waitFor(() => expect(shown(list)).toEqual(['Badger']))
    fireEvent.keyDown(row('No group 1'), { key: 'ArrowUp' })
    fireEvent.keyDown(row('pond 1'), { key: 'Enter', shiftKey: true })
    await waitFor(() => expect(shown(list).sort()).toEqual(['Badger', 'Heron']))
    expect(row('pond 1')).toHaveAttribute('tabindex', '0')
  })

  it('saves the selection in the view state and reads a filter saved as hidden groups', async () => {
    const mock = setup()
    await renderPanel(mock)
    const sidebar = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1).find((entry) => entry.extension.surface === 'left_sidebar')!.extension
    fireEvent.click(row('pond 1'))
    await waitFor(() => expect(sidebar.getSnapshot().view).toMatchObject({ groups: ['pond'] }))
    expect(sidebar.getSnapshot().view).not.toHaveProperty('hiddenGroups')
    await act(async () => { await sidebar.restore!({ v: 1, mode: 'detail', groups: ['plants', UNCATEGORIZED] }) })
    expect(getStore(mock.api).getSnapshot().selectedGroups).toEqual(['plants', UNCATEGORIZED])
    await act(async () => { await sidebar.restore!({ v: 1, mode: 'detail', hiddenGroups: ['fungi', 'pond'], hideUngrouped: true }) })
    expect(getStore(mock.api).getSnapshot().selectedGroups).toEqual(['plants'])
    await act(async () => { await sidebar.restore!({ v: 1, mode: 'detail', hiddenGroups: [], hideUngrouped: false }) })
    expect(getStore(mock.api).getSnapshot().selectedGroups).toEqual([])
  })
})
