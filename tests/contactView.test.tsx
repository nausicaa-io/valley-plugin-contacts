import * as React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WORKSPACE_DETAILS_V1, type MountedPluginView } from '@valley/plugin-sdk'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { initRuntime } from '../src/runtime'
import { ContactFileView } from '../src/FileView'
import { registerContactDetails } from '../src/contactView'
import { disposeStore, getStore } from '../src/store'
import { cardVault } from './cards'

const path = 'Elsewhere/Fern.vcf'
function setup() {
  const mock = createMockValleyApi({ manifest: { id: 'contacts' }, settings: { contactsRoot: 'Plants' },
    ...cardVault({ [path]: { firstName: 'Fern', groups: ['Friends'], email: [{ value: 'fern@example.test' }], phone: [{ value: '+41 123' }], birthdate: '--06-21', note: 'Original' } }) })
  vi.spyOn(mock.api, 'getState').mockReturnValue({ ...mock.api.getState(), activePath: path })
  initRuntime(mock.api)
  registerContactDetails(mock.api)
  const details = mock.api.interop.extensions.providers(WORKSPACE_DETAILS_V1)[0].extension
  return { mock, details }
}
afterEach(() => { cleanup(); disposeStore() })

describe('contact reader and full editor', () => {
  it('saves a shared contact draft through its exact mounted owner while preserving the second copy', async () => {
    const { mock, details } = setup()
    await getStore(mock.api).ready()
    const identity = (id: string): MountedPluginView => ({ mountId: `contact-${id}`, generation: 1, area: 'main', paneId: `pane-${id}`, tabId: id, filePath: path, pluginId: 'contacts' })
    const first = identity('first'), second = identity('second')
    const view = render(<><ContactFileView relPath={path} mountedView={first} /><ContactFileView relPath={path} mountedView={second} /></>)
    await screen.findAllByText('Original')
    await act(async () => { details.invoke!({ filePath: path, selectedItemIds: ['view'] }, 'view', 'editing') })
    await waitFor(() => expect(view.container.querySelectorAll('textarea.ct-notes-editor')).toHaveLength(2))
    const notes = view.container.querySelectorAll('textarea.ct-notes-editor')
    fireEvent.change(notes[0], { target: { value: 'Shared mounted fern draft' } })
    expect(notes[1]).toHaveValue('Shared mounted fern draft')
    await expect(mock.api.vault.writeFile(path, 'Overwrite')).rejects.toMatchObject({ code: 'DIRTY_EDITOR' })
    await waitFor(async () => expect(await mock.api.vault.readFile(path)).toContain('NOTE:Shared mounted fern draft'), { timeout: 2000 })
    expect(mock.api.vault.editors.save).toHaveBeenCalledWith(first, expect.stringContaining('NOTE:Shared mounted fern draft'), expect.any(Object), expect.any(String))
    view.rerender(<><ContactFileView relPath={path} mountedView={{ ...first }} /><ContactFileView relPath={path} mountedView={{ ...second }} /></>)
    expect(mock.api.vault.editors.register).toHaveBeenCalledTimes(2)
  })

  it('toggles with Command-E and saves pending edits after returning to Reading', async () => {
    const { mock, details } = setup()
    await getStore(mock.api).ready()
    const { container } = render(<ContactFileView relPath={path} />)
    await screen.findByText('Original')
    fireEvent.keyDown(window, { key: 'e', metaKey: true })
    await waitFor(() => expect(container.querySelector('.ct-form')).toBeTruthy())
    const notes = container.querySelector('textarea.ct-notes-editor')!
    fireEvent.change(notes, { target: { value: 'Edited in the full contact form' } })
    fireEvent.keyDown(window, { key: 'e', metaKey: true })
    expect(container.querySelector('.ct-form')!.parentElement).toHaveAttribute('hidden')
    await waitFor(() => expect(mock.api.vault.editors.saveDocument).toHaveBeenCalled(), { timeout: 2000 })
    expect(vi.mocked(mock.api.vault.editors.saveDocument).mock.calls.at(-1)?.[2]).toContain('Edited in the full contact form')
    expect(details.getSnapshot({ filePath: path, selectedItemIds: ['view'] }).items.view.value).toBe('reading')
  })

  it('uses footer mode choices and shows fields for contacts outside the configured folder', async () => {
    const { details } = setup()
    const { container } = render(<ContactFileView relPath={path} />)
    await screen.findByText('Original')
    const context = { filePath: path, selectedItemIds: ['view', 'name', 'groups', 'email', 'phone', 'birthday'] }
    expect(details.getSnapshot(context).items).toMatchObject({ name: { text: 'Fern' }, groups: { text: 'Friends' }, email: { text: 'fern@example.test' }, phone: { text: '+41 123' } })
    expect(details.getSnapshot(context).items.birthday.text).toBeTruthy()
    await act(async () => details.invoke!(context, 'view', 'editing'))
    expect(container.querySelector('.ct-form')).toBeVisible()
    expect(container.querySelector('.ct-form-compact')).toBeNull()
    expect(container.querySelector('.ct-contact-content')).toHaveFocus()
    fireEvent.keyDown(window, { key: 'E', ctrlKey: true, shiftKey: true })
    expect(container.querySelector('.ct-form')).toBeVisible()
    fireEvent.keyDown(window, { key: 'e', ctrlKey: true })
    expect(container.querySelector('.ct-form')).not.toBeVisible()
    await act(async () => details.invoke!(context, 'view', 'editing'))
    expect(container.querySelector('.ct-form')).toBeVisible()
  })

  it('does not toggle a background contact when another file is active', async () => {
    const { mock } = setup()
    vi.mocked(mock.api.getState).mockReturnValue({ ...mock.api.getState(), activePath: 'Note.md' })
    const { container } = render(<ContactFileView relPath={path} />)
    await screen.findByText('Original')
    fireEvent.keyDown(window, { key: 'e', metaKey: true })
    expect(container.querySelector('.ct-form')).toBeNull()
  })
})
