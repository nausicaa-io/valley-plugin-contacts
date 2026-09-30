import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { convertFolder, linkRelations, markdownContact, vcardFor } from '../tooling/markdownToVcard'
import { parseContactFile } from '../src/schema'

const FERN = `---
type: contact
groups:
  - plants
  - Wald
firstName: Fern
lastName: Blüten
birthdate: 1990-05-12
relations:
  - to: "[[Moss Meadow]]"
    type: family
    role: Parent
  - to: "[[Nobody Known]]"
    role: Colleague
email:
  - value: fern@biodiversity.example
    type: Field
place:
  - value: Waldweg 1, Mossville
    type: Home
location:
  lat: 35.31
  lng: -120.49
aliases: [Farn]
profession: Botanist
---
# Fern Blüten

Grüße aus Wäldern. See [[Moss Meadow]].
`
const MOSS = '---\ntype: contact\nfirstName: Moss\nlastName: Meadow\n---\nPlain body\n'

let directory = ''
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = '' })

describe('Markdown contact transfer', () => {
  it('maps frontmatter and body into a card, linking relations by UID', () => {
    const fern = markdownContact('Meadow/Fern Blüten.md', FERN)!
    const moss = markdownContact('Meadow/Moss Meadow.md', MOSS)!
    linkRelations([fern, moss])
    expect(fern.contact).toMatchObject({
      relPath: 'Meadow/Fern Blüten.vcf', displayName: 'Fern Blüten', birthdate: '1990-05-12', groups: ['plants', 'Wald'], profession: 'Botanist',
      email: [{ value: 'fern@biodiversity.example', type: 'Field' }], place: [{ value: 'Waldweg 1, Mossville', type: 'Home' }],
      relations: [{ to: moss.contact.uid, type: 'family', role: 'Parent' }, { to: 'Nobody Known', type: 'work', role: 'Colleague' }],
      note: 'Grüße aus Wäldern. See [[Moss Meadow]].'
    })
    expect(fern.unmapped).toEqual(['aliases'])
    const card = vcardFor(fern)
    expect(card).toContain('GEO:geo:35.31,-120.49\r\nEND:VCARD\r\n')
    expect(parseContactFile('Meadow/Fern Blüten.vcf', card)).toMatchObject({ lastName: 'Blüten', note: 'Grüße aus Wäldern. See [[Moss Meadow]].', uid: fern.contact.uid })
    expect(markdownContact('Notes/Plain.md', '---\ntype: note\n---\nText')).toBeNull()
    expect(markdownContact('Notes/Bare.md', 'No frontmatter')).toBeNull()
  })

  it('reports without writing, then converts, removes notes on request and never overwrites cards', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'contacts-transfer-'))
    await mkdir(path.join(directory, 'Nested'))
    await writeFile(path.join(directory, 'Fern Blüten.md'), FERN)
    await writeFile(path.join(directory, 'Nested', 'Moss Meadow.md'), MOSS)
    await writeFile(path.join(directory, 'Existing.md'), '---\ntype: contact\nfirstName: Existing\n---\n')
    await writeFile(path.join(directory, 'Existing.vcf'), 'BEGIN:VCARD\r\nFN:Keep\r\nEND:VCARD\r\n')
    await writeFile(path.join(directory, 'Journal.md'), '# Not a contact\n')
    const log: string[] = []
    expect(await convertFolder(directory, { log: (line) => log.push(line) })).toEqual({ converted: 2, skipped: ['Existing.md'] })
    expect((await readdir(directory)).sort()).toEqual(['Existing.md', 'Existing.vcf', 'Fern Blüten.md', 'Journal.md', 'Nested'])
    expect(await convertFolder(directory, { write: true, removeMarkdown: true, log: () => {} })).toMatchObject({ converted: 2 })
    expect((await readdir(directory)).sort()).toEqual(['Existing.md', 'Existing.vcf', 'Fern Blüten.vcf', 'Journal.md', 'Nested'])
    expect(await readdir(path.join(directory, 'Nested'))).toEqual(['Moss Meadow.vcf'])
    expect(await readFile(path.join(directory, 'Existing.vcf'), 'utf8')).toContain('FN:Keep')
    const moss = parseContactFile('Nested/Moss Meadow.vcf', await readFile(path.join(directory, 'Nested', 'Moss Meadow.vcf'), 'utf8'))
    const fern = parseContactFile('Fern Blüten.vcf', await readFile(path.join(directory, 'Fern Blüten.vcf'), 'utf8'))
    expect(fern.relations[0].to).toBe(moss.uid)
  })
})
