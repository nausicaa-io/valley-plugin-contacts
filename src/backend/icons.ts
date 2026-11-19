import type { PluginBackendApi } from '@valley/plugin-sdk'

declare const CONTACT_ICON_SVGS: Record<string, Record<string, string>>

/** Realm-relative folder of the Contacts icons, one subfolder per kind (19 Nov); add an SVG there to offer it. */
export const CONTACT_ICON_FOLDER = '.valley/assets/icons/contact-icon'
export const CONTACT_ICON_FOLDERS = ['social-media', 'phone', 'email', 'address', 'website', 'birthday'] as const

/** Icon SVG source by folder and name: the bundled set is seeded once, files the user adds or edits are kept. */
export async function readContactIcons(api: PluginBackendApi): Promise<{ icons: Record<string, Record<string, string>> }> {
  const grant = await api.storage.open({ area: 'metadata', path: 'assets/icons/contact-icon', kind: 'directory', mode: 'write' })
  const location = (path: string) => ({ handle: grant.handle, path })
  const icons: Record<string, Record<string, string>> = {}
  let bytes = 0
  try {
    await api.storage.mkdir(location(''))
    for (const folder of CONTACT_ICON_FOLDERS) {
      await api.storage.mkdir(location(folder))
      const entries = await api.storage.list(location(folder))
      const present = new Set(entries.map((entry) => entry.name))
      const bundled = CONTACT_ICON_SVGS[folder] ?? {}
      for (const [name, svg] of Object.entries(bundled)) {
        if (!present.has(`${name}.svg`)) await api.storage.write(location(`${folder}/${name}.svg`), svg)
      }
      const read: Record<string, string> = { ...bundled }
      for (const entry of entries) {
        if (entry.kind !== 'file' || !/^[^/\\.][^/\\]*\.svg$/i.test(entry.name) || entry.size > 64_000 || bytes + entry.size > 2_000_000) continue
        try { read[entry.name.slice(0, -4)] = await api.storage.read(location(`${folder}/${entry.name}`)); bytes += entry.size } catch { /* skip unreadable */ }
      }
      icons[folder] = read
    }
    return { icons }
  } finally { await api.storage.close(grant.handle).catch(() => {}) }
}
