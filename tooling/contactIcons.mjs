import { readdirSync, readFileSync } from 'node:fs'

/** The bundled icons by folder (social-media, phone, email, address, website, birthday) and name (19 Nov). */
export function contactIconDefinitions() {
  const root = new URL('../contact-icon/', import.meta.url)
  const folders = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !/claude/i.test(entry.name)).map((entry) => entry.name).sort()
  const icons = Object.fromEntries(folders.map((folder) => {
    const directory = new URL(`${folder}/`, root)
    return [folder, Object.fromEntries(readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !/claude/i.test(entry.name) && entry.name.endsWith('.svg'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => [entry.name.slice(0, -4), readFileSync(new URL(entry.name, directory), 'utf8')]))]
  }))
  return { CONTACT_ICON_SVGS: JSON.stringify(icons) }
}

/** The declaration in `src/backend/icons.ts` the bundle replaces with the icons; a test keeps the two equal. */
export const CONTACT_ICON_DECLARATION = 'declare const CONTACT_ICON_SVGS: Record<string, Record<string, string>>'

const iconPlugin = {
  name: 'contact-icons',
  setup(build) {
    build.onLoad({ filter: /[/\\]src[/\\]backend[/\\]icons\.ts$/ }, ({ path }) => ({
      contents: readFileSync(path, 'utf8').replace(
        CONTACT_ICON_DECLARATION,
        `const CONTACT_ICON_SVGS = ${contactIconDefinitions().CONTACT_ICON_SVGS}`
      ),
      loader: 'ts'
    }))
  }
}

// The bundled icons are seeded by the backend into .valley/assets/icons/contact-icon/<folder>/.
export default () => ({ backendOptions: { plugins: [iconPlugin] } })
