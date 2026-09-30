import { afterEach, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import type { DatasetDeclaration } from '@valley/plugin-sdk/datasets'
import type { ValleyPluginApi } from '@valley/plugin-sdk'
import config from '../config.json'
import { initRuntime } from '../src/runtime'
import { disposeStore, getStore } from '../src/store'
import { registerContactSearch } from '../src/search'
import { cardAt, cardVault, fileEntry } from './cards'

let dispose: (() => Promise<void>) | undefined
let owner: ValleyPluginApi | undefined
afterEach(async () => {
  await dispose?.()
  dispose = undefined
  if (owner) await disposeStore(owner)
  owner = undefined
})

function setup() {
  const mock = createMockValleyApi({
    manifest: { id: 'contacts', datasets: config.datasets as DatasetDeclaration[] },
    settings: { contactsRoot: 'Meadow' },
    datasets: { 'contacts.note_search': [{ path: 'Meadow/Old.vcf', name: 'Old', note: '#stale' }] },
    ...cardVault({
      'Meadow/Fern.vcf': { firstName: 'Fern', note: 'Observe #Ökologie and #field/work', groups: ['ignored-group'] },
      'Meadow/Moss.vcf': { firstName: 'Moss', note: '' },
      'Forest/Oak.vcf': { firstName: 'Oak', note: '#outside' }
    })
  })
  owner = mock.api
  initRuntime(mock.api)
  return mock
}

it('explicitly declares only note hashtags and opens results through their vCard path', () => {
  expect(config.searchSources).toEqual([expect.objectContaining({
    dataset: 'contacts.note_search', tagSearch: true, pathField: 'path',
    presentation: { titleField: 'name', subtitleField: 'path', snippetFields: ['note'], tagFields: [], inlineTagFields: ['note'] }
  })])
  expect(config.datasets[0]).toMatchObject({ store: 'cache', primaryKey: ['path'] })
})

it('reconciles the cache from scoped cards and updates notes, renames, deletion, and folder changes', async () => {
  const mock = setup()
  dispose = registerContactSearch(mock.api)
  const rows = () => mock.datasets.get('contacts.note_search')
  await expect.poll(rows).toEqual([{ path: 'Meadow/Fern.vcf', name: 'Fern', note: 'Observe #Ökologie and #field/work' }])
  const changed = cardAt('Meadow/Fern.vcf', { firstName: 'Fern', note: 'Updated #spores' })
  await mock.api.vault.writeFile('Meadow/Fern.vcf', changed)
  mock.emitState({ indexEntries: mock.api.getState().indexEntries.map(entry => entry.relPath === 'Meadow/Fern.vcf' ? fileEntry(entry.relPath, changed, 2) : entry) })
  await expect.poll(rows).toEqual([{ path: 'Meadow/Fern.vcf', name: 'Fern', note: 'Updated #spores' }])
  await mock.api.vault.writeFile('Meadow/Renamed.vcf', changed)
  mock.emitState({ indexEntries: mock.api.getState().indexEntries.map(entry => entry.relPath === 'Meadow/Fern.vcf' ? fileEntry('Meadow/Renamed.vcf', changed, 3) : entry) })
  await expect.poll(rows).toEqual([{ path: 'Meadow/Renamed.vcf', name: 'Fern', note: 'Updated #spores' }])
  mock.emitState({ indexEntries: mock.api.getState().indexEntries.filter(entry => entry.relPath !== 'Meadow/Renamed.vcf') })
  await expect.poll(rows).toEqual([])
  await mock.api.settings.set('contactsRoot', 'Forest')
  await expect.poll(rows).toEqual([{ path: 'Forest/Oak.vcf', name: 'Oak', note: '#outside' }])
  expect(await mock.api.vault.readFile('Meadow/Fern.vcf')).toBe(changed)
})

it('coalesces edits during a write and avoids writes for unchanged presentation state', async () => {
  const mock = setup()
  const dataset = mock.api.data.dataset('contacts.note_search')
  const write = dataset.batch.bind(dataset)
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const batch = vi.fn(async (...args: Parameters<typeof write>) => { await blocked; return write(...args) })
  vi.spyOn(mock.api.data, 'dataset').mockReturnValue({ ...dataset, batch })
  dispose = registerContactSearch(mock.api)
  await expect.poll(() => batch.mock.calls.length).toBe(1)
  const content = cardAt('Meadow/Fern.vcf', { firstName: 'Fern', note: '#latest' })
  await mock.api.vault.writeFile('Meadow/Fern.vcf', content)
  mock.emitState({ indexEntries: mock.api.getState().indexEntries.map(entry => entry.relPath === 'Meadow/Fern.vcf' ? fileEntry(entry.relPath, content, 9) : entry) })
  await expect.poll(() => getStore(mock.api).getSnapshot().contacts[0]?.note).toBe('#latest')
  release()
  await expect.poll(() => mock.datasets.get('contacts.note_search')).toEqual([{ path: 'Meadow/Fern.vcf', name: 'Fern', note: '#latest' }])
  expect(batch).toHaveBeenCalledTimes(2)
  getStore(mock.api).showGraph({ persist: false })
  await dispose()
  dispose = undefined
  expect(batch).toHaveBeenCalledTimes(2)
})

it('does not publish an initial cache read after disposal or a vault switch', async () => {
  const mock = setup()
  await getStore(mock.api).ready()
  const dataset = mock.api.data.dataset('contacts.note_search')
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const query = vi.fn(async () => { await blocked; return { rows: [], cursor: undefined, revision: 0 } })
  const batch = vi.fn(dataset.batch.bind(dataset))
  vi.spyOn(mock.api.data, 'dataset').mockReturnValue({ ...dataset, query, batch })
  dispose = registerContactSearch(mock.api)
  await expect.poll(() => query.mock.calls.length).toBe(1)
  const drained = dispose()
  mock.emitState({ vault: { path: '/managed/other', name: 'other', displayName: 'Other' } })
  release()
  await drained
  expect(batch).not.toHaveBeenCalled()
})
