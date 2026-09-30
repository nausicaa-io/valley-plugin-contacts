import { createIndexObserver, type ValleyPluginApi } from '@valley/plugin-sdk'
import { IMAGE_EXTENSIONS } from '@valley/plugin-sdk/fileTypes'
import { CONTACT_EXTENSION } from './schema'

function createOwner(api: ValleyPluginApi, retired: Promise<void> | undefined, onDispose: (pending: Promise<void>) => void) {
  // Contact cards plus images (covers resolve by file name). Card contents are
  // read by the loader, only for files whose size or modification time moved.
  const index = createIndexObserver(api, { extensions: [CONTACT_EXTENSION, ...IMAGE_EXTENSIONS], fields: ['mtimeMs', 'size'] })
  const root = api.getState().vault?.path
  let active = true
  let revoked = false
  let disposal: Promise<void> | undefined
  let waiting: { promise: Promise<void>; resolve(): void; reject(error: Error): void } | undefined
  const assertCurrent = (): void => {
    if (!active || revoked || api.getState().vault?.path !== root) throw new Error('Contacts index owner was revoked')
  }
  const rejectWaiting = (error: Error): void => { waiting?.reject(error); waiting = undefined }
  const offVault = api.subscribeState(['vault'], ({ state }) => {
    if (state.vault?.path === root) return
    revoked = true
    rejectWaiting(new Error('Contacts index owner was revoked'))
  })
  const offIndex = index.subscribe(() => {
    if (!active || revoked) return
    const snapshot = index.getSnapshot()
    if (snapshot.status === 'ready') { waiting?.resolve(); waiting = undefined }
    else if (snapshot.status === 'error') rejectWaiting(new Error(snapshot.error ?? 'Contacts index is unavailable'))
  })
  return {
    api,
    getSnapshot: index.getSnapshot,
    subscribe: index.subscribe,
    assertCurrent,
    read() {
      assertCurrent()
      const snapshot = index.getSnapshot()
      if (snapshot.status !== 'ready') throw new Error(snapshot.error ?? 'Contacts index is loading')
      return snapshot.entries
    },
    ready(): Promise<void> {
      try { assertCurrent() } catch (error) { return Promise.reject(error) }
      const snapshot = index.getSnapshot()
      if (snapshot.status === 'ready') return Promise.resolve()
      if (snapshot.status === 'error') return Promise.reject(new Error(snapshot.error ?? 'Contacts index is unavailable'))
      if (!waiting) {
        let resolve!: () => void
        let reject!: (error: Error) => void
        const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
        waiting = { promise, resolve, reject }
      }
      return waiting.promise
    },
    dispose(): Promise<void> {
      if (disposal) return disposal
      active = false
      offVault(); offIndex()
      rejectWaiting(new Error('Contacts index owner was revoked'))
      disposal = (async () => {
        const results = await Promise.allSettled([index.dispose(), retired])
        const failed = results.find(result => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
      })()
      onDispose(disposal)
      return disposal
    }
  }
}

export type ContactIndex = ReturnType<typeof createOwner>

export function getContactIndex(api: ValleyPluginApi): ContactIndex {
  const holder = api.runtime.getOrCreate<{ current: ContactIndex | null; retiring?: Promise<void> }>('contacts.index', () => ({ current: null }))
  if (holder.current?.api !== api) {
    void holder.current?.dispose().catch(() => {})
    const owner = createOwner(api, holder.retiring, pending => {
      if (holder.current === owner) holder.current = null
      holder.retiring = pending
      void pending.catch(() => {})
    })
    holder.current = owner
  }
  return holder.current
}
