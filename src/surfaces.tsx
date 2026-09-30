import { provideBookmarkSurface, type PluginSurfaceSnapshot, type UiMenuItem, type ValleyPluginApi } from '@valley/plugin-sdk'
import type { PluginLinkState } from '@valley/plugin-sdk/paths'
import { React, api } from './runtime'
import { getStore } from './store'
import { getContactIndex } from './indexOwner'
import { loadContacts } from './store'
import { Pencil } from './icons'
import { setContactMode } from './contactView'
import { uiText } from './localization'
import type { InteropValueSchema } from '@valley/plugin-sdk'

const bookmarkStateSchema = {
  "type": "object",
  "properties": {
    "v": {
      "type": "literal",
      "value": 1
    },
    "mode": {
      "type": "union",
      "anyOf": [
        {
          "type": "literal",
          "value": "graph"
        },
        {
          "type": "literal",
          "value": "detail"
        }
      ]
    },
    "hiddenGroups": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "maxItems": 512
    },
    "hideUngrouped": {
      "type": "boolean"
    },
    "path": {
      "type": "string"
    }
  },
  "required": [
    "v",
    "mode",
    "hiddenGroups",
    "hideUngrouped"
  ],
  "additionalProperties": false
} satisfies InteropValueSchema



function actionState(owner = api): { items: UiMenuItem[] | null; listeners: Set<() => void> } {
  return owner.runtime.getOrCreate('contacts.surfaceActions', () => ({ items: null, listeners: new Set() }))
}

export function setContactSurfaceActions(items: UiMenuItem[] | null): void {
  actionState().items = items
  for (const listener of actionState().listeners) listener()
}

function subscribe(owner: ValleyPluginApi, listener: () => void): () => void {
  const listeners = actionState(owner).listeners
  listeners.add(listener)
  const off = getStore(owner).subscribe(listener)
  return () => { listeners.delete(listener); off() }
}

function snapshot(api: ValleyPluginApi, instanceId?: string): PluginSurfaceSnapshot {
  const store = getStore(api)
  const current = store.getSnapshot()
  if (instanceId?.toLowerCase().endsWith('.vcf')) {
    const contact = current.contacts.find(entry => entry.relPath === instanceId)
    return { title: contact?.displayName || instanceId.split('/').pop()!, filePath: instanceId, view: { v: 1, mode: 'detail', hiddenGroups: [], hideUngrouped: false, path: instanceId } }
  }
  const contact = current.mode === 'graph' || current.mode === 'create' ? undefined : current.contacts.find((entry) => entry.relPath === current.selectedPath)
  const view = { v: 1, mode: current.mode === 'graph' ? 'graph' : 'detail', hiddenGroups: current.hiddenGroups, hideUngrouped: current.hideUngrouped }
  return {
    title: uiText('manifest.name'),
    view,
    ...(contact ? { filePath: contact.relPath, item: { id: contact.relPath, title: contact.displayName, state: { ...view, path: contact.relPath } } } : {}),
    navigation: { canGoBack: current.canGoBack, canGoForward: current.canGoForward, goBack: store.goBack, goForward: store.goForward },
    actions: (actionState(api).items ?? (contact ? [
      { id: 'edit', label: uiText('auto.5301648dcf6b'), icon: <Pencil />, onSelect: () => { if (contact) { api.workspace.openMainTab(); setContactMode(contact.relPath, 'editing', api) } } }
    ] : [])).map((item) => item.id === 'edit' ? { ...item, onSelect: () => { if (contact) { api.workspace.openMainTab(); setContactMode(contact.relPath, 'editing', api) } } } : item)
  }
}

async function restore(owner: ValleyPluginApi, state: PluginLinkState, _instanceId?: string, options?: { background?: boolean }): Promise<void> {
  if (state.v !== 1) throw new Error('Unsupported Contacts bookmark.')
  if (_instanceId?.toLowerCase().endsWith('.vcf') && state.path === _instanceId) {
    if (!await owner.vault.fileInfo(_instanceId)) throw new Error(uiText('contacts.error.missing'))
    if (!options?.background) await owner.workspace.openFile(_instanceId)
    return
  }
  const store = getStore(owner)
  await store.ready()
  if (typeof state.path === 'string') {
    const indexed = getContactIndex(owner).read().some((entry) => entry.relPath === state.path)
    if (!(await owner.vault.fileInfo(state.path)) || (indexed && !loadContacts(owner).some((contact) => contact.relPath === state.path))) throw new Error(uiText('contacts.error.missing'))
    store.openContact(state.path, { reveal: !options?.background })
  } else if (state.mode === 'graph') store.showGraph()
  else store.showList()
  store.setGroupFilter(Array.isArray(state.hiddenGroups) ? state.hiddenGroups.filter((value): value is string => typeof value === 'string') : [], state.hideUngrouped === true)
}

export function registerContactSurfaces(pluginApi: ValleyPluginApi): () => void {
  const offSurfaces = (['main_workspace', 'left_sidebar'] as const).map((surface) => provideBookmarkSurface(pluginApi, {
    id: `contacts.${surface}`, surface, getSnapshot: instanceId => snapshot(pluginApi, surface === 'main_workspace' ? instanceId : undefined), subscribe: listener => subscribe(pluginApi, listener), restore: (state, instanceId, options) => restore(pluginApi, state, instanceId, options)
  }, { stateSchema: bookmarkStateSchema, itemStateSchema: { ...bookmarkStateSchema, required: [...bookmarkStateSchema.required, "path"] }, description: (snapshot, item) => typeof snapshot.view.path === 'string' && snapshot.view.path ? snapshot.view.path : uiText(item ? 'bookmark.item' : 'bookmark.view') }))
  return () => { offSurfaces.forEach((off) => off()) }
}
