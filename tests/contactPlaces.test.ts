import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { initRuntime } from '../src/runtime'
import { disposeStore, getStore } from '../src/store'
import { CONTACT_PLACES_ICON, registerContactPlaces } from '../src/contactPlaces'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONTACT_PLACES_V1 } from '../src/contactPlacesContract'
import { cardRealm } from './cards'
import { refreshContactIcons } from '../src/contactIcons'

declare const CONTACT_ICON_SVGS: Record<string, Record<string, string>>
import config from '../config.json'

afterEach(() => disposeStore())

describe('contacts.places', () => {
  it('declares the extension and lists every contact with its addresses, coordinates only when picked', async () => {
    expect(config.provides).toContainEqual({ id: 'contacts.places', kind: 'extension', version: '1.0.0' })
    const mock = createMockValleyApi({
      manifest: { id: 'contacts' },
      realm: { path: '/mock/realm', name: 'mock', displayName: 'mock' },
      settings: { contactsRoot: 'People' },
      ...cardRealm({
        'People/Fern.vcf': { firstName: 'Fern', profession: 'Botanist', groups: ['Friends'], photo: 'data:image/jpeg;base64,AAAA',
          place: [{ value: 'Fernweg 1, Mossville', type: 'Home', place: { latitude: 46.95, longitude: 7.44, city: 'Mossville' } }, { value: 'Harbor Lab', type: 'Work' }] },
        'People/Moss.vcf': { firstName: 'Moss' }
      })
    })
    mock.api.backend.call = vi.fn(async () => ({ icons: CONTACT_ICON_SVGS })) as never
    initRuntime(mock.api)
    await refreshContactIcons(mock.api)
    await getStore(mock.api).ready()
    const off = registerContactPlaces(mock.api)
    const [provider] = mock.api.interop.extensions.providers(CONTACT_PLACES_V1)
    expect(provider.extension.icon).toEqual(CONTACT_PLACES_ICON)
    const svg = readFileSync(join(process.cwd(), 'icon.svg'), 'utf8')
    expect(svg).toContain(`viewBox="${CONTACT_PLACES_ICON.viewBox}"`)
    expect(svg).toContain(`d="${CONTACT_PLACES_ICON.path}"`)
    const snapshot = provider.extension.getSnapshot()
    expect(snapshot.contacts.map((entry) => entry.name).sort()).toEqual(['Fern', 'Moss'])
    const fern = snapshot.contacts.find((entry) => entry.name === 'Fern')!
    expect(fern).toMatchObject({ id: 'People/Fern.vcf', initials: 'Fe', subtitle: 'Botanist', groups: ['Friends'] })
    // Each address carries its label's colour and icon markup from Settings → Contacts → Labels (19 Nov).
    expect(fern.places).toEqual([
      { label: 'Home', text: 'Fernweg 1, Mossville', lat: 46.95, lng: 7.44, color: 'palette:green', iconSvg: expect.stringContaining('<svg') },
      { label: 'Work', text: 'Harbor Lab', color: 'palette:blue', iconSvg: expect.stringContaining('<svg') }
    ])
    expect(fern).not.toHaveProperty('avatarUrl')
    expect(snapshot.contacts.find((entry) => entry.name === 'Moss')!.places).toEqual([])
    const open = vi.spyOn(getStore(mock.api), 'openContact')
    await provider.extension.open('People/Fern.vcf', { newTab: true })
    expect(open).toHaveBeenCalledWith('People/Fern.vcf', { newTab: true })
    await expect(provider.extension.open('People/Gone.vcf')).rejects.toThrow()
    off()
    expect(mock.api.interop.extensions.providers(CONTACT_PLACES_V1)).toEqual([])
  })
})
