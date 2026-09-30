import { assetUrlForRelPath } from '@valley/plugin-sdk/fileTypes'
import { CONTACTS_DIRECTORY_V1, CONTACTS_DIRECTORY_REVISION_V1, type ContactDirectoryEntry, type ValleyPluginApi } from '@valley/plugin-sdk'
import { getStore } from './store'

export function registerDirectory(api: ValleyPluginApi): () => Promise<void> {
  const store = getStore(api)
  let entries: ContactDirectoryEntry[] = []
  let byEmail = new Map<string, ContactDirectoryEntry[]>()
  let signature = ''
  let revision = 0
  let disposed = false
  let disposal: Promise<void> | undefined
  let assetRequest: Promise<void> | null = null
  const pendingAssets = new Set<string>()
  let coversSignature = ''
  let coverVersions = new Map<string, string>()
  let lastSnapshot: ReturnType<typeof store.getSnapshot> | null = null
  let lastVersions: Map<string, string> | null = null
  const coverPaths = (): string[] => [...new Set(Object.values(store.getSnapshot().coverPaths).filter((path): path is string => Boolean(path)))]
  const refreshAssets = (paths: readonly string[]): void => {
    if (disposed) return
    for (const path of paths) pendingAssets.add(path)
    if (assetRequest || pendingAssets.size === 0) return
    const pending = (async () => {
      while (!disposed && pendingAssets.size > 0) {
        const batch = [...pendingAssets]
        pendingAssets.clear()
        let next = 0
        await Promise.all(Array.from({ length: Math.min(4, batch.length) }, async () => {
          while (!disposed && next < batch.length) {
            const path = batch[next++]
            const info = await api.vault.fileInfo(path).catch(() => null)
            if (!disposed && !pendingAssets.has(path)) coverVersions.set(path, info ? `${info.mtimeMs}:${info.size}` : 'missing')
          }
        }))
      }
      if (disposed) return
      const current = new Set(coverPaths())
      coverVersions = new Map([...coverVersions].filter(([path]) => current.has(path)))
      refresh()
    })().finally(() => { if (assetRequest === pending) assetRequest = null })
    assetRequest = pending
  }
  const refresh = (): void => {
    if (disposed) return
    const snap = store.getSnapshot()
    if (snap.contacts === lastSnapshot?.contacts && snap.coverPaths === lastSnapshot.coverPaths && coverVersions === lastVersions) return
    lastSnapshot = snap
    lastVersions = coverVersions
    const nextCovers = JSON.stringify(snap.coverPaths)
    if (coversSignature !== nextCovers) { coversSignature = nextCovers; refreshAssets(coverPaths()) }
    const next = snap.contacts.map((contact) => ({
      id: contact.relPath,
      displayName: contact.displayName,
      emails: contact.email.map((email) => ({ address: email.value.trim(), label: email.type })),
      photo: contact.photo,
      cover: snap.coverPaths[contact.relPath] ?? null,
      coverVersion: coverVersions.get(snap.coverPaths[contact.relPath] ?? '') ?? ''
    }))
    const nextSignature = JSON.stringify(next)
    if (nextSignature === signature) return
    signature = nextSignature
    revision++
    entries = next.map(({ cover, photo, coverVersion: _coverVersion, ...entry }) => ({
      ...entry,
      ...(cover ? { avatarUrl: `${assetUrlForRelPath(cover)}?v=${revision}` } : photo ? { avatarUrl: photo } : {})
    }))
    byEmail = new Map()
    for (const entry of entries) {
      for (const email of entry.emails) {
        const key = email.address.toLowerCase()
        const matches = byEmail.get(key) ?? []
        if (!matches.includes(entry)) matches.push(entry)
        byEmail.set(key, matches)
      }
    }
    api.interop.state.publish(CONTACTS_DIRECTORY_REVISION_V1, revision)
  }
  refresh()
  const offStore = store.subscribe(refresh)
  const offFiles = api.vault.onChanged((info) => {
    refreshAssets(coverPaths().filter((path) => info.full || info.changes.some((change) => change.relPath === path || path.startsWith(`${change.relPath}/`))))
  })
  const offService = api.interop.services.provide(CONTACTS_DIRECTORY_V1, {
    search: async (query, limit) => {
      await store.ready()
      if (disposed) throw new Error('Contacts directory was disposed')
      const q = query.trim().toLocaleLowerCase()
      if (!q) return []
      return entries.filter((entry) => [entry.displayName, ...entry.emails.map((email) => email.address)]
        .some((value) => value.toLocaleLowerCase().includes(q))).slice(0, limit)
    },
    resolveEmails: async (addresses) => {
      await store.ready()
      if (disposed) throw new Error('Contacts directory was disposed')
      return addresses.map((address) => ({ address, contacts: byEmail.get(address.trim().toLowerCase()) ?? [] }))
    },
    open: async (contactId, options) => {
      await store.ready()
      if (disposed) throw new Error('Contacts directory was disposed')
      if (!entries.some((entry) => entry.id === contactId)) throw new Error('Contact is no longer available.')
      store.openContact(contactId, options)
    }
  })
  return () => {
    if (disposal) return disposal
    disposed = true
    pendingAssets.clear()
    offFiles()
    offStore()
    offService()
    api.interop.state.publish(CONTACTS_DIRECTORY_REVISION_V1, null)
    disposal = assetRequest ?? Promise.resolve()
    return disposal
  }
}
