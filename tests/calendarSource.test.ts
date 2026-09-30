import { afterEach, describe, expect, it } from 'vitest'
import { CALENDAR_ITEM_SOURCE_REVISION_V1, CALENDAR_ITEM_SOURCE_V2, type CalendarItemSourcePage } from '@valley/plugin-sdk'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { initRuntime } from '../src/runtime'
import { disposeStore, getStore } from '../src/store'
import { birthdayItems, registerBirthdaySource } from '../src/calendarSource'
import { registerContactDetails } from '../src/contactView'
import { WORKSPACE_DETAILS_V1 } from '@valley/plugin-sdk'
import { cardAt, cardVault, contactAt, fileEntry } from './cards'

let off: (() => void) | undefined
afterEach(async () => {
  if (!off) return
  off()
  off = undefined
  await disposeStore()
})

describe('birthdayItems', () => {
  const fern = contactAt('Meadow/Fern.vcf', { firstName: 'Fern', birthdate: '1990-05-12', groups: ['plants'] })
  const leap = contactAt('Meadow/Leap.vcf', { firstName: 'Leap', birthdate: '2000-02-29' })
  const yearless = contactAt('Meadow/Moss.vcf', { firstName: 'Moss', birthdate: '--12-31' })
  const vague = contactAt('Meadow/Oak.vcf', { firstName: 'Oak', birthdate: 'circa 1800' })

  it('repeats birthdays yearly inside the range with the age at that birthday', () => {
    const items = birthdayItems([fern, leap, yearless, vague], '2025-01-01', '2026-12-31')
    expect(items.map((item) => [item.date, item.title])).toEqual([
      ['2025-02-28', 'Birthday: Leap'],
      ['2025-05-12', 'Birthday: Fern'],
      ['2025-12-31', 'Birthday: Moss'],
      ['2026-02-28', 'Birthday: Leap'],
      ['2026-05-12', 'Birthday: Fern'],
      ['2026-12-31', 'Birthday: Moss']
    ])
    expect(items[1]).toMatchObject({ icon: 'cake', readOnly: true, group: 'plants', filePath: 'Meadow/Fern.vcf', note: 'Age 35' })
    expect(items[4].note).toBe('Age 36')
    expect(items[2].note).toBeUndefined()
    expect(items.every(item => item.fields === undefined)).toBe(true)
    expect(birthdayItems([leap], '2028-02-01', '2028-03-01').map((item) => item.date)).toEqual(['2028-02-29'])
  })

  it('never lists birthdays before the birth year or outside the range', () => {
    expect(birthdayItems([fern], '1980-01-01', '1990-05-11')).toEqual([])
    expect(birthdayItems([fern], '2026-06-01', '2026-05-01')).toEqual([])
  })
})

describe('registerBirthdaySource', () => {
  it('pages birthdays with range-bound cursors and republishes its revision on changes', async () => {
    const cards = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`Meadow/Orbit/P${index}.vcf`, { firstName: `P${index}`, birthdate: `1990-0${index + 1}-10` }]))
    const mock = createMockValleyApi({ manifest: { id: 'contacts' }, settings: { contactsRoot: 'Meadow/Orbit' }, ...cardVault(cards) })
    initRuntime(mock.api)
    off = registerBirthdaySource(mock.api)
    await getStore(mock.api).ready()
    const source = mock.api.interop.services.providers(CALENDAR_ITEM_SOURCE_V2)[0]
    const list = async (cursor?: string) => {
      const result = await source.invoke('list', [{ startDate: '2026-01-01', endDate: '2026-12-31', limit: 2, ...(cursor ? { cursor } : {}) }])
      if (!result.ok) throw new Error(result.error.message)
      return result.value as CalendarItemSourcePage
    }
    const first = await list()
    const second = await list(first.cursor)
    const third = await list(second.cursor)
    expect([...first.items, ...second.items, ...third.items].map((item) => item.title)).toEqual(['Birthday: P0', 'Birthday: P1', 'Birthday: P2', 'Birthday: P3', 'Birthday: P4'])
    expect(third.cursor).toBeUndefined()
    const revision = mock.api.interop.state.get(CALENDAR_ITEM_SOURCE_REVISION_V1)!
    const content = cardAt('Meadow/Orbit/P0.vcf', { firstName: 'P0', birthdate: '1990-03-03' })
    await mock.api.vault.writeFile('Meadow/Orbit/P0.vcf', content)
    mock.emitState({ indexEntries: mock.api.getState().indexEntries.map((entry) => entry.relPath === 'Meadow/Orbit/P0.vcf' ? fileEntry(entry.relPath, content, 9) : entry) })
    await expect.poll(() => mock.api.interop.state.get(CALENDAR_ITEM_SOURCE_REVISION_V1)).toBeGreaterThan(revision)
    expect((await source.invoke('list', [{ startDate: '2026-01-01', endDate: '2026-12-31', limit: 2, cursor: first.cursor }])).ok).toBe(false)
    await source.invoke('open', ['2026|Meadow/Orbit/P1.vcf'])
    expect(getStore(mock.api).getSnapshot().selectedPath).toBe('Meadow/Orbit/P1.vcf')
    expect(await source.invoke('actions', ['2026|Meadow/Orbit/P1.vcf'])).toMatchObject({ ok: true, value: [{ id: 'edit' }] })
    const offDetails = registerContactDetails(mock.api)
    expect(await source.invoke('runAction', ['2026|Meadow/Orbit/P2.vcf', 'edit'])).toMatchObject({ ok: true, value: true })
    expect(getStore(mock.api).getSnapshot().selectedPath).toBe('Meadow/Orbit/P2.vcf')
    const details = mock.api.interop.extensions.providers(WORKSPACE_DETAILS_V1)[0].extension
    expect(details.getSnapshot({ filePath: 'Meadow/Orbit/P2.vcf', selectedItemIds: [] }).items.view).toMatchObject({ value: 'editing' })
    expect(await source.invoke('runAction', ['2026|Meadow/Orbit/Missing.vcf', 'edit'])).toMatchObject({ ok: true, value: false })
    offDetails()
  })
})
