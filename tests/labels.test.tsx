import * as React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { initRuntime } from '../src/runtime'
import { disposeStore } from '../src/store'
import { Settings } from '../src/Settings'
import { ContactForm } from '../src/ContactForm'
import { DEFAULT_CONTACT_LABELS, getSettings } from '../src/data'
import { emptyContact } from '../src/schema'
import type { ContactLabels } from '../src/types'
import { refreshContactIcons } from '../src/contactIcons'
import { getStore } from '../src/store'
import { cardRealm } from './cards'

declare const CONTACT_ICON_SVGS: Record<string, string>

async function setup(labels?: Partial<ContactLabels>): Promise<ReturnType<typeof createMockValleyApi>> {
  const mock = createMockValleyApi({
    manifest: { id: 'contacts' },
    realm: { path: '/mock/realm', name: 'mock', displayName: 'mock' },
    settings: labels ? { contactsRoot: 'Meadow/Orbit', labels } : { contactsRoot: 'Meadow/Orbit' }
  })
  mock.api.backend.call = vi.fn(async () => ({ icons: CONTACT_ICON_SVGS })) as never
  initRuntime(mock.api)
  await act(async () => refreshContactIcons(mock.api))
  return mock
}

async function renderSettings(): Promise<void> {
  await act(async () => { render(<Settings section="social" />) })
}

const optionTexts = (select: HTMLElement): string[] => [...(select as HTMLSelectElement).options].map((option) => option.textContent ?? '')

afterEach(() => {
  cleanup()
  disposeStore()
})

describe('label lists', async () => {
  it('start with Family, Work and School in every list, then the usual labels of that kind', async () => {
    await setup()
    const labels = getSettings().labels
    for (const kind of ['phone', 'email', 'place', 'website'] as const) {
      expect(labels[kind].slice(0, 3)).toEqual(['Family', 'Work', 'School'])
      expect(labels[kind].length).toBeGreaterThan(6)
      expect(new Set(labels[kind].map((label) => label.toLowerCase())).size).toBe(labels[kind].length)
    }
    expect(labels.phone).toContain('Mobile')
    expect(labels.place).toContain('Home')
    expect(labels.website).toContain('Blog')
  })

  it('keeps an emptied list empty instead of bringing the defaults back', async () => {
    await setup({ phone: [] })
    expect(getSettings().labels.phone).toEqual([])
    expect(getSettings().labels.email).toEqual([...DEFAULT_CONTACT_LABELS.email])
  })
})

describe('label dropdowns in the contact form', async () => {
  it('offers the phone, email, address and website labels from Settings, in their order', async () => {
    await setup({ phone: ['Family', 'Work', 'Satellite'] })
    render(<ContactForm contact={null} />)

    fireEvent.click(screen.getByRole('button', { name: /Add phone/ }))
    fireEvent.click(screen.getByRole('button', { name: /Add email/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Add website' }))

    const phone = screen.getByRole('combobox', { name: 'Phone label' })
    expect(optionTexts(phone)).toEqual(['Family', 'Work', 'Satellite', 'No label', 'Edit labels…'])
    fireEvent.change(phone, { target: { value: 'Satellite' } })
    expect((phone as HTMLSelectElement).value).toBe('Satellite')

    expect(optionTexts(screen.getByRole('combobox', { name: 'Email label' })).slice(0, 3)).toEqual(['Family', 'Work', 'School'])
    const website = screen.getByRole('combobox', { name: 'Website label' })
    expect(optionTexts(website)).toEqual([...DEFAULT_CONTACT_LABELS.website, 'No label', 'Edit labels…'])
  })

  it('keeps a saved label that is not in the list and matches labels regardless of case', async () => {
    await setup()
    render(<ContactForm contact={{ ...emptyContact(''), phone: [{ value: '+99 1', type: 'Field station' }, { value: '+99 2', type: 'work' }] }} />)
    const [custom, work] = screen.getAllByRole('combobox', { name: 'Phone label' }) as HTMLSelectElement[]
    expect(custom.value).toBe('Field station')
    expect(optionTexts(custom)).toContain('Field station')
    expect(work.value).toBe('Work')
    expect(optionTexts(work)).not.toContain('work')
  })

  it('opens the Contacts settings from Edit labels… without changing the label', async () => {
    const mock = await setup()
    const open = vi.spyOn(mock.api.workspace, 'openSettings')
    render(<ContactForm contact={{ ...emptyContact(''), email: [{ value: 'a@b.example', type: 'Work' }] }} />)
    const email = screen.getByRole('combobox', { name: 'Email label' }) as HTMLSelectElement
    fireEvent.change(email, { target: { value: '__contacts-edit__' } })
    expect(open).toHaveBeenCalledWith('plugin:contacts#social')
    expect(email.value).toBe('Work')
  })

  it('captions each organization and relation input with what it is for', async () => {
    await setup()
    render(<ContactForm contact={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add organization' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add relation' }))
    for (const name of ['Organization', 'Job title', 'Department', 'Person', 'Relation', 'Role']) expect(screen.getAllByText(name).length).toBeGreaterThan(0)
    expect(screen.getByRole('textbox', { name: 'Job title' })).toHaveAttribute('placeholder', 'e.g. Field coordinator')
    expect(screen.getByRole('combobox', { name: 'Relation' })).toBeTruthy()
  })
})

describe('Labels settings', async () => {
  it('adds, renames, removes and restores labels, and the dropdown follows', async () => {
    const mock = await setup()
    await renderSettings()
    const phoneList = screen.getByRole('list', { name: 'Phone' })

    const draft = within(phoneList).getByRole('textbox', { name: 'New Phone label' })
    fireEvent.change(draft, { target: { value: 'Satellite' } })
    fireEvent.click(within(phoneList).getByRole('button', { name: 'Add Phone label' }))
    expect((mock.api.settings.get().labels as ContactLabels).phone.at(-1)).toBe('Satellite')

    const family = within(phoneList).getByDisplayValue('Family')
    fireEvent.change(family, { target: { value: 'Relatives' } })
    fireEvent.blur(family)
    expect((mock.api.settings.get().labels as ContactLabels).phone[0]).toBe('Relatives')

    fireEvent.click(within(phoneList).getByRole('button', { name: 'Remove Work' }))
    expect((mock.api.settings.get().labels as ContactLabels).phone).not.toContain('Work')

    cleanup()
    render(<ContactForm contact={null} />)
    fireEvent.click(screen.getByRole('button', { name: /Add phone/ }))
    expect(optionTexts(screen.getByRole('combobox', { name: 'Phone label' }))).toEqual(expect.arrayContaining(['Relatives', 'Satellite']))
    cleanup()

    await renderSettings()
    fireEvent.click(within(screen.getByRole('list', { name: 'Phone' })).getByRole('button', { name: 'Restore defaults' }))
    expect((mock.api.settings.get().labels as ContactLabels).phone).toEqual([...DEFAULT_CONTACT_LABELS.phone])
  })

  it('refuses a label that is already in the list', async () => {
    const mock = await setup()
    await renderSettings()
    const emailList = screen.getByRole('list', { name: 'Email' })
    fireEvent.change(within(emailList).getByRole('textbox', { name: 'New Email label' }), { target: { value: 'work' } })
    fireEvent.click(within(emailList).getByRole('button', { name: 'Add Email label' }))
    expect(within(emailList).getByText('That label is already in the list.')).toBeTruthy()
    expect(mock.api.settings.get().labels).toBeUndefined()
  })
})

describe('contact file name', () => {
  it('refuses a name another card of the folder already has, in any case, and shows no save status', async () => {
    const mock = createMockValleyApi({
      manifest: { id: 'contacts' },
      realm: { path: '/mock/realm', name: 'mock', displayName: 'mock' },
      settings: { contactsRoot: 'Meadow/Orbit' },
      ...cardRealm({ 'Meadow/Orbit/Broken.vcf': { firstName: 'Broken' }, 'Meadow/Other/Twin.vcf': { firstName: 'Twin' } })
    })
    mock.api.backend.call = vi.fn(async () => ({ icons: CONTACT_ICON_SVGS })) as never
    initRuntime(mock.api)
    await act(async () => refreshContactIcons(mock.api))
    await act(async () => { await getStore(mock.api).ready() })
    await act(async () => { render(<ContactForm contact={null} />) })
    const input = document.querySelector('.ct-file-name input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'broken' } })
    expect(screen.getByRole('alert')).toHaveTextContent('broken.vcf already exists in this folder')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    fireEvent.change(input, { target: { value: 'Twin' } })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.change(input, { target: { value: 'Broken 2' } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.querySelector('.ct-form-status')).toBeNull()
  })
})

describe('social row', () => {
  it('shows the chosen platform icon beside its dropdown', async () => {
    await setup()
    render(<ContactForm contact={{ ...emptyContact(''), socialMedia: [{ platform: 'Instagram', handle: 'fern' }] }} />)
    const icon = document.querySelector('.ct-social-edit-row .ct-social-icon svg, .ct-social-edit-row .ct-social-icon .ct-platform-icon')
    expect(icon).toBeTruthy()
  })
})
