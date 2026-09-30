import { definePluginTests } from '@valley/plugin-tools/vitest'
import { contactIconDefinitions } from './tooling/contactIcons.mjs'
export default { ...definePluginTests(), define: contactIconDefinitions() }
