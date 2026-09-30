/**
 * Contacts — an address book over the vault's vCard files (one `.vcf` per
 * person under the configured folder, default `Meadow/Orbit`). The core index
 * lists the files; only changed cards are read. It presents a virtual group
 * tree (ordered `CATEGORIES`, never real folders), a structured contact view
 * with typed relations, and a force-directed relationship graph. Writes,
 * renames and deletes use guarded editor document revisions.
 *
 * Views: `contacts.panel` (left_sidebar), `contacts.page` (main_workspace),
 * `contacts.file` (a `.vcf` opened as a file) and `contacts.settings`.
 * `commands.ts` registers
 * the full `contacts:*` command-bus surface (query/CRUD), driving the palette,
 * terminal CLI, and the assistant agent through the same typed catalog.
 */
import { AGENT_TOOL_PROVIDER_V1, type ValleyPluginApi, type ValleyPluginModule } from '@valley/plugin-sdk'
import { countGroupUsage } from '@valley/plugin-sdk/groups'
import { initRuntime } from './runtime'
import { injectStyles } from './styles'
import { getContactIndex } from './indexOwner'
import { getStore, disposeStore } from './store'
import { registerContactsCommands } from './commands'
import { registerContactsFence } from './fence'
import { Panel } from './Panel'
import { Page } from './Page'
import { Settings } from './Settings'
import { initLocalization } from './localization'
import { contactsAgentTools } from './agentTools'
import { registerDirectory } from './directory'
import { registerContactSurfaces } from './surfaces'
import { ContactFileView } from './FileView'
import { registerContactDetails } from './contactView'
import { initializeContactIcons } from './contactIcons'
import { registerBirthdaySource } from './calendarSource'
import { registerContactSearch } from './search'

export function register(api: ValleyPluginApi): () => Promise<void> {
  initLocalization(api)
  initRuntime(api)
  const disposeStyles = injectStyles()
  // Instantiate the window-anchored store now so the first render has data.
  const store = getStore(api)

  // Tell the host which groups our contacts are in — a group is only deletable
  // once nothing anywhere is in it. A contact in two groups counts in both.
  const pushGroupUsage = (): void => {
    if (getContactIndex(api).getSnapshot().status !== 'ready') return
    api.workspace.reportGroupUsage(
      countGroupUsage(store.getSnapshot().contacts.flatMap((c) => c.groups))
    )
  }
  pushGroupUsage()
  const offGroupUsage = store.subscribe(pushGroupUsage)


  api.registerView('contacts.panel', Panel)
  api.registerView('contacts.page', Page)
  api.registerView('contacts.settings', Settings)
  api.registerView('contacts.file', ContactFileView)

  const offDirectory = registerDirectory(api)
  const offCommands = registerContactsCommands(api)
  const offSurfaces = registerContactSurfaces(api)
  const offDetails = registerContactDetails(api)
  const offIcons = initializeContactIcons(api)
  const offBirthdays = registerBirthdaySource(api)
  const offSearch = registerContactSearch(api)
  const offAgentTools = api.interop.services.provide(AGENT_TOOL_PROVIDER_V1, contactsAgentTools(api))
  const offFence = registerContactsFence()

  let disposal: Promise<void> | undefined
  return () => {
    if (disposal) return disposal
    const directoryDrain = offDirectory()
    const searchDrain = offSearch()
    offCommands()
    offSurfaces()
    offBirthdays()
    offDetails()
    offIcons()
    offAgentTools()
    offFence()
    offGroupUsage()
    api.workspace.reportGroupUsage({})
    disposeStyles()
    disposal = Promise.allSettled([directoryDrain, searchDrain, disposeStore(api, store)]).then(results => {
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })
    return disposal
  }
}

const plugin: ValleyPluginModule = { register }
export default plugin
