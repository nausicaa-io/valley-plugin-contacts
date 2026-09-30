import type { DatasetBatchOperation, DatasetRecord, ValleyPluginApi } from '@valley/plugin-sdk'
import { getContactIndex } from './indexOwner'
import { getStore } from './store'

type SearchRecord = DatasetRecord & { path: string; name: string; note: string }

export function registerContactSearch(api: ValleyPluginApi): () => Promise<void> {
  const store = getStore(api)
  const index = getContactIndex(api)
  const dataset = api.data.dataset<SearchRecord>('contacts.note_search')
  let disposed = false
  let initialized = false
  let pending = false
  let work: Promise<void> | undefined
  let previous: ReturnType<typeof store.getSnapshot>['contacts'] | undefined
  let saved = new Map<string, SearchRecord>()

  const refresh = (): void => {
    if (disposed) return
    const snapshot = store.getSnapshot()
    if (!snapshot.loaded || snapshot.contacts === previous) return
    pending = true
    if (work) return
    work = (async () => {
      index.assertCurrent()
      if (!initialized) {
        let cursor: string | undefined
        do {
          const page = await dataset.query({ limit: 500, cursor })
          index.assertCurrent()
          if (disposed) return
          for (const row of page.rows) saved.set(row.path, row)
          cursor = page.cursor
        } while (cursor)
        initialized = true
      }
      while (pending && !disposed) {
        pending = false
        index.assertCurrent()
        const contacts = store.getSnapshot().contacts
        const next = new Map(contacts.filter(contact => contact.note.trim()).map(contact => [contact.relPath, {
          path: contact.relPath, name: contact.displayName, note: contact.note
        }]))
        const operations: DatasetBatchOperation[] = []
        for (const path of saved.keys()) if (!next.has(path)) operations.push({ operation: 'delete', key: { path } })
        for (const [path, row] of next) {
          const current = saved.get(path)
          if (!current || current.name !== row.name || current.note !== row.note) operations.push({ operation: 'upsert', values: row })
        }
        for (let offset = 0; offset < operations.length; offset += 500) {
          index.assertCurrent()
          if (disposed) return
          await dataset.batch(operations.slice(offset, offset + 500))
        }
        saved = next
        previous = contacts
      }
    })().catch(error => {
      initialized = false
      saved = new Map()
      pending = false
      if (!disposed) console.error('[contacts] Contact note search could not be refreshed', error)
    }).finally(() => { work = undefined })
  }

  const off = store.subscribe(refresh)
  refresh()
  return async () => {
    disposed = true
    off()
    await work
  }
}
