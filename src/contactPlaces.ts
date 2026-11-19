import { assetUrlForRelPath } from '@valley/plugin-sdk/fileTypes'
import type { ValleyPluginApi } from '@valley/plugin-sdk'
import { CONTACT_PLACES_LIMITS, CONTACT_PLACES_V1, type ContactPlaceEntry, type ContactPlacesSnapshot } from './contactPlacesContract'
import { getStore } from './store'
import { getSettings, groupColorFor, labelEntry } from './data'
import { contactIconSvg, subscribeContactIcons } from './contactIcons'
import { initials } from './util'

/** The plugin's own icon (`icon.svg`) as one path, for Map's Contacts tab; a test keeps the two equal. */
export const CONTACT_PLACES_ICON = { viewBox: '0 0 512 512', path: 'M256 48C148.5 48 60.1 129.5 49.2 234.1c-.8 7.2-1.2 14.5-1.2 21.9 0 7.4.4 14.7 1.2 21.9C60.1 382.5 148.5 464 256 464c114.9 0 208-93.1 208-208S370.9 48 256 48zm135.8 326.1c-22.7-8.6-59.5-21.2-82.4-28-2.4-.7-2.7-.9-2.7-10.7 0-8.1 3.3-16.3 6.6-23.3 3.6-7.5 7.7-20.2 9.2-31.6 4.2-4.9 10-14.5 13.6-32.9 3.2-16.2 1.7-22.1-.4-27.6-.2-.6-.5-1.2-.6-1.7-.8-3.8.3-23.5 3.1-38.8 1.9-10.5-.5-32.8-14.9-51.3-9.1-11.7-26.6-26-58.5-28h-17.5c-31.4 2-48.8 16.3-58 28-14.5 18.5-16.9 40.8-15 51.3 2.8 15.3 3.9 35 3.1 38.8-.2.7-.4 1.2-.6 1.8-2.1 5.5-3.7 11.4-.4 27.6 3.7 18.4 9.4 28 13.6 32.9 1.5 11.4 5.7 24 9.2 31.6 2.6 5.5 3.8 13 3.8 23.6 0 9.9-.4 10-2.6 10.7-23.7 7-58.9 19.4-80 27.8C91.6 341.4 76 299.9 76 256c0-48.1 18.7-93.3 52.7-127.3S207.9 76 256 76c48.1 0 93.3 18.7 127.3 52.7S436 207.9 436 256c0 43.9-15.6 85.4-44.2 118.1z' }

/**
 * Provides `contacts.places` (18 Nov): every contact, with or without an address, so a map can list them
 * all and show where they live. A picked address carries its coordinates; a typed one only its text,
 * which the map locates itself. Embedded photos stay out (too large to send); a realm cover goes as its URL.
 */
export function registerContactPlaces(api: ValleyPluginApi): () => void {
  const store = getStore(api)
  const listeners = new Set<() => void>()
  let snapshot: ContactPlacesSnapshot = { revision: 0, contacts: [] }
  let signature = ''
  let last: ReturnType<typeof store.getSnapshot> | null = null
  const clip = (text: string): string => text.slice(0, CONTACT_PLACES_LIMITS.text)
  const refresh = (force = false): void => {
    const snap = store.getSnapshot()
    if (!force && snap.contacts === last?.contacts && snap.groupConfigs === last.groupConfigs && snap.coverPaths === last.coverPaths) return
    last = snap
    const labels = getSettings(api).labels
    const contacts: ContactPlaceEntry[] = snap.contacts.slice(0, CONTACT_PLACES_LIMITS.contacts).map((contact) => {
      const cover = snap.coverPaths[contact.relPath]
      const subtitle = contact.profession || contact.organization[0]?.title || contact.organization[0]?.name || ''
      const group = contact.groups[0]
      return {
        id: contact.relPath,
        name: clip(contact.displayName),
        initials: initials(contact.displayName),
        ...(subtitle ? { subtitle: clip(subtitle) } : {}),
        ...(group ? { color: groupColorFor(group, snap.groupConfigs) } : {}),
        ...(cover ? { avatarUrl: assetUrlForRelPath(cover) } : {}),
        groups: contact.groups.map(clip),
        places: contact.place.filter((place) => place.value.trim()).slice(0, CONTACT_PLACES_LIMITS.places).map((place) => {
          // The address wears its label's look from Settings → Contacts → Labels (19 Nov).
          const look = labelEntry(labels, 'place', place.type)
          const svg = contactIconSvg(look?.icon, 'address', api)
          return {
            ...(place.type ? { label: clip(place.type) } : {}),
            text: clip(place.value.trim()),
            ...(place.place ? { lat: place.place.latitude, lng: place.place.longitude } : {}),
            ...(look?.color ? { color: look.color } : {}),
            ...(svg && svg.length <= CONTACT_PLACES_LIMITS.iconSvg ? { iconSvg: svg } : {})
          }
        })
      }
    })
    const next = JSON.stringify(contacts)
    if (next === signature) return
    signature = next
    snapshot = { revision: snapshot.revision + 1, contacts }
    for (const listener of [...listeners]) listener()
  }
  refresh()
  const offStore = store.subscribe(() => refresh())
  const offIcons = subscribeContactIcons(() => refresh(true), api)
  const offSettings = api.settings.subscribe(() => refresh(true))
  const offExtension = api.interop.extensions.provide(CONTACT_PLACES_V1, {
    id: 'contacts',
    icon: CONTACT_PLACES_ICON,
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    open: async (id, options) => {
      await store.ready()
      if (!store.getSnapshot().contacts.some((contact) => contact.relPath === id)) throw new Error('Contact is no longer available.')
      store.openContact(id, options)
    }
  })
  return () => {
    offStore()
    offIcons()
    offSettings()
    offExtension()
    listeners.clear()
  }
}
