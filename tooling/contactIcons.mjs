import { readdirSync, readFileSync } from 'node:fs'

export function contactIconDefinitions() {
  const directory = new URL('../contact-icon/', import.meta.url)
  const icons = Object.fromEntries(readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !/claude/i.test(entry.name) && entry.name.endsWith('.svg'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => [entry.name.slice(0, -4), readFileSync(new URL(entry.name, directory), 'utf8')]))
  return { CONTACT_ICON_SVGS: JSON.stringify(icons) }
}

export default () => ({
  plugins: [{
    name: 'contact-icons',
    setup(build) {
      build.onLoad({ filter: /[/\\]src[/\\]contactIcons\.tsx$/ }, ({ path }) => ({
        contents: readFileSync(path, 'utf8').replace(
          'declare const CONTACT_ICON_SVGS: Record<string, string>',
          `const CONTACT_ICON_SVGS = ${contactIconDefinitions().CONTACT_ICON_SVGS}`
        ),
        loader: 'tsx'
      }))
    }
  }]
})
