import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import config from '../config.json'

describe('vault permission', () => {
  it('declares storage.vault for the backend vault API it uses', () => {
    const backend = readFileSync(join(process.cwd(), 'src/backend/index.ts'), 'utf8')
    expect(backend).toMatch(/\.api\.vault\./)
    expect((config as { permissions?: { storage?: { vault?: boolean } } }).permissions?.storage?.vault).toBe(true)
  })
})
