/**
 * RFC 6350 vCard reading and writing. Reads 2.1, 3.0 and 4.0 cards (the shapes
 * address books export); writes 4.0. A parsed file keeps every card and every
 * property it does not understand, so an edit rewrites only the lines it owns.
 */

export interface VCardProperty {
  /** Property group (`item1` in `item1.EMAIL`), lowercased; '' when absent. */
  group: string
  /** Upper-case property name. */
  name: string
  /** Upper-case parameter names → their values (unquoted, caret-decoded). */
  params: Map<string, string[]>
  /** Raw value, still escaped as it appears on the line. */
  value: string
  /** The unfolded original line; written back verbatim while unchanged. */
  line?: string
}

export interface VCardCard {
  properties: VCardProperty[]
}

/** One card inside a file with the untouched text around it. */
export interface VCardFile {
  /** Text before the first card, each card's text, and text after the last. */
  segments: Array<{ kind: 'text'; text: string } | { kind: 'card'; card: VCardCard; text: string }>
  newline: string
}

const LINE_LIMIT = 75

/** Split a line on a separator outside double quotes. */
function splitOutsideQuotes(value: string, separator: string, limit = Infinity): string[] {
  const out: string[] = []
  let quoted = false
  let start = 0
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (char === '"') quoted = !quoted
    else if (char === separator && !quoted && out.length < limit - 1) {
      out.push(value.slice(start, index))
      start = index + 1
    }
  }
  out.push(value.slice(start))
  return out
}

/** RFC 6868 parameter value decoding (`^n`, `^^`, `^'`). */
function decodeParamValue(value: string): string {
  const unquoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
  return unquoted.replace(/\^([n^'])/g, (_match, code: string) => code === 'n' ? '\n' : code === '^' ? '^' : '"')
}

function encodeParamValue(value: string): string {
  const encoded = value.replace(/\^/g, '^^').replace(/\r?\n/g, '^n').replace(/"/g, "^'")
  return /[:;,\s^]|[^\x21-\x7e]/.test(value) ? `"${encoded}"` : encoded
}

const BARE_TYPE_PARAMS = new Set(['HOME', 'WORK', 'CELL', 'VOICE', 'FAX', 'PAGER', 'MSG', 'PREF', 'INTERNET', 'X400', 'DOM', 'INTL', 'POSTAL', 'PARCEL', 'BBS', 'MODEM', 'CAR', 'ISDN', 'VIDEO', 'PCS', 'JPEG', 'PNG', 'GIF'])

/** Parse one unfolded content line; null for a line that is not a property. */
export function parseContentLine(line: string): VCardProperty | null {
  const [head, ...rest] = splitOutsideQuotes(line, ':', 2)
  if (!rest.length) return null
  const [nameWithGroup, ...rawParams] = splitOutsideQuotes(head, ';')
  const dot = nameWithGroup.lastIndexOf('.')
  const group = dot > 0 ? nameWithGroup.slice(0, dot).trim().toLowerCase() : ''
  const name = (dot > 0 ? nameWithGroup.slice(dot + 1) : nameWithGroup).trim().toUpperCase()
  if (!/^[A-Z0-9-]+$/.test(name)) return null
  const params = new Map<string, string[]>()
  for (const raw of rawParams) {
    const equals = raw.indexOf('=')
    // vCard 2.1 writes bare type parameters (`TEL;CELL:`) and bare encodings.
    const key = equals < 0 ? (BARE_TYPE_PARAMS.has(raw.trim().toUpperCase()) ? 'TYPE' : raw.trim().toUpperCase() === 'QUOTED-PRINTABLE' || raw.trim().toUpperCase() === 'BASE64' ? 'ENCODING' : raw.trim().toUpperCase()) : raw.slice(0, equals).trim().toUpperCase()
    const values = equals < 0 ? [raw.trim()] : splitOutsideQuotes(raw.slice(equals + 1), ',').map(decodeParamValue)
    if (!key) continue
    params.set(key, [...(params.get(key) ?? []), ...values.filter((value) => value !== '')])
  }
  return { group, name, params, value: rest[0], line }
}

/** Unfold physical lines (RFC 6350 §3.2 and 2.1 quoted-printable soft breaks). */
function unfold(lines: string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    const previous = out.length ? out[out.length - 1] : undefined
    if (previous !== undefined && (line.startsWith(' ') || line.startsWith('\t'))) out[out.length - 1] = previous + line.slice(1)
    else if (previous !== undefined && /QUOTED-PRINTABLE/i.test(previous.split(':')[0]) && previous.endsWith('=')) out[out.length - 1] = previous.slice(0, -1) + line
    else out.push(line)
  }
  return out
}

/** Parse a `.vcf` file. Cards keep their order; text between cards survives. */
export function parseVCardFile(source: string): VCardFile {
  const text = source.replace(/^\uFEFF/, '')
  const newline = /\r\n/.test(text) ? '\r\n' : '\n'
  const physical = text.split(/\r\n|\n|\r/)
  const segments: VCardFile['segments'] = []
  let pending: string[] = []
  let card: { lines: string[]; start: string[] } | null = null
  let depth = 0
  for (const line of physical) {
    const bare = line.trim().toUpperCase()
    if (!card) {
      if (bare === 'BEGIN:VCARD') {
        if (pending.length) segments.push({ kind: 'text', text: pending.join(newline) })
        pending = []
        card = { lines: [], start: [line] }
        depth = 1
      } else pending.push(line)
      continue
    }
    if (bare === 'BEGIN:VCARD') depth++
    if (bare === 'END:VCARD' && --depth === 0) {
      const lines = unfold(card.lines)
      const properties = lines.map(parseContentLine).filter((value): value is VCardProperty => value !== null)
      segments.push({ kind: 'card', card: { properties }, text: [...card.start, ...card.lines, line].join(newline) })
      card = null
      continue
    }
    card.lines.push(line)
  }
  // An unterminated card is kept as plain text: nothing we cannot parse is lost.
  if (card) pending.push(...card.start, ...card.lines)
  if (pending.length) segments.push({ kind: 'text', text: pending.join(newline) })
  return { segments, newline }
}

export function cardsOf(file: VCardFile): VCardCard[] {
  return file.segments.flatMap((segment) => segment.kind === 'card' ? [segment.card] : [])
}

/** Replace the first card of a file and serialize everything else verbatim. */
export function replaceFirstCard(file: VCardFile, card: VCardCard): string {
  let replaced = false
  const parts = file.segments.map((segment) => {
    if (segment.kind === 'text') return segment.text
    if (replaced) return segment.text
    replaced = true
    return serializeCard(card, file.newline)
  })
  if (!replaced) parts.push(serializeCard(card, file.newline))
  const joined = parts.join(file.newline)
  return joined.endsWith(file.newline) ? joined : joined + file.newline
}

// --- Values -------------------------------------------------------------

function decodeQuotedPrintable(value: string, charset: string): string {
  const bytes: number[] = []
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(value.slice(index + 1, index + 3))) {
      bytes.push(parseInt(value.slice(index + 1, index + 3), 16))
      index += 2
    } else if (char === '=' && index === value.length - 1) continue
    else for (const byte of new TextEncoder().encode(char)) bytes.push(byte)
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(new Uint8Array(bytes))
  } catch {
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes))
  }
}

/** The raw value with any 2.1 transfer encoding removed (escapes untouched). */
function transferDecoded(property: VCardProperty): string {
  const encoding = (property.params.get('ENCODING')?.[0] ?? '').toUpperCase()
  if (encoding === 'QUOTED-PRINTABLE') return decodeQuotedPrintable(property.value, property.params.get('CHARSET')?.[0] ?? 'utf-8')
  return property.value
}

/** Unescape one text component (`\n`, `\,`, `\;`, `\\`). */
export function unescapeText(value: string): string {
  return value.replace(/\\([\\nN,;:])/g, (_match, char: string) => char === 'n' || char === 'N' ? '\n' : char)
}

export function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;')
}

/** Split on an unescaped separator, keeping escapes for later unescaping. */
function splitEscaped(value: string, separator: string): string[] {
  const out: string[] = []
  let current = ''
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (char === '\\' && index + 1 < value.length) {
      current += char + value[index + 1]
      index++
    } else if (char === separator) {
      out.push(current)
      current = ''
    } else current += char
  }
  out.push(current)
  return out
}

/** A single text value (NOTE, FN, ROLE …). */
export function textValue(property: VCardProperty): string {
  return unescapeText(transferDecoded(property))
}

/** A structured value (N, ADR, ORG): components, each a list of texts. */
export function structuredValue(property: VCardProperty): string[][] {
  return splitEscaped(transferDecoded(property), ';').map((component) => splitEscaped(component, ',').map(unescapeText))
}

/** A comma list (CATEGORIES, NICKNAME). */
export function listValue(property: VCardProperty): string[] {
  return splitEscaped(transferDecoded(property), ',').map(unescapeText)
}

export function param(property: VCardProperty, name: string): string[] {
  return property.params.get(name) ?? []
}

/** Types as lowercase tokens; TYPE values may themselves be comma lists. */
export function typesOf(property: VCardProperty): string[] {
  return param(property, 'TYPE').flatMap((value) => value.split(',')).map((value) => value.trim().toLowerCase()).filter(Boolean)
}

/** Base64 photos as data URIs; `data:` values pass through. */
export function photoDataUri(property: VCardProperty): string {
  const value = property.value.trim()
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) return value.replace(/\s+/g, '')
  const encoding = (param(property, 'ENCODING')[0] ?? '').toUpperCase()
  if (encoding !== 'B' && encoding !== 'BASE64') return ''
  const type = (typesOf(property).find((entry) => /^(jpeg|jpg|png|gif|webp)$/.test(entry)) ?? 'jpeg').replace('jpg', 'jpeg')
  const data = value.replace(/\s+/g, '')
  return /^[A-Za-z0-9+/=]+$/.test(data) ? `data:image/${type};base64,${data}` : ''
}

// --- Writing --------------------------------------------------------------

export interface PropertyInput {
  group?: string
  name: string
  params?: Array<[string, string | string[]]>
  /** Already escaped / structured value text. */
  value: string
}

export function property(input: PropertyInput): VCardProperty {
  const params = new Map<string, string[]>()
  for (const [key, value] of input.params ?? []) {
    const values = (Array.isArray(value) ? value : [value]).filter((entry) => entry !== '')
    if (values.length) params.set(key.toUpperCase(), values)
  }
  return { group: (input.group ?? '').toLowerCase(), name: input.name.toUpperCase(), params, value: input.value }
}

function formatLine(property: VCardProperty): string {
  if (property.line !== undefined) return property.line
  const params = [...property.params].map(([key, values]) => `;${key}=${values.map(encodeParamValue).join(',')}`).join('')
  return `${property.group ? `${property.group}.` : ''}${property.name}${params}:${property.value}`
}

/** Fold to 75 octets per physical line without splitting a UTF-8 character. */
export function foldLine(line: string, newline = '\r\n'): string {
  const encoder = new TextEncoder()
  if (encoder.encode(line).length <= LINE_LIMIT) return line
  const out: string[] = []
  let current = ''
  let bytes = 0
  for (const char of line) {
    const size = encoder.encode(char).length
    const limit = out.length ? LINE_LIMIT - 1 : LINE_LIMIT
    if (bytes + size > limit) {
      out.push(current)
      current = ''
      bytes = 0
    }
    current += char
    bytes += size
  }
  out.push(current)
  return out.map((part, index) => index ? ` ${part}` : part).join(newline)
}

export function serializeCard(card: VCardCard, newline = '\r\n'): string {
  const body = card.properties
    .filter((entry) => entry.name !== 'BEGIN' && entry.name !== 'END')
    .map((entry) => foldLine(formatLine(entry), newline))
  return ['BEGIN:VCARD', ...body, 'END:VCARD'].join(newline)
}
