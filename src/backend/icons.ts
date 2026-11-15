import type { PluginBackendApi } from '@valley/plugin-sdk'

declare const CONTACT_ICON_SVGS: Record<string, string>

/** Realm-relative folder of the platform icons; add an SVG there to offer it. */
export const CONTACT_ICON_FOLDER = '.valley/assets/icons/contacts-icon'

/** Platform icons as SVG source by name: the bundled set is seeded once, files the user adds or edits are kept. */
export async function readContactIcons(api: PluginBackendApi): Promise<{ icons: Record<string, string> }> {
  const grant = await api.storage.open({ area: 'metadata', path: 'assets/icons/contacts-icon', kind: 'directory', mode: 'write' })
  const location = (path: string) => ({ handle: grant.handle, path })
  try {
    await api.storage.mkdir(location(''))
    const entries = await api.storage.list(location(''))
    const present = new Set(entries.map((entry) => entry.name))
    for (const [name, svg] of Object.entries(CONTACT_ICON_SVGS)) {
      if (!present.has(`${name}.svg`)) await api.storage.write(location(`${name}.svg`), svg)
    }
    const icons: Record<string, string> = { ...CONTACT_ICON_SVGS }
    let bytes = 0
    for (const entry of entries) {
      if (entry.kind !== 'file' || !/^[^/\\.][^/\\]*\.svg$/i.test(entry.name) || entry.size > 64_000 || bytes + entry.size > 2_000_000) continue
      try { icons[entry.name.slice(0, -4)] = await api.storage.read(location(entry.name)); bytes += entry.size } catch { /* skip unreadable */ }
    }
    return { icons }
  } finally { await api.storage.close(grant.handle).catch(() => {}) }
}
