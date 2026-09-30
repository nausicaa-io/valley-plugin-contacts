import * as React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WORKSPACE_DETAILS_V1 } from '@valley/plugin-sdk'
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
    await waitFor(() => expect(mock.api.vault.writeTextDocumentGuarded).toHaveBeenCalled(), { timeout: 2000 })
    expect(vi.mocked(mock.api.vault.writeTextDocumentGuarded).mock.calls.at(-1)?.[1]).toContain('Edited in the full contact form')
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
