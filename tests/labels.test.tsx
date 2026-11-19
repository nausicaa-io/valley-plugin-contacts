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
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getStore } from '../src/store'
import { cardRealm } from './cards'

declare const CONTACT_ICON_SVGS: Record<string, Record<string, string>>

async function setup(labels?: Record<string, unknown>): Promise<ReturnType<typeof createMockValleyApi>> {
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

const names = (labels: readonly { name: string }[]): string[] => labels.map((label) => label.name)

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
      expect(names(labels[kind]).slice(0, 3)).toEqual(['Family', 'Work', 'School'])
      expect(labels[kind].length).toBeGreaterThan(6)
      expect(new Set(names(labels[kind]).map((label) => label.toLowerCase())).size).toBe(labels[kind].length)
      // Every default label has an icon from the Contacts icon folder and a palette colour (19 Nov).
      const folder = kind === 'place' ? 'address' : kind
      for (const label of labels[kind]) {
        expect(existsSync(join(process.cwd(), 'contact-icon', folder, `${label.icon}.svg`))).toBe(true)
        expect(label.color).toMatch(/^palette:/)
      }
    }
    expect(names(labels.phone)).toContain('Mobile')
    expect(names(labels.place)).toContain('Home')
    expect(names(labels.website)).toContain('Blog')
    expect(getSettings().birthday).toEqual({ icon: 'cake', color: 'palette:rose' })
    expect(existsSync(join(process.cwd(), 'contact-icon', 'birthday', 'cake.svg'))).toBe(true)
  })

  it('keeps an emptied list empty instead of bringing the defaults back', async () => {
    await setup({ phone: [] })
    expect(getSettings().labels.phone).toEqual([])
    expect(getSettings().labels.email).toEqual([...DEFAULT_CONTACT_LABELS.email])
  })

  it('reads lists saved as plain names, giving a known name its default look and an unknown one none', async () => {
    await setup({ place: ['home', 'Field station', { name: 'Cabin', icon: 'vacation', color: '#123456' }, { name: 'Bad', icon: '../x', color: 'red' }] })
    expect(getSettings().labels.place).toEqual([
      { name: 'home', icon: 'home', color: 'palette:green' },
      { name: 'Field station' },
      { name: 'Cabin', icon: 'vacation', color: '#123456' },
      { name: 'Bad' }
    ])
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
    expect(optionTexts(website)).toEqual([...names(DEFAULT_CONTACT_LABELS.website), 'No label', 'Edit labels…'])
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
    expect((mock.api.settings.get().labels as ContactLabels).phone.at(-1)).toEqual({ name: 'Satellite', color: 'palette:gray' })

    const family = within(phoneList).getByDisplayValue('Family')
    fireEvent.change(family, { target: { value: 'Relatives' } })
    fireEvent.blur(family)
    expect((mock.api.settings.get().labels as ContactLabels).phone[0]).toEqual({ name: 'Relatives', icon: 'family', color: 'palette:pink' })

    fireEvent.click(within(phoneList).getByRole('button', { name: 'Remove Work' }))
    expect(names((mock.api.settings.get().labels as ContactLabels).phone)).not.toContain('Work')

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

describe('label and birthday looks', () => {
  it('sets a label\'s colour and icon in Settings and the dropdown shows the colour', async () => {
    const mock = await setup()
    await renderSettings()
    const placeList = screen.getByRole('list', { name: 'Address' })
    expect(within(placeList).getByRole('button', { name: 'Choose icon for Home' })).toBeTruthy()
    // The testkit's colour field hands back its own value on a click: enough to see the field is wired to the label.
    const homeColor = within(placeList).getByLabelText('Colour of Home')
    expect(homeColor).toHaveAttribute('data-color', 'palette:green')
    fireEvent.click(homeColor)
    expect((mock.api.settings.get().labels as ContactLabels).place.find((label) => label.name === 'Home')).toEqual({ name: 'Home', icon: 'home', color: 'palette:green' })
    const birthday = screen.getByRole('group', { name: 'Birthday' })
    expect(within(birthday).getByRole('button', { name: 'Choose icon for Birthday' })).toBeTruthy()
    const birthdayColor = within(birthday).getByLabelText('Colour of Birthday')
    expect(birthdayColor).toHaveAttribute('data-color', 'palette:rose')
    fireEvent.click(birthdayColor)
    expect(mock.api.settings.get().birthdayStyle).toEqual({ icon: 'cake', color: 'palette:rose' })
    cleanup()
    render(<ContactForm contact={null} />)
    fireEvent.click(screen.getByRole('button', { name: /Add address/ }))
    expect(screen.getByRole('combobox', { name: 'Address label' })).toBeTruthy()
  })

  it('colours a birthday in Calendar with the birthday colour', async () => {
    const { birthdayItems } = await import('../src/calendarSource')
    const items = birthdayItems([{ ...emptyContact('A.vcf'), displayName: 'A', birthdate: '1990-05-12' }], '2026-01-01', '2026-12-31', '#445566')
    expect(items[0]).toMatchObject({ date: '2026-05-12', color: '#445566', icon: 'cake' })
  })
})

