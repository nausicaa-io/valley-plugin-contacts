import * as React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { GEO_NAVIGATOR_V1, PLUGIN_SURFACE_V1, type UiMenuItem } from '@valley/plugin-sdk'
import { buildContactFile } from '../src/schema'
import { initRuntime } from '../src/runtime'
import { disposeStore, getStore } from '../src/store'
import { DetailView } from '../src/DetailView'
import { Panel } from '../src/Panel'
import { Page } from '../src/Page'
import { ContactForm, type ContactFormHandle } from '../src/ContactForm'
import { registerContactSurfaces, setContactSurfaceActions } from '../src/surfaces'
import { registerContactsCommands } from '../src/commands'
import { formatContactBirthdate, parseContactDateInput } from '../src/util'
import type { Contact } from '../src/types'
import { cardRealm, contactAt } from './cards'

function setup(
  groups: string[],
  birthdate = '',
  place: Array<{ value: string; type?: string }> = []
): { mock: ReturnType<typeof createMockValleyApi>; contact: Contact } {
  const fields = { firstName: 'Fern', lastName: 'Canopy', groups, birthdate, place, note: 'Original note' }
  const contact = contactAt('Plants/Fern Canopy.vcf', fields)
  const mock = createMockValleyApi({
    manifest: { id: 'contacts' },
    realm: { path: '/mock/realm', name: 'mock', displayName: 'mock' },
    groups: [
      { id: 'fungi', name: 'fungi', color: '#a855f7' },
      { id: 'plants', name: 'plants', color: '#eab308' }
    ],
    settings: {
      contactsRoot: 'Plants',
      lastOpen: { selectedPath: contact.relPath, mode: 'detail' }
    },
    ...cardRealm({ [contact.relPath]: fields })
  })
  initRuntime(mock.api)
  registerContactSurfaces(mock.api)
  registerContactsCommands(mock.api)
  return { mock, contact }
}

function lastSavedContent(mock: ReturnType<typeof createMockValleyApi>): string {
  return vi.mocked(mock.api.realm.editors.saveDocument).mock.calls.at(-1)?.[2] ?? vi.mocked(mock.api.realm.writeTextDocumentGuarded).mock.calls.at(-1)?.[1] ?? ''
}

function setupPanelContacts(): ReturnType<typeof createMockValleyApi> {
  const mock = createMockValleyApi({
    manifest: { id: 'contacts' },
    groups: [
      { id: 'fungi', name: 'fungi', color: '#a855f7' },
      { id: 'moss', name: 'moss', color: '#16a34a' },
      { id: 'plants', name: 'plants', color: '#eab308' }
    ],
    settings: { contactsRoot: 'Meadow/Orbit' },
    ...cardRealm({
      'Meadow/Orbit/Chanterelle.vcf': { firstName: 'Chanterelle', groups: ['fungi'] },
      'Meadow/Orbit/Otter.vcf': { firstName: 'Otter', groups: ['plants'] },
      'Meadow/Orbit/Badger.vcf': { firstName: 'Badger', groups: [] }
    })
  })
  initRuntime(mock.api)
  return mock
}

afterEach(() => {
  cleanup()
  disposeStore()
})

function surfaceActions(mock: ReturnType<typeof createMockValleyApi>): UiMenuItem[] { return mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1)[0].extension.getSnapshot().actions ?? [] }

describe('DetailView group chips', () => {
  it('places Edit in the top bar ⋯ menu, not the group chip row', async () => {
    const { mock } = setup(['fungi'])
    await getStore(mock.api).ready()
    const { container } = render(React.createElement(Page, { navigation: { setController: vi.fn() } }))
    await screen.findByText('Original note')

    const actions = container.querySelector('.ct-page-actions') as HTMLElement
    expect(within(actions).queryByTitle('More actions')).toBeNull()
    expect(surfaceActions(mock).map((item) => item.label)).toContain('Edit')
    expect(within(container.querySelector('.ct-chips') as HTMLElement).queryByRole('button', { name: /edit/i })).toBeNull()
  })

  it('adds a group and preserves the notes', async () => {
    const { mock, contact } = setup(['fungi'])
    await getStore(mock.api).ready()
    render(React.createElement(DetailView, { contact }))
    await screen.findByText('Original note')

    fireEvent.click(screen.getByText('Group').closest('button')!)
    fireEvent.change(screen.getByPlaceholderText('Search group'), { target: { value: 'Plants' } })
    fireEvent.keyDown(screen.getByPlaceholderText('Search group'), { key: 'Enter' })

    await waitFor(() => expect(lastSavedContent(mock)).toContain('CATEGORIES:fungi,plants'))
    expect(lastSavedContent(mock)).toContain('NOTE:Original note')
  })

  it('uses the inline group picker instead of the browser datalist', async () => {
    const { contact } = setup(['fungi'])
    const { container } = render(React.createElement(DetailView, { contact }))
    await screen.findByText('Original note')

    fireEvent.click(screen.getByText('Group').closest('button')!)
    fireEvent.change(screen.getByPlaceholderText('Search group'), { target: { value: 'pla' } })

    expect(container.querySelector('datalist')).toBeNull()
    expect(container.querySelector('.ct-chip-popover')).toBeTruthy()
    expect(within(container.querySelector('.ct-chip-popover') as HTMLElement).getByText('plants')).toBeTruthy()
  })

  it('routes group management to the central Settings page', async () => {
    const { mock, contact } = setup(['fungi'])
    await getStore(mock.api).ready()
    render(React.createElement(DetailView, { contact }))
    await screen.findByText('Original note')

    fireEvent.click(screen.getByText('Group').closest('button')!)
    fireEvent.mouseDown(screen.getByText('Groups'))
    expect(mock.api.workspace.openSettings).toHaveBeenCalledWith('groups')
  })

  it('removes a group and preserves remaining groups', async () => {
    const { mock, contact } = setup(['fungi', 'plants'])
    await getStore(mock.api).ready()
    render(React.createElement(DetailView, { contact }))
    await screen.findByText('Original note')

    fireEvent.click(screen.getAllByTitle('Remove group')[0])

    await waitFor(() => expect(lastSavedContent(mock)).toContain('CATEGORIES:plants\r\n'))
    expect(lastSavedContent(mock)).not.toContain('fungi')
  })

  it('opens addresses in maps without saving contact or map data', async () => {
    const { mock, contact } = setup(['fungi'], '', [{ value: 'Alpine Habitat Field Station', type: 'field' }])
    await getStore(mock.api).ready()
    const open = vi.fn(async () => {})
    mock.api.interop.services.provide(GEO_NAVIGATOR_V1, { open })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      render(React.createElement(DetailView, { contact }))
      await screen.findByText('Original note')

      fireEvent.click(screen.getByRole('button', { name: 'Alpine Habitat Field Station' }))

      await waitFor(() => expect(mock.api.links.open).toHaveBeenCalledWith({ category: 'location', value: 'Alpine Habitat Field Station' }))
      expect(mock.api.realm.writeTextDocumentGuarded).not.toHaveBeenCalled()
      expect(mock.datasets.has('map.places')).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('contact birthdates', () => {
  it('formats birthdates with the preference pattern and age', async () => {
    expect(formatContactBirthdate('2005-06-21', 'dd-mm-yyyy', new Date(2026, 5, 21))).toBe('21-06-2005 (21 y.o)')
    expect(formatContactBirthdate('2005-06-21', 'mm/dd/yyyy', new Date(2026, 5, 20))).toBe('06/21/2005 (20 y.o)')
  })

  it('parses preference-formatted input back to ISO storage', async () => {
    expect(parseContactDateInput('21-06-2005', 'dd-mm-yyyy')).toBe('2005-06-21')
    expect(parseContactDateInput('06/21/2005', 'mm/dd/yyyy')).toBe('2005-06-21')
  })

  it('shows the formatted birthday in detail view', async () => {
    const { contact } = setup(['fungi'], '2005-06-21')
    render(React.createElement(DetailView, { contact }))
    await screen.findByText(/21-06-2005 \(\d+ y\.o\)/)
  })
})

describe('Page ⋯ actions menu', () => {
  /** Open the top-bar menu and return the item carrying `id`. */
  function menuItem(mock: ReturnType<typeof createMockValleyApi>, id: string): UiMenuItem {
    const item = surfaceActions(mock).find((entry) => entry.id === id)
    if (!item) throw new Error(`no '${id}' item in the actions menu`)
    return item
  }

  it('carries the card file actions', async () => {
    const { mock, contact } = setup(['fungi'])
    await getStore(mock.api).ready()
    void mock.api.settings.set('lastOpen', { selectedPath: contact.relPath, mode: 'detail' })
    await act(async () => render(React.createElement(Page, { navigation: { setController: vi.fn() } })))

    expect(surfaceActions(mock).filter((item) => item.type !== 'separator').map((item) => item.label)).toEqual([
      'Edit',
      'Download as .vcf',
      'Reveal in Finder',
      'Open with default app',
      'Copy relative path',
      'Copy absolute path',
      'Copy Valley link',
      'Move to trash'
    ])
  })

  it('routes reveal, open and copy through the host', async () => {
    const clipboard = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } })
    const { mock, contact } = setup(['fungi'])
    await getStore(mock.api).ready()
    void mock.api.settings.set('lastOpen', { selectedPath: contact.relPath, mode: 'detail' })
    await act(async () => render(React.createElement(Page, { navigation: { setController: vi.fn() } })))

    await menuItem(mock, 'reveal').onSelect?.()
    await menuItem(mock, 'open-external').onSelect?.()
    expect(mock.osFileActions).toEqual([
      { action: 'reveal', relPath: contact.relPath },
      { action: 'openWithDefaultApp', relPath: contact.relPath }
    ])

    await menuItem(mock, 'copy-relative').onSelect?.()
    await menuItem(mock, 'copy-absolute').onSelect?.()
    await menuItem(mock, 'copy-link').onSelect?.()
    expect(clipboard.mock.calls.flat()).toEqual([
      contact.relPath,
      `/mock/realm/${contact.relPath}`,
      `valley://open?file=${encodeURIComponent(contact.relPath)}`
    ])
  })

  it('requires the confirmation dialog before trashing a contact', async () => {
    const { mock, contact } = setup(['fungi'])
    await getStore(mock.api).ready()
    void mock.api.settings.set('lastOpen', { selectedPath: contact.relPath, mode: 'detail' })
    await act(async () => render(React.createElement(Page, { navigation: { setController: vi.fn() } })))

    await act(async () => menuItem(mock, 'trash').onSelect?.())
    await waitFor(() => expect(mock.confirmations).toHaveLength(1))
    expect(mock.api.realm.trashTextDocumentGuarded).not.toHaveBeenCalled()

    vi.mocked(mock.api.ui.confirm).mockResolvedValueOnce('delete')
    await act(async () => menuItem(mock, 'trash').onSelect?.())

    await waitFor(() => {
      expect(mock.api.realm.trashTextDocumentGuarded).toHaveBeenCalledWith(contact.relPath, expect.any(String))
    })
    expect(mock.busUndo).toHaveLength(1)
    await mock.busUndo[0].undo()
    expect(await mock.api.realm.readFile(contact.relPath)).toContain('Original note')
  })

  it('keeps a dirty contact and shows the guarded deletion refusal', async () => {
    const { mock, contact } = setup(['fungi'])
    await getStore(mock.api).ready()
    void mock.api.settings.set('lastOpen', { selectedPath: contact.relPath, mode: 'detail' })
    await act(async () => render(React.createElement(Page, { navigation: { setController: vi.fn() } })))
    vi.mocked(mock.api.ui.confirm).mockResolvedValueOnce('delete')
    vi.mocked(mock.api.realm.trashTextDocumentGuarded).mockResolvedValueOnce({ ok: false, reason: 'stale' })
    await act(async () => menuItem(mock, 'trash').onSelect?.())
    expect(await screen.findByRole('alert')).toHaveTextContent('contains unsaved text')
    expect(await mock.api.realm.readFile(contact.relPath)).not.toBe('')
  })
})

describe('Panel group filter layout', () => {
  it('keeps filtering inside the shared search frame without replacing the input', async () => {
    const mock = setupPanelContacts()
    await getStore(mock.api).ready()
    const { container } = render(React.createElement(Panel))
    const input = screen.getByPlaceholderText('Search contacts')
    const frame = input.parentElement!
    expect(frame).toHaveClass('search-field')
    expect(input).toHaveClass('search-field-input')
    expect(frame.querySelector('.search-field-icon')).toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'Otter' } })
    const list = container.querySelector('.ct-list') as HTMLElement
    await waitFor(() => expect(within(list).queryByText('Chanterelle')).not.toBeInTheDocument())
    expect(within(list).getByText('Otter')).toBeInTheDocument()
    fireEvent.change(input, { target: { value: '' } })
    expect(within(list).getByText('Chanterelle')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Search contacts')).toBe(input)
    expect(input.parentElement).toBe(frame)
  })

  it('uses the header group popover to filter several groups', async () => {
    const mock = setupPanelContacts()
    await getStore(mock.api).ready()
    const { container } = render(React.createElement(Panel))
    const list = container.querySelector('.ct-list') as HTMLElement

    expect(container.querySelector('.ct-tree')).toBeNull()
    const filter = screen.getByRole('button', { name: 'Groups' })
    expect(filter).not.toHaveTextContent('3/3')
    expect(within(list).getByText('Chanterelle')).toBeTruthy()
    expect(within(list).getByText('Otter')).toBeTruthy()
    expect(within(list).getByText('Badger')).toBeTruthy()

    fireEvent.click(filter)
    expect(mock.popovers).toHaveLength(1)
    const popover = render(React.createElement(React.Fragment, null, mock.popovers[0].node))
    expect(screen.getByRole('button', { name: 'Deselect all' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'fungi 1' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'moss 0' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'plants 1' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'No group 1' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'fungi 1' })).toHaveClass('active', 'selection-run-start')
    expect(screen.getByRole('button', { name: 'No group 1' })).toHaveClass('active', 'selection-run-end')

    fireEvent.click(screen.getByRole('button', { name: 'plants 1' }))
    await waitFor(() => expect(within(list).queryByText('Otter')).toBeNull())
    expect(within(list).getByText('Chanterelle')).toBeTruthy()
    expect(within(list).getByText('Badger')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Groups' })).toHaveClass('active')

    const fungi = screen.getByRole('button', { name: 'fungi 1' })
    const moss = screen.getByRole('button', { name: 'moss 0' })
    const plants = screen.getByRole('button', { name: 'plants 1' })
    const noGroup = screen.getByRole('button', { name: 'No group 1' })
    expect(fungi).toHaveClass('active', 'selection-run-start')
    expect(fungi).not.toHaveClass('selection-run-end')
    expect(moss).toHaveClass('active', 'selection-run-end')
    expect(moss).not.toHaveClass('selection-run-start')
    expect(plants).not.toHaveClass('active')
    expect(noGroup).toHaveClass('active', 'selection-run-start', 'selection-run-end')

    fireEvent.click(noGroup)
    await waitFor(() => expect(within(list).queryByText('Badger')).toBeNull())
    expect(within(list).getByText('Chanterelle')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    await waitFor(() => expect(within(list).getByText('Otter')).toBeTruthy())
    expect(within(list).getByText('Badger')).toBeTruthy()

    fireEvent.click(within(popover.container).getByRole('button', { name: 'Group' }))
    expect(mock.api.workspace.openSettings).toHaveBeenCalledWith('groups')
  })
})


describe('Contacts surface edit targeting', () => {
  it('describes the selected card across contact view changes', async () => {
    const { mock, contact } = setup([])
    await getStore(mock.api).ready()
    const surfaces = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1)
    expect(surfaces).toHaveLength(2)
    for (const { extension } of surfaces) expect(extension.getSnapshot().filePath).toBe(contact.relPath)
    const store = getStore(mock.api)
    store.showGraph()
    for (const { extension } of surfaces) expect(extension.getSnapshot().filePath).toBeUndefined()
    store.startCreate()
    for (const { extension } of surfaces) expect(extension.getSnapshot().filePath).toBeUndefined()
    store.openContact(contact.relPath)
    for (const { extension } of surfaces) expect(extension.getSnapshot().filePath).toBe(contact.relPath)
    store.showList()
    for (const { extension } of surfaces) expect(extension.getSnapshot().filePath).toBeUndefined()
  })

  it('opens the full contact editor from either surface even when the main page contributes its menu', async () => {
    const { mock } = setup([])
    await getStore(mock.api).ready()
    const show = vi.spyOn(mock.api.workspace, 'openMainTab')
    const providers = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1)
    const sidebar = providers.find((entry) => entry.extension.surface === 'left_sidebar')!.extension
    await sidebar.getSnapshot().actions!.find((item) => item.id === 'edit')!.onSelect!()
    expect(show).toHaveBeenLastCalledWith()
    const mainEdit = vi.fn()
    setContactSurfaceActions([{ id: 'edit', label: 'Edit', onSelect: mainEdit }])
    await sidebar.getSnapshot().actions!.find((item) => item.id === 'edit')!.onSelect!()
    expect(show).toHaveBeenLastCalledWith()
    expect(mainEdit).not.toHaveBeenCalled()
    await providers.find((entry) => entry.extension.surface === 'main_workspace')!.extension.getSnapshot().actions!.find((item) => item.id === 'edit')!.onSelect!()
    expect(show).toHaveBeenLastCalledWith()
    expect(mock.api.workspace.showProperties).not.toHaveBeenCalled()
  })
})

describe('Contact form document revisions', () => {
  it('completes an exact own-save before renaming a filename-only contact draft', async () => {
    const { mock, contact } = setup([])
    await getStore(mock.api).ready()
    const before = await mock.api.realm.readFile(contact.relPath)
    const controlRef = React.createRef<ContactFormHandle>()
    const view = render(<ContactForm contact={contact} controlRef={controlRef} />)
    await screen.findByDisplayValue('Original note')
    fireEvent.change(view.container.querySelector('.ct-file-name input')!, { target: { value: 'Canopy card' } })
    await act(async () => { await controlRef.current!.save() })
    expect(mock.api.realm.editors.saveDocument).toHaveBeenCalledWith(contact.relPath, expect.any(String), before, expect.any(Object), expect.any(String))
    expect(await mock.api.realm.readFile('Plants/Canopy card.vcf')).toBe(before)
    expect(await mock.api.realm.stat(contact.relPath)).toBeNull()
  })

  it('freezes shared logical contact forms and saves through the canonical draft owner from either copy', async () => {
    const { mock, contact } = setup([])
    await getStore(mock.api).ready()
    const first = React.createRef<ContactFormHandle>(), second = React.createRef<ContactFormHandle>()
    const view = render(<><ContactForm contact={contact} controlRef={first} /><ContactForm contact={contact} controlRef={second} /></>)
    await waitFor(() => expect(screen.getAllByDisplayValue('Original note')).toHaveLength(2))
    const registrations = vi.mocked(mock.api.realm.editors.registerDocument).mock.calls
    expect(registrations).toHaveLength(2)
    await waitFor(() => registrations.forEach(([, , provider]) => expect(provider.getSnapshot()).toMatchObject({ dirty: false, readiness: 'ready' })))
    let lease!: Awaited<ReturnType<typeof mock.prepareFileEditors>>
    await act(async () => { lease = await mock.prepareFileEditors(contact.relPath) })
    expect([...view.container.querySelectorAll<HTMLElement>('.ct-form')].every(form => form.inert)).toBe(true)
    fireEvent.change(screen.getAllByDisplayValue('Original note')[0], { target: { value: 'Blocked draft' } })
    expect(screen.queryByDisplayValue('Blocked draft')).toBeNull()
    await lease.validate()
    await act(async () => { await lease.release() })
    fireEvent.change(screen.getAllByDisplayValue('Original note')[0], { target: { value: 'Shared fern draft' } })
    expect(screen.getAllByDisplayValue('Shared fern draft')).toHaveLength(2)
    expect(registrations.map(([, , provider]) => provider.getSnapshot())).toEqual([expect.objectContaining({ dirty: true }), expect.objectContaining({ dirty: false })])
    await expect(mock.api.drivers.files.writeFile(contact.relPath, 'Overwrite')).rejects.toMatchObject({ code: 'DIRTY_EDITOR' })
    await act(async () => { await second.current!.save() })
    expect(mock.api.realm.editors.saveDocument).toHaveBeenCalledWith(contact.relPath, registrations[0][1], expect.stringContaining('NOTE:Shared fern draft'), expect.any(Object), expect.any(String))
    expect(await mock.api.realm.readFile(contact.relPath)).toContain('NOTE:Shared fern draft')
  })

  it('loads editor-owned fields and refuses a direct SDK overwrite of its dirty draft', async () => {
    const { mock, contact } = setup([])
    await getStore(mock.api).ready()
    const draft = buildContactFile({ ...contact, profession: 'Field botanist', note: 'Unsaved observation' })
    await mock.api.realm.writeFile(contact.relPath, draft)
    const controlRef = React.createRef<ContactFormHandle>()
    render(<ContactForm contact={contact} controlRef={controlRef} />)
    await screen.findByDisplayValue('Field botanist')
    const profession = screen.getByDisplayValue('Field botanist')
    fireEvent.change(profession, { target: { value: 'Mycologist' } })
    await expect(mock.api.realm.writeFile(contact.relPath, `${draft}Newer typing\n`)).rejects.toMatchObject({ code: 'DIRTY_EDITOR' })
    expect(await mock.api.realm.readFile(contact.relPath)).toBe(draft)
    await act(async () => controlRef.current!.save())
    expect(mock.api.realm.editors.saveDocument).toHaveBeenCalled()
    expect(screen.getByDisplayValue('Mycologist')).toBeTruthy()
    expect(await mock.api.realm.readFile(contact.relPath)).toContain('ROLE:Mycologist')
  })

  it('does not enable saving after an unreadable document', async () => {
    const { mock, contact } = setup([])
    await getStore(mock.api).ready()
    vi.spyOn(mock.api.realm, 'readTextDocument').mockRejectedValue(new Error('Read failed'))
    const state = vi.fn()
    const controlRef = React.createRef<ContactFormHandle>()
    render(<ContactForm contact={contact} controlRef={controlRef} onActionState={state} />)
    await waitFor(() => expect(mock.api.realm.readTextDocument).toHaveBeenCalled())
    await act(async () => controlRef.current!.save())
    expect(state.mock.calls.at(-1)?.[0].canSave).toBe(false)
    expect(mock.api.realm.writeTextDocumentGuarded).not.toHaveBeenCalled()
  })
})

it.each([false, true])('preserves form edits during initial document loading (remount=%s)', async remount => {
  const { mock, contact } = setup([])
  await getStore(mock.api).ready()
  const read = mock.api.realm.readTextDocument
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(mock.api.realm, 'readTextDocument').mockImplementationOnce(async path => { const snapshot = await read(path); await held; return snapshot })
  const controlRef = React.createRef<ContactFormHandle>()
  const view = render(<ContactForm contact={contact} controlRef={controlRef} />)
  try {
    fireEvent.change(screen.getByDisplayValue('Fern'), { target: { value: 'Moss' } })
    if (remount) { view.unmount(); render(<ContactForm contact={contact} controlRef={controlRef} />) }
    await act(async () => { release(); await held })
    expect(screen.getByDisplayValue('Moss')).toBeTruthy()
    await act(async () => controlRef.current!.save())
    await waitFor(() => expect(mock.api.realm.editors.saveDocument).toHaveBeenCalled())
    if (remount) {
      expect(screen.getByRole('alert')).toBeTruthy()
      expect(await mock.api.realm.readFile(contact.relPath)).toContain('N:Canopy;Fern;;;')
      expect(vi.mocked(mock.api.realm.editors.registerDocument).mock.calls.at(-1)![2].getSnapshot()).toMatchObject({ dirty: true })
    } else {
      await waitFor(async () => expect(await mock.api.realm.readFile('Plants/Moss Canopy.vcf')).toContain('N:Canopy;Moss;;;'))
      expect(await mock.api.realm.stat(contact.relPath)).toBeNull()
    }
  } finally { release() }
})

describe('Contact editor autosave', () => {
  it('saves a field shortly after typing stops, without a Save button', async () => {
    const { mock, contact } = setup(['fungi'])
    await getStore(mock.api).ready()
    render(<ContactForm contact={contact} autosave />)
    await screen.findByDisplayValue('Canopy')
    fireEvent.change(screen.getByDisplayValue('Canopy'), { target: { value: 'Canopy-Moos' } })
    await waitFor(() => expect(lastSavedContent(mock)).toContain('N:Canopy-Moos;Fern;;;'), { timeout: 3000 })
    expect(lastSavedContent(mock)).toContain('NOTE:Original note')
    expect(screen.queryByRole('alert')?.textContent ?? null).toBeNull()
    expect(mock.api.workspace.openMainTab).not.toHaveBeenCalled()
  })

  it('keeps a conflicting draft and offers to reload the card', async () => {
    const { mock, contact } = setup([])
    await getStore(mock.api).ready()
    render(<ContactForm contact={contact} autosave />)
    await screen.findByDisplayValue('Canopy')
    const newer = buildContactFile({ ...contact, profession: 'Changed elsewhere' })
    await act(async () => { await mock.api.realm.writeFile(contact.relPath, newer) })
    fireEvent.change(screen.getByDisplayValue('Canopy'), { target: { value: 'Draft' } })
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy(), { timeout: 3000 })
    expect(screen.getByDisplayValue('Draft')).toBeTruthy()
    expect(await mock.api.realm.readFile(contact.relPath)).toBe(newer)
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(await screen.findByDisplayValue('Changed elsewhere')).toBeTruthy()
    expect(screen.getByDisplayValue('Canopy')).toBeTruthy()
  })
})
