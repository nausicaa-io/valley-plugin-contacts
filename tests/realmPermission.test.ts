import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import config from '../config.json'

describe('realm permission', () => {
  it('declares storage.realm for the backend realm API it uses', () => {
    const backend = readFileSync(join(process.cwd(), 'src/backend/index.ts'), 'utf8')
    expect(backend).toMatch(/\.api\.realm\./)
    expect((config as { permissions?: { storage?: { realm?: boolean } } }).permissions?.storage?.realm).toBe(true)
  })
})
