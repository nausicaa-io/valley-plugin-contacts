import { assetUrlForRelPath } from '@valley/plugin-sdk/fileTypes'
import type { ValleyPluginApi } from '@valley/plugin-sdk'
import { CONTACT_PLACES_LIMITS, CONTACT_PLACES_V1, type ContactPlaceEntry, type ContactPlacesSnapshot } from './contactPlacesContract'
import { getStore } from './store'
import { groupColorFor } from './data'
import { initials } from './util'

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
  const refresh = (): void => {
    const snap = store.getSnapshot()
    if (snap.contacts === last?.contacts && snap.groupConfigs === last.groupConfigs && snap.coverPaths === last.coverPaths) return
    last = snap
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
        places: contact.place.filter((place) => place.value.trim()).slice(0, CONTACT_PLACES_LIMITS.places).map((place) => ({
          ...(place.type ? { label: clip(place.type) } : {}),
          text: clip(place.value.trim()),
          ...(place.place ? { lat: place.place.latitude, lng: place.place.longitude } : {})
        }))
      }
    })
    const next = JSON.stringify(contacts)
    if (next === signature) return
    signature = next
    snapshot = { revision: snapshot.revision + 1, contacts }
    for (const listener of [...listeners]) listener()
  }
  refresh()
  const offStore = store.subscribe(refresh)
  const offExtension = api.interop.extensions.provide(CONTACT_PLACES_V1, {
    id: 'contacts',
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
    offExtension()
    listeners.clear()
  }
}
