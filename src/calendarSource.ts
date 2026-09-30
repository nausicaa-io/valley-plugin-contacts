import {
  CALENDAR_ITEM_SOURCE_REVISION_V1,
  CALENDAR_ITEM_SOURCE_V2,
  type CalendarItemSourceV2,
  type CalendarSourceItem,
  type ValleyPluginApi
} from '@valley/plugin-sdk'
import type { Contact } from './types'
import { getStore } from './store'
import { uiText } from './localization'
import { setContactMode } from './contactView'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/** Month and day of a birthday (`YYYY-MM-DD` or yearless `--MM-DD`). */
function birthdayParts(value: string): { year?: number; month: number; day: number } | null {
  const full = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const partial = /^--(\d{2})-(\d{2})$/.exec(value)
  const [year, month, day] = full ? [Number(full[1]), Number(full[2]), Number(full[3])] : partial ? [undefined, Number(partial[1]), Number(partial[2])] : []
  if (!month || !day || month > 12 || day > 31) return null
  return { ...(year ? { year } : {}), month, day }
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** Every birthday occurrence inside an inclusive `YYYY-MM-DD` range, sorted. */
export function birthdayItems(contacts: readonly Contact[], startDate: string, endDate: string): CalendarSourceItem[] {
  if (!ISO_DATE.test(startDate) || !ISO_DATE.test(endDate) || startDate > endDate) return []
  const firstYear = Number(startDate.slice(0, 4))
  const lastYear = Number(endDate.slice(0, 4))
  const items: CalendarSourceItem[] = []
  for (const contact of contacts) {
    const parts = birthdayParts(contact.birthdate)
    if (!parts) continue
    for (let year = firstYear; year <= lastYear; year++) {
      if (parts.year && year < parts.year) continue
      // A 29 February birthday is marked on 28 February in common years.
      const day = parts.month === 2 && parts.day === 29 && !isLeapYear(year) ? 28 : parts.day
      const date = `${year}-${pad(parts.month)}-${pad(day)}`
      if (date < startDate || date > endDate) continue
      const age = parts.year ? year - parts.year : undefined
      items.push({
        id: `${year}|${contact.relPath}`,
        title: uiText('contacts.calendar.birthday', { p0: contact.displayName }),
        date,
        filePath: contact.relPath,
        icon: 'cake',
        readOnly: true,
        ...(contact.groups[0] ? { group: contact.groups[0] } : {}),
        ...(age !== undefined ? { note: `${uiText('contacts.calendar.age')} ${age}` } : {})
      })
    }
  }
  return items.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
}

/** Offer contact birthdays to calendars through the shared item-source contract. */
export function registerBirthdaySource(api: ValleyPluginApi): () => void {
  const store = getStore(api)
  const session = crypto.randomUUID()
  let revision = 0
  let signature = ''
  let active = true
  const currentRevision = (): string => `${session}:${revision}`
  const source: CalendarItemSourceV2 = {
    integration: {
      name: 'Contacts',
      version: '3.0.0',
      author: 'nausicaa',
      description: "Shows contact birthdays as yearly, all-day entries in Calendar and its agenda. Open an entry to view the contact.",
      localized: {
        de: { name: 'Kontakte', description: "Zeigt Geburtstage von Kontakten als jährliche, ganztägige Einträge im Kalender und in der Agenda. Öffne einen Eintrag, um den Kontakt anzuzeigen." },
        es: { name: 'Contactos', description: "Muestra los cumpleaños de los contactos como entradas anuales de todo el día en Calendario y su agenda. Abre una entrada para ver el contacto." },
        fr: { name: 'Contacts', description: "Affiche les anniversaires des contacts chaque année sur une journée entière dans Calendrier et son agenda. Ouvrez une entrée pour voir le contact." },
        'zh-CN': { name: '联系人', description: "将联系人生日显示为日历及其日程中每年重复的全天条目。打开条目即可查看联系人。" }
      }
    },
    list: async ({ startDate, endDate, limit, cursor }) => {
      await store.ready()
      if (!active) throw new Error('Calendar source was disposed.')
      let offset = 0
      if (cursor) {
        let previous: { startDate?: unknown; endDate?: unknown; limit?: unknown; revision?: unknown; offset?: unknown }
        try { previous = JSON.parse(cursor) } catch { throw new Error('Invalid Calendar source cursor.') }
        if (previous.startDate !== startDate || previous.endDate !== endDate || previous.limit !== limit || previous.revision !== currentRevision() || typeof previous.offset !== 'number') throw new Error('Calendar source cursor is stale or belongs to another range.')
        offset = previous.offset
      }
      const all = birthdayItems(store.getSnapshot().contacts, startDate, endDate)
      const items = all.slice(offset, offset + limit)
      const next = offset + items.length
      const published = currentRevision()
      return { items, revision: published, ...(next < all.length ? { cursor: JSON.stringify({ startDate, endDate, limit, revision: published, offset: next }) } : {}) }
    },
    open: async (itemId) => {
      const relPath = itemId.slice(itemId.indexOf('|') + 1)
      await store.ready()
      if (store.getSnapshot().contacts.some((contact) => contact.relPath === relPath)) store.openContact(relPath)
    },
    actions: async (itemId) => {
      await store.ready()
      const relPath = itemId.slice(itemId.indexOf('|') + 1)
      return store.getSnapshot().contacts.some(contact => contact.relPath === relPath)
        ? [{ id: 'edit', label: uiText('auto.5301648dcf6b'), icon: 'edit' }] : []
    },
    runAction: async (itemId, actionId) => {
      if (actionId !== 'edit') return false
      await store.ready()
      const relPath = itemId.slice(itemId.indexOf('|') + 1)
      if (!store.getSnapshot().contacts.some(contact => contact.relPath === relPath)) return false
      store.openContact(relPath)
      setContactMode(relPath, 'editing', api)
      return true
    },
    configure: () => api.workspace.openOwnSettings()
  }
  const refresh = (): void => {
    const next = JSON.stringify(store.getSnapshot().contacts.filter((contact) => contact.birthdate).map((contact) => [contact.relPath, contact.displayName, contact.birthdate, contact.groups[0] ?? '']))
    if (next === signature) return
    signature = next
    revision++
    api.interop.state.publish(CALENDAR_ITEM_SOURCE_REVISION_V1, revision)
  }
  refresh()
  const offStore = store.subscribe(refresh)
  const offLanguage = api.ui.onLanguageChanged(() => { revision++; api.interop.state.publish(CALENDAR_ITEM_SOURCE_REVISION_V1, revision) })
  const offSource = api.interop.services.provide(CALENDAR_ITEM_SOURCE_V2, source)
  return () => {
    active = false
    offStore()
    offLanguage()
    offSource()
    api.interop.state.publish(CALENDAR_ITEM_SOURCE_REVISION_V1, null)
  }
}
