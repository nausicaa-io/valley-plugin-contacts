import { describe, expect, it } from 'vitest'
import {
  buildContactFile,
  inferRelationType,
  normalizeBirthdate,
  parseContactFile,
  updateContactFile
} from '../src/schema'
import { foldLine, parseVCardFile, cardsOf } from '../src/vcard'
import { relationLabel, relationTarget, resolveCoverPath, resolveRelation } from '../src/data'
import { buildRelationGraph } from '../src/relationGraphModel'
import { contactAt, uidFor } from './cards'

const lines = (text: string): string[] => text.split('\r\n')

describe('inferRelationType', () => {
  it('maps free-text roles onto relation types', () => {
    expect(inferRelationType('Girlfriend')).toBe('partner')
    expect(inferRelationType('Colleague')).toBe('work')
    expect(inferRelationType('Schoolmate')).toBe('school')
    expect(inferRelationType('Cousin')).toBe('family')
    expect(inferRelationType('')).toBe('other')
  })
})

describe('writing vCard 4.0', () => {
  it('writes every field, escapes text and keeps umlauts', () => {
    const contact = contactAt('Meadow/Orbit/Fern Blüten.vcf', {
      firstName: 'Fern', lastName: 'Blüten', nickname: 'Farn', birthdate: '1990-05-12', groups: ['plants', 'Wald, Wiese'],
      cover: 'fern.jpg', profession: 'Botanist',
      email: [{ value: 'fern@biodiversity.example', type: 'Field' }], phone: [{ value: '+99 100 000 00', type: 'Mobile' }],
      place: [{ value: 'Fernweg 1; 12345 Mossville', type: 'Home' }], organization: [{ name: 'Herbarium', dept: 'Mosses', title: 'Curator' }],
      websites: ['https://example.org/fern'], socialMedia: [{ platform: 'instagram', handle: 'fern', url: 'https://instagram.com/fern' }],
      relations: [{ to: uidFor('Meadow/Orbit/Moss.vcf'), type: 'family', role: 'Parent' }, { to: 'Oak Elder', type: 'friend' }],
      events: ['Met at the Moss survey'], lastContact: '2026-01-02', note: 'Grüße aus Wäldern.\n\n- [[Moss]] knows her'
    })
    const text = buildContactFile(contact)
    const unfolded = lines(text.replace(/\r\n /g, ''))
    expect(unfolded[0]).toBe('BEGIN:VCARD')
    expect(unfolded).toContain('VERSION:4.0')
    expect(unfolded).toContain(`UID:${contact.uid}`)
    expect(unfolded).toContain('FN:Farn')
    expect(unfolded).toContain('N:Blüten;Fern;;;')
    expect(unfolded).toContain('BDAY:19900512')
    expect(unfolded).toContain('CATEGORIES:plants,Wald\\, Wiese')
    expect(unfolded).toContain('TEL;TYPE=cell:+99 100 000 00')
    expect(unfolded).toContain('EMAIL;TYPE=Field:fern@biodiversity.example')
    expect(unfolded).toContain('ADR;TYPE=home;LABEL="Fernweg 1; 12345 Mossville":;;Fernweg 1\\; 12345 Mossville;;;;')
    expect(unfolded).toContain('ORG:Herbarium;Mosses')
    expect(unfolded).toContain('TITLE:Curator')
    expect(unfolded).toContain('ROLE:Botanist')
    expect(unfolded).toContain('SOCIALPROFILE;SERVICE-TYPE=instagram;USERNAME=fern:https://instagram.com/fern')
    expect(unfolded).toContain(`RELATED;TYPE=kin;X-ROLE=Parent:${uidFor('Meadow/Orbit/Moss.vcf')}`)
    expect(unfolded).toContain('RELATED;VALUE=text;TYPE=friend:Oak Elder')
    expect(unfolded).toContain('NOTE:Grüße aus Wäldern.\\n\\n- [[Moss]] knows her')
    expect(unfolded.at(-2)).toBe('END:VCARD')
    expect(parseContactFile(contact.relPath, text)).toEqual(contact)
  })

  it('folds long lines at 75 octets without splitting characters', () => {
    const line = `NOTE:${'äöü'.repeat(40)}`
    const folded = foldLine(line)
    for (const part of folded.split('\r\n')) expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75)
    expect(folded.replace(/\r\n /g, '')).toBe(line)
    expect(folded).not.toContain('�')
  })
})

describe('reading other address books', () => {
  it('reads an Apple-style vCard 3.0 with labels, photos and related names', () => {
    const raw = [
      'BEGIN:VCARD', 'VERSION:3.0', 'PRODID:-//Apple Inc.//macOS//EN', 'N:Moss;Mira;Ann;Dr.;', 'FN:Dr. Mira Moss', 'NICKNAME:Mimi',
      'ORG:Seed Bank;Vault', 'TITLE:Keeper', 'item1.EMAIL;type=INTERNET;type=pref:mira@seed.example', 'item1.X-ABLabel:_$!<Other>!$_',
      'TEL;type=CELL;type=VOICE;type=pref:+99 111 111 11', 'item2.ADR;type=HOME:;;Moosweg 4;Mossville;;12345;Fernland', 'item2.X-ABADR:ch',
      'BDAY;VALUE=date:1984-02-29', 'item3.X-ABRELATEDNAMES:Fern Blüten', 'item3.X-ABLabel:_$!<Sister>!$_',
      'X-SOCIALPROFILE;type=twitter;x-user=mira:http://twitter.com/mira', 'URL;type=HOME:https\\://mira.example',
      'PHOTO;ENCODING=b;TYPE=JPEG:AAAA', 'CATEGORIES:Seeds,Friends', 'X-UNKNOWN-FIELD:keep me', 'END:VCARD', ''
    ].join('\r\n')
    const contact = parseContactFile('Imports/Mira.vcf', raw)
    expect(contact).toMatchObject({
      firstName: 'Mira', middleName: 'Ann', lastName: 'Moss', nickname: 'Mimi', displayName: 'Mimi', birthdate: '1984-02-29',
      organization: [{ name: 'Seed Bank', dept: 'Vault', title: 'Keeper' }], email: [{ value: 'mira@seed.example', type: 'Other' }],
      phone: [{ value: '+99 111 111 11', type: 'Mobile' }], place: [{ value: 'Moosweg 4, 12345 Mossville, Fernland', type: 'Home' }],
      relations: [{ to: 'Fern Blüten', type: 'family', role: 'Sister' }], socialMedia: [{ platform: 'twitter', handle: 'mira', url: 'http://twitter.com/mira' }],
      websites: ['https://mira.example'], groups: ['Seeds', 'Friends'], photo: 'data:image/jpeg;base64,AAAA', uid: ''
    })
  })

  it('reads vCard 2.1 quoted-printable values and bare parameters', () => {
    const raw = 'BEGIN:VCARD\nVERSION:2.1\nN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:M=C3=BCller;J=C3=BCrg;;;\nTEL;CELL:+99 170 0000\nNOTE;ENCODING=QUOTED-PRINTABLE:Zeile eins=0D=0A=\nZeile zwei\nEND:VCARD\n'
    const contact = parseContactFile('Imports/Jürg.vcf', raw)
    expect(contact).toMatchObject({ firstName: 'Jürg', lastName: 'Müller', phone: [{ value: '+99 170 0000', type: 'Mobile' }] })
    expect(contact.note).toBe('Zeile eins\r\nZeile zwei')
  })

  it('reads tel: URIs as plain numbers with their extension', () => {
    const raw = 'BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Phone\r\nTEL;VALUE=uri;TYPE="voice,cell":tel:+99-00-000-00-10\r\nTEL;VALUE=uri;TYPE=work:tel:+99-00-000-00-11;ext=42\r\nEND:VCARD\r\n'
    expect(parseContactFile('Meadow/Phone.vcf', raw).phone).toEqual([{ value: '+99-00-000-00-10', type: 'Mobile' }, { value: '+99-00-000-00-11 ext. 42', type: 'Work' }])
  })

  it('treats an empty file as a blank contact and rejects text without a card', () => {
    expect(parseContactFile('Meadow/New.vcf', '')).toMatchObject({ fileName: 'New', displayName: 'New', uid: '' })
    expect(() => parseContactFile('Meadow/Broken.vcf', 'not a vcard')).toThrow('no vCard')
  })

  it('normalizes birthdays with and without years', () => {
    expect(normalizeBirthdate('19900512')).toBe('1990-05-12')
    expect(normalizeBirthdate('1990-05-12T00:00:00Z')).toBe('1990-05-12')
    expect(normalizeBirthdate('--0229')).toBe('--02-29')
    expect(normalizeBirthdate('circa 1800')).toBe('circa 1800')
  })
})

describe('updating a card', () => {
  const imported = [
    'BEGIN:VCARD', 'VERSION:3.0', 'N:Moss;Mira;;Dr.;PhD', 'FN:Dr. Mira Moss', 'item1.EMAIL;type=INTERNET:mira@seed.example', 'item1.X-ABLabel:Lab',
    'X-UNKNOWN-FIELD:keep me', 'PHOTO;ENCODING=b;TYPE=JPEG:AAAA', 'CATEGORIES:Seeds', 'END:VCARD',
    'BEGIN:VCARD', 'VERSION:3.0', 'FN:Second Card', 'END:VCARD', ''
  ].join('\r\n')

  it('rewrites only changed fields and keeps unknown lines, other cards and name affixes', () => {
    const previous = parseContactFile('Imports/Mira.vcf', imported)
    const next = { ...previous, groups: ['Seeds', 'Friends'], lastName: 'Mossberg' }
    const text = updateContactFile(next, previous, imported)
    const out = lines(text)
    expect(out).toContain('CATEGORIES:Seeds,Friends')
    expect(out).toContain('N:Mossberg;Mira;;Dr.;PhD')
    expect(out).toContain('item1.EMAIL;type=INTERNET:mira@seed.example')
    expect(out).toContain('item1.X-ABLabel:Lab')
    expect(out).toContain('X-UNKNOWN-FIELD:keep me')
    expect(out).toContain('PHOTO;ENCODING=b;TYPE=JPEG:AAAA')
    expect(out).toContain('VERSION:3.0')
    expect(out.filter((line) => line.startsWith('UID:urn:uuid:'))).toHaveLength(1)
    expect(cardsOf(parseVCardFile(text))).toHaveLength(2)
    expect(text).toContain('FN:Second Card')
    expect(parseContactFile('Imports/Mira.vcf', text)).toMatchObject({ lastName: 'Mossberg', groups: ['Seeds', 'Friends'], email: [{ value: 'mira@seed.example', type: 'Lab' }] })
  })

  it('drops Apple label companions together with a replaced field', () => {
    const previous = parseContactFile('Imports/Mira.vcf', imported)
    const text = updateContactFile({ ...previous, email: [{ value: 'new@seed.example', type: 'Work' }] }, previous, imported)
    expect(text).not.toContain('X-ABLabel:Lab')
    expect(lines(text)).toContain('EMAIL;TYPE=work:new@seed.example')
  })

  it('returns the bytes unchanged when nothing changed', () => {
    const own = buildContactFile(contactAt('Meadow/Oak.vcf', { firstName: 'Oak' }))
    const previous = parseContactFile('Meadow/Oak.vcf', own)
    expect(updateContactFile(previous, previous, own)).toBe(own)
  })
})

describe('relations', () => {
  const moss = contactAt('Meadow/Orbit/Moss.vcf', { firstName: 'Moss' })
  const oak = contactAt('Meadow/Orbit/Oak.vcf', { firstName: 'Oak' })
  const nameless = { ...contactAt('Meadow/Orbit/Lichen.vcf', { firstName: 'Lichen' }), uid: '' }

  it('resolves UIDs first and names as a fallback', () => {
    expect(resolveRelation(moss.uid, [moss, oak])?.relPath).toBe(moss.relPath)
    expect(resolveRelation('oak', [moss, oak])?.relPath).toBe(oak.relPath)
    expect(resolveRelation('urn:uuid:missing', [moss])).toBeNull()
    expect(relationLabel('urn:uuid:missing', [moss])).toBe('Unknown contact')
    expect(relationLabel('Somebody', [moss])).toBe('Somebody')
  })

  it('stores a UID for a typed name when the contact has one', () => {
    expect(relationTarget('Moss', [moss, nameless])).toBe(moss.uid)
    expect(relationTarget('Lichen', [moss, nameless])).toBe('Lichen')
    expect(relationTarget('Stranger', [moss])).toBe('Stranger')
  })
})

describe('resolveCoverPath', () => {
  const entries = [
    { relPath: 'Plants/fern.jpg', title: 'fern', kind: 'asset' as const, mtimeMs: 0 },
    { relPath: 'Plants/readme.md', title: 'readme', kind: 'note' as const, mtimeMs: 0 }
  ]

  it('resolves exact paths and filename-only covers to vault images', () => {
    expect(resolveCoverPath(entries, 'Plants/fern.jpg')).toBe('Plants/fern.jpg')
    expect(resolveCoverPath(entries, 'fern.jpg')).toBe('Plants/fern.jpg')
  })

  it('returns null for missing filename covers', () => {
    expect(resolveCoverPath(entries, 'missing.jpg')).toBeNull()
  })
})

describe('buildRelationGraph', () => {
  const chanterelle = contactAt('Meadow/Orbit/Chanterelle.vcf', { firstName: 'Chanterelle', relations: [{ to: uidFor('Meadow/Orbit/Oak.vcf'), type: 'family', role: 'Symbiont' }] })
  const oak = contactAt('Meadow/Orbit/Oak.vcf', { firstName: 'Oak', relations: [{ to: 'Chanterelle', type: 'family', role: 'Symbiont' }] })
  const other = contactAt('Meadow/Orbit/Moss.vcf', { firstName: 'Moss' })

  it('resolves UID and name relations to edges and dedupes reciprocal pairs', () => {
    const g = buildRelationGraph([chanterelle, oak, other])
    expect(g.nodes).toHaveLength(3)
    expect(g.edges).toHaveLength(1)
    expect(g.edges[0].relType).toBe('family')
  })

  it('local mode keeps only the focus node and its neighbors', () => {
    const g = buildRelationGraph([chanterelle, oak, other], { focusPath: 'Meadow/Orbit/Chanterelle.vcf' })
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['Meadow/Orbit/Chanterelle.vcf', 'Meadow/Orbit/Oak.vcf'])
  })

  it('type filter excludes hidden relation types', () => {
    expect(buildRelationGraph([chanterelle, oak], { typeFilter: new Set(['work']) }).edges).toHaveLength(0)
  })
})
