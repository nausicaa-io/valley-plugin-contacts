/**
 * Contacts-only groups beside the app-wide shared groups (Settings → Appearance
 * → Groups), each kind behind its own switch like in To-Do. A Contacts-only
 * group is a plain group edited like a shared one; it can be a subgroup of
 * another Contacts-only group (one level) but never sits under a shared group.
 * Cards store groups by name (`CATEGORIES`); a rename keeps the old name as an
 * alias so cards that still carry it resolve.
 */
import type { ValleyPluginApi } from '@valley/plugin-sdk'
import { groupKey, nestGroups, normalizeGroups } from '@valley/plugin-sdk/groups'
import { React, api } from './runtime'
import type { ContactGroup } from './types'

export const LOCAL_GROUPS_KEY = 'localGroups'
export const USE_SHARED_GROUPS_KEY = 'useSharedGroups'
export const USE_LOCAL_GROUPS_KEY = 'useLocalGroups'
export const SHOW_GROUPS_IN_LIST_KEY = 'showGroupsInList'
export const LOCAL_GROUP_LIMIT = 200
export const LOCAL_GROUP_NAME_MAX = 60
const LOCAL_ID = /^local-[a-z0-9]{1,32}$/

const clean = (value: unknown, max: number): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : ''

export function newLocalGroupId(): string {
  return `local-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export const isLocalGroup = (id: string): boolean => LOCAL_ID.test(id)

/** The shared registry off core state; anything malformed reads as no groups. */
export function getSharedGroups(owner = api): ContactGroup[] {
  return normalizeGroups(owner.getState().groups)
}

/** Valid, uniquely named groups; a name a shared group already uses is dropped, so a name never means two groups. */
export function normalizeLocalGroups(value: unknown, shared: readonly ContactGroup[] = []): ContactGroup[] {
  if (!Array.isArray(value)) return []
  const taken = new Set(shared.flatMap((group) => [group.name, ...(group.aliases ?? [])]).map(groupKey))
  const ids = new Set<string>()
  const out: ContactGroup[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const raw = entry as Record<string, unknown>
    const id = clean(raw.id, 64)
    const name = clean(raw.name, LOCAL_GROUP_NAME_MAX)
    const color = clean(raw.color, 64)
    if (!LOCAL_ID.test(id) || ids.has(id) || !name || taken.has(groupKey(name)) || !color) continue
    const aliases = Array.isArray(raw.aliases)
      ? [...new Set(raw.aliases.map((alias) => clean(alias, LOCAL_GROUP_NAME_MAX)).filter((alias) => alias && groupKey(alias) !== groupKey(name) && !taken.has(groupKey(alias))))].slice(0, 20)
      : []
    ids.add(id)
    taken.add(groupKey(name))
    aliases.forEach((alias) => taken.add(groupKey(alias)))
    const parent = clean(raw.parent, 64)
    out.push({ id, name, color, ...(aliases.length ? { aliases } : {}), ...(LOCAL_ID.test(parent) ? { parent } : {}) })
    if (out.length >= LOCAL_GROUP_LIMIT) break
  }
  return nestGroups(out)
}

export function renameLocalGroup(group: ContactGroup, name: string): ContactGroup {
  const next = clean(name, LOCAL_GROUP_NAME_MAX)
  if (!next || next === group.name) return group
  const aliases = [...new Set([...(group.aliases ?? []), group.name])].filter((alias) => groupKey(alias) !== groupKey(next))
  return { ...group, name: next, ...(aliases.length ? { aliases } : {}) }
}

export function getGroupKinds(owner = api): { shared: boolean; local: boolean } {
  const settings = owner.settings.get()
  return { shared: settings[USE_SHARED_GROUPS_KEY] !== false, local: settings[USE_LOCAL_GROUPS_KEY] !== false }
}

/** Groups just saved, shown until the settings report them, so an edit never waits for the round trip. */
let unsaved: { groups: ContactGroup[] } | null = null
const listeners = new Set<() => void>()
function show(next: typeof unsaved): void {
  unsaved = next
  for (const listener of [...listeners]) listener()
}

export function getLocalGroups(owner = api): ContactGroup[] {
  return unsaved?.groups ?? normalizeLocalGroups(owner.settings.get()[LOCAL_GROUPS_KEY], getSharedGroups(owner))
}

export async function setLocalGroups(groups: ContactGroup[]): Promise<void> {
  const shown = { groups: normalizeLocalGroups(groups, getSharedGroups()) }
  show(shown)
  const settle = (): void => { if (unsaved === shown) show(null) }
  try { await api.settings.set(LOCAL_GROUPS_KEY, shown.groups) } catch (error) { settle(); throw error }
  const done = (): void => { off(); clearTimeout(timer); settle() }
  const off = api.settings.subscribe(done)
  const timer = setTimeout(done, 2000)
}

/** Every shared and Contacts-only group, whatever the switches say: for name checks and a card's saved group colour. */
export function getAllContactGroups(owner = api): ContactGroup[] {
  return [...getSharedGroups(owner), ...getLocalGroups(owner)]
}

/** The groups Contacts offers and lists: each kind only while its switch is on. */
export function getContactGroups(owner = api): ContactGroup[] {
  const kinds = getGroupKinds(owner)
  return [...(kinds.shared ? getSharedGroups(owner) : []), ...(kinds.local ? getLocalGroups(owner) : [])]
}

export function onLocalGroupsShown(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function useOwnerValue<T>(read: (owner: ValleyPluginApi) => T): T {
  const owner = api
  const [value, setValue] = React.useState<T>(() => read(owner))
  React.useEffect(() => {
    const update = (): void => setValue(read(owner))
    const offState = owner.subscribe(update)
    const offSettings = owner.settings.subscribe(update)
    const offShown = onLocalGroupsShown(update)
    return () => { offState(); offSettings(); offShown() }
  }, [owner, read])
  return value
}

export const useLocalGroups = (): ContactGroup[] => useOwnerValue(getLocalGroups)
export const useAllContactGroups = (): ContactGroup[] => useOwnerValue(getAllContactGroups)
export const useGroupKinds = (): { shared: boolean; local: boolean } => useOwnerValue(getGroupKinds)

/** Whether the sidebar list shows each contact's groups as tag chips (on by default). */
export function useShowGroupsInList(): boolean {
  const owner = api
  return React.useSyncExternalStore(
    React.useCallback((listener: () => void) => owner.settings.subscribe(listener), [owner]),
    () => owner.settings.get()[SHOW_GROUPS_IN_LIST_KEY] !== false
  )
}
