import type { ValleyPluginApi } from '@valley/plugin-sdk'
import { React, api as runtimeApi } from './runtime'
import type { Contact, ContactGroup, GroupNode } from './types'
import { getContactIndex } from './indexOwner'
import { ALL, UNCATEGORIZED, createContactProjection, getSettings } from './data'

/** Persisted "what was open" shape, saved invisibly under the `lastOpen` setting key. */
interface LastOpen {
  selectedPath: string | null
  mode: ContactsMode
}

interface ContactsHistoryEntry {
  selectedPath: string | null
  mode: ContactsMode
}

function readLastOpen(api: ValleyPluginApi): LastOpen {
  const raw = api.settings.get().lastOpen as Partial<LastOpen> | undefined
  const mode: ContactsMode = raw?.mode === 'graph' ? 'graph' : 'detail'
  const selectedPath = typeof raw?.selectedPath === 'string' ? raw.selectedPath : null
  return { selectedPath, mode }
}

/** Which main-workspace view the Page shows. */
export type ContactsMode = 'detail' | 'edit' | 'create' | 'graph'

export interface ContactsSnapshot {
  contacts: Contact[]
  groupTree: GroupNode[]
  groupConfigs: ContactGroup[]
  coverPaths: Record<string, string | null>
  hiddenGroups: string[]
  hideUngrouped: boolean
  selectedPath: string | null
  mode: ContactsMode
  canGoBack: boolean
  canGoForward: boolean
  /** Every contact card has been read (the list is complete). */
  loaded: boolean
  /** Bumped when a relevant projection or presentation input changes. */
  rev: number
}

interface ContactsStore {
  getSnapshot(): ContactsSnapshot
  subscribe(listener: () => void): () => void
  setGroupFilter(hiddenGroups: string[], hideUngrouped: boolean): void
  openContact(relPath: string, options?: { persist?: boolean; newTab?: boolean; reveal?: boolean }): void
  startCreate(): void
  startEdit(): void
  cancelEdit(): void
  showList(): void
  showGraph(options?: { persist?: boolean }): void
  goBack(): void
  goForward(): void
  ready(): Promise<void>
  dispose(): Promise<void>
}

const STORE_KEY = 'contacts.store'
const HISTORY_LIMIT = 20
/** How long a just-written path may be missing from the index before it counts as gone. */
const PENDING_PATH_MS = 5000

function sameHistoryEntry(a: ContactsHistoryEntry | undefined, b: ContactsHistoryEntry): boolean {
  return Boolean(a && a.selectedPath === b.selectedPath && a.mode === b.mode)
}

/** The same contact under a new path (file name and its name fallback follow). */
function renamedContact(contact: Contact, relPath: string): Contact {
  const fileName = (relPath.split('/').pop() ?? relPath).replace(/\.vcf$/i, '')
  const full = [contact.firstName, contact.middleName, contact.lastName].filter(Boolean).join(' ')
  return { ...contact, relPath, fileName, displayName: contact.nickname || full || (contact.displayName !== contact.fileName ? contact.displayName : '') || fileName }
}

function createStore(api: ValleyPluginApi, onDispose: () => void): ContactsStore {
  const index = getContactIndex(api)
  // Card reads finish asynchronously; each completed batch reloads the store.
  const projection = createContactProjection(api, undefined, () => reload())
  let settledWaiters: Array<{ resolve(): void; reject(error: Error): void }> = []
  const settleWaiters = (): void => {
    if (!settledWaiters.length || index.getSnapshot().status !== 'ready' || !projection.settled()) return
    const waiters = settledWaiters
    settledWaiters = []
    for (const waiter of waiters) waiter.resolve()
  }
  const listeners = new Set<() => void>()
  const lastOpen = readLastOpen(api)
  let history: ContactsHistoryEntry[] = [{ selectedPath: lastOpen.selectedPath, mode: lastOpen.mode }]
  let historyIndex = 0
  const historyFlags = (): Pick<ContactsSnapshot, 'canGoBack' | 'canGoForward'> => ({
    canGoBack: historyIndex > 0,
    canGoForward: historyIndex < history.length - 1
  })
  let snap: ContactsSnapshot = {
    contacts: [],
    groupTree: [],
    groupConfigs: [],
    coverPaths: {},
    hiddenGroups: [],
    hideUngrouped: false,
    selectedPath: lastOpen.selectedPath,
    mode: lastOpen.mode,
    loaded: false,
    ...historyFlags(),
    rev: 0
  }

  const emit = (): void => {
    for (const l of listeners) l()
  }
  /**
   * A path the store expects the index to catch up to (a contact just saved or
   * renamed). Cleared once it shows up, or after PENDING_PATH_MS so a genuinely
   * deleted contact still releases the selection.
   */
  let pendingPath: string | null = null
  let pendingTimer: number | null = null
  let settingsTimer: number | null = null
  let disposed = false
  let disposal: Promise<void> | undefined
  let vault = api.getState().vault?.path
  const settingsKey = (): string => {
    const settings = api.settings.get()
    return JSON.stringify([settings.contactsRoot, settings.socials])
  }
  let lastSettingsKey = settingsKey()
  /** A rename the vault index has not applied yet (see `applyPendingRename`). */
  let pendingRename: { from: string; to: string; input?: Contact[]; output?: Contact[] } | null = null
  /**
   * Serve a just-renamed contact under its new path while the index still lists
   * the old one. Dropped as soon as the index has the new path (or lost both).
   */
  const applyPendingRename = (contacts: Contact[]): Contact[] => {
    if (!pendingRename) return contacts
    if (pendingRename.input === contacts && pendingRename.output) return pendingRename.output
    const { from, to } = pendingRename
    if (contacts.some((c) => c.relPath === to)) {
      pendingRename = null
      return contacts
    }
    const stale = contacts.find((c) => c.relPath === from)
    if (!stale) {
      pendingRename = null
      return contacts
    }
    pendingRename.input = contacts
    pendingRename.output = contacts.map((c) => (c.relPath === from ? renamedContact(c, to) : c))
    return pendingRename.output
  }
  const expectPath = (relPath: string | null): void => {
    pendingPath = relPath
    if (pendingTimer !== null) window.clearTimeout(pendingTimer)
    pendingTimer = relPath === null ? null : window.setTimeout(() => {
      pendingPath = null
      pendingTimer = null
      reload()
    }, PENDING_PATH_MS)
  }
  // Only "detail" (a contact open) and "graph" are persisted — "create"/"edit"
  // are transient and always reopen into the detail view.
  const persistLastOpen = (): void => {
    if (snap.mode !== 'detail' && snap.mode !== 'graph') return
    void api.settings.set('lastOpen', { selectedPath: snap.selectedPath, mode: snap.mode })
  }
  const syncTabTitle = (): void => {
    const name = snap.mode === 'detail' && snap.selectedPath
      ? snap.contacts.find((c) => c.relPath === snap.selectedPath)?.displayName ?? null
      : null
    api.workspace.setMainTabTitle(name)
  }
  const pushHistory = (entry: ContactsHistoryEntry): void => {
    if (sameHistoryEntry(history[historyIndex], entry)) return
    const base = history.slice(0, historyIndex + 1)
    history = [...base, entry].slice(-HISTORY_LIMIT)
    historyIndex = history.length - 1
  }
  const set = (
    patch: Partial<ContactsSnapshot>,
    opts: { pushHistory?: boolean; persist?: boolean } = {}
  ): void => {
    index.assertCurrent()
    const next = { ...snap, ...patch }
    if (opts.pushHistory !== false) pushHistory({ selectedPath: next.selectedPath, mode: next.mode })
    snap = { ...next, ...historyFlags() }
    emit()
    syncTabTitle()
    if (opts.persist !== false) persistLastOpen()
  }
  const goHistory = (delta: -1 | 1): void => {
    index.assertCurrent()
    const nextIndex = historyIndex + delta
    if (nextIndex < 0 || nextIndex >= history.length) return
    historyIndex = nextIndex
    const entry = history[historyIndex]
    snap = {
      ...snap,
      selectedPath: entry.selectedPath,
      mode: entry.mode,
      ...historyFlags()
    }
    emit()
    syncTabTitle()
    persistLastOpen()
  }

  const reload = (force = false): void => {
    if (disposed) return
    if (vault !== api.getState().vault?.path) {
      vault = api.getState().vault?.path
      pendingPath = null
      pendingRename = null
      if (pendingTimer !== null) window.clearTimeout(pendingTimer)
      if (settingsTimer !== null) window.clearTimeout(settingsTimer)
      pendingTimer = null
      settingsTimer = null
    }
    if (index.getSnapshot().status !== 'ready') return
    try { index.assertCurrent() } catch { return }
    const settingsChanged = lastSettingsKey !== settingsKey()
    lastSettingsKey = settingsKey()
    const settings = getSettings(api)
    const projected = projection.contacts(settings)
    // Publish a membership change only once every changed card was read, so
    // views never see a list with some contacts missing mid-refresh.
    if (!projection.settled()) return
    const contacts = applyPendingRename(projected)
    const { groupTree, groupConfigs } = projection.groups(contacts, settings.groups)
    const coverPaths = projection.covers(contacts)
    // Drop selection if the contact disappeared (deleted/renamed). During the
    // first reloads, keep the saved selection until the scoped snapshot is
    // complete, including an authoritatively empty vault.
    const indexReady = index.getSnapshot().status === 'ready' && projection.settled()
    const present = Boolean(snap.selectedPath && contacts.some((c) => c.relPath === snap.selectedPath))
    if (present && pendingPath === snap.selectedPath) pendingPath = null
    // A just-saved/renamed path is not in the index yet — hold the selection
    // instead of clearing it (and persisting `lastOpen: null`) for that window.
    const selectedPath = !indexReady || present || pendingPath === snap.selectedPath
      ? snap.selectedPath
      : null
    const availableGroups = new Set(groupTree.filter((group) => group.id !== ALL).map((group) => group.id))
    const hiddenGroups = snap.hiddenGroups.filter((group) => availableGroups.has(group))
    const hideUngrouped = groupTree.some((group) => group.id === UNCATEGORIZED) && snap.hideUngrouped
    // Capture before reassigning snap: reload only changes the persisted selection
    // when the open contact disappeared (deleted/renamed).
    const selectionChanged = selectedPath !== snap.selectedPath
    if (!force && !settingsChanged && !selectionChanged && contacts === snap.contacts && groupTree === snap.groupTree && groupConfigs === snap.groupConfigs && coverPaths === snap.coverPaths && hiddenGroups.length === snap.hiddenGroups.length && hideUngrouped === snap.hideUngrouped && indexReady === snap.loaded) {
      settleWaiters()
      return
    }
    snap = {
      ...snap,
      contacts,
      groupTree,
      groupConfigs,
      coverPaths,
      hiddenGroups,
      hideUngrouped,
      selectedPath,
      loaded: indexReady,
      ...historyFlags(),
      rev: snap.rev + 1
    }
    emit()
    settleWaiters()
    syncTabTitle()
    // Persist ONLY when reload actually changed the selection. Writing here
    // unconditionally notifies scoped settings subscribers on every write,
    // which would call onSettingsChanged → reload in an unbounded
    // feedback loop (~800 reloads/sec) that pinned the CPU and ran the app hot.
    // Only persist when the selection was actively cleared (contact deleted/renamed),
    // not when contacts haven't loaded yet (would overwrite the saved path with null).
    if (selectionChanged && indexReady) persistLastOpen()
  }

  const offState = api.subscribeState(['groups', 'templateFolder', 'vault'], ({ revision }) => {
    if (revision > 0) reload()
  })
  const offIndex = index.subscribe(() => reload())
  const offLanguage = api.ui.onLanguageChanged(() => reload(true))
  const onSettingsChanged = (): void => {
    if (settingsKey() === lastSettingsKey || settingsTimer !== null) return
    settingsTimer = window.setTimeout(() => {
      settingsTimer = null
      if (settingsKey() !== lastSettingsKey) reload()
    }, 30)
  }
  const offSettings = api.settings.subscribe(onSettingsChanged)
  /**
   * Follow a contact note that moved — our own rename, or one from the file tree.
   * `reload` keeps serving the entry under its new path until the vault index
   * catches up, so neither the list nor the open contact flickers.
   */
  const offRenamed = api.files.onRenamed(({ oldPath, newPath }) => {
    try { index.assertCurrent() } catch { return }
    const known = snap.contacts.some((c) => c.relPath === oldPath)
    if (!known && snap.selectedPath !== oldPath && !history.some((h) => h.selectedPath === oldPath)) return
    history = history.map((h) => (h.selectedPath === oldPath ? { ...h, selectedPath: newPath } : h))
    pendingRename = { from: oldPath, to: newPath }
    if (snap.selectedPath === oldPath) {
      expectPath(newPath)
      // Through `set`, so the persisted `lastOpen` follows the file too.
      set({ selectedPath: newPath }, { pushHistory: false })
    }
    reload()
  })
  reload()

  return {
    getSnapshot: () => snap,
    ready: async () => {
      await index.ready()
      index.assertCurrent()
      reload()
      if (projection.settled()) return
      await new Promise<void>((resolve, reject) => { settledWaiters.push({ resolve, reject }) })
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setGroupFilter: (hiddenGroups, hideUngrouped) => set({ hiddenGroups, hideUngrouped }, { pushHistory: false }),
    openContact: (relPath, options) => {
      index.assertCurrent()
      // Only a path the index has not got yet needs holding (a fresh save/rename).
      if (!snap.contacts.some((c) => c.relPath === relPath)) expectPath(relPath)
      set({ selectedPath: relPath, mode: 'detail' }, { persist: options?.persist })
      if (options?.reveal !== false) api.workspace.openMainTab({ newTab: options?.newTab })
    },
    startCreate: () => set({ selectedPath: null, mode: 'create' }),
    startEdit: () => set({ mode: 'edit' }),
    cancelEdit: () => set({ mode: 'detail' }),
    showList: () => set({ selectedPath: null, mode: 'detail' }),
    showGraph: (options) => set({ mode: 'graph' }, { persist: options?.persist }),
    goBack: () => goHistory(-1),
    goForward: () => goHistory(1),
    dispose: () => {
      if (disposal) return disposal
      disposed = true
      onDispose()
      for (const waiter of settledWaiters.splice(0)) waiter.reject(new Error('Contacts store was disposed'))
      offIndex()
      offState()
      offLanguage()
      offRenamed()
      if (pendingTimer !== null) window.clearTimeout(pendingTimer)
      if (settingsTimer !== null) window.clearTimeout(settingsTimer)
      offSettings()
      listeners.clear()
      projection.dispose()
      disposal = index.dispose()
      return disposal
    }
  }
}

interface ContactsRuntime {
  current: ContactsStore | null
  api?: ValleyPluginApi
}

function runtime(api: ValleyPluginApi): ContactsRuntime {
  return api.runtime.getOrCreate(STORE_KEY, () => ({ current: null }))
}

/** Get (or lazily create) the owner-scoped store so both views share state. */
export function getStore(api: ValleyPluginApi): ContactsStore {
  const holder = runtime(api)
  if (holder.api !== api) {
    void holder.current?.dispose().catch(() => {})
    holder.current = null
    holder.api = api
  }
  if (!holder.current) {
    const store = createStore(api, () => { if (holder.current === store) holder.current = null })
    holder.current = store
  }
  return holder.current
}

export function disposeStore(api = runtimeApi, expected?: ContactsStore): Promise<void> {
  if (expected) return expected.dispose()
  const holder = runtime(api)
  const store = (holder.api === api ? holder.current : null)
  if (holder.current === store) holder.current = null
  return store?.dispose() ?? Promise.resolve()
}

/** The current contact list (complete once `getStore(owner).ready()` resolved). */
export function loadContacts(owner = runtimeApi): Contact[] {
  return getStore(owner).getSnapshot().contacts
}

/** Subscribe a view to the shared store. */
export function useContacts(api: ValleyPluginApi): ContactsSnapshot {
  const store = getStore(api)
  return React.useSyncExternalStore(store.subscribe, store.getSnapshot)
}
