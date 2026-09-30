import type { Contact } from './types'

function normalizeDateFormat(format: string): string {
  const lower = format.toLowerCase()
  const match = lower.match(/^(dd|mm|yyyy)([^a-z])(dd|mm|yyyy)([^a-z])(dd|mm|yyyy)$/)
  if (!match) return 'yyyy-mm-dd'
  const parts = [match[1], match[3], match[5]]
  return parts.includes('dd') && parts.includes('mm') && parts.includes('yyyy') ? lower : 'yyyy-mm-dd'
}

function isoDateParts(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return { year, month, day }
}

function formatDateParts(parts: { year: number; month: number; day: number }, dateFormat: string): string {
  return normalizeDateFormat(dateFormat)
    .replace('yyyy', String(parts.year))
    .replace('mm', String(parts.month).padStart(2, '0'))
    .replace('dd', String(parts.day).padStart(2, '0'))
}

/** A yearless birthday (`--MM-DD`) in the configured order, without the year. */
function formatDayMonth(value: string, dateFormat: string): string | null {
  const match = /^--(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) return null
  const pattern = normalizeDateFormat(dateFormat).match(/^(dd|mm|yyyy)([^a-z])(dd|mm|yyyy)([^a-z])(dd|mm|yyyy)$/)!
  const tokens = [pattern[1], pattern[3], pattern[5]].filter((token) => token !== 'yyyy')
  return tokens.map((token) => token === 'mm' ? match[1] : match[2]).join(pattern[2])
}

export function formatContactDate(value: string, dateFormat: string): string {
  const parts = isoDateParts(value)
  return parts ? formatDateParts(parts, dateFormat) : value
}

export function formatContactBirthdate(value: string, dateFormat: string, now = new Date()): string {
  const parts = isoDateParts(value)
  if (!parts) return formatDayMonth(value, dateFormat) ?? value
  let age = now.getFullYear() - parts.year
  if (now.getMonth() + 1 < parts.month || (now.getMonth() + 1 === parts.month && now.getDate() < parts.day)) age--
  const formatted = formatDateParts(parts, dateFormat)
  return age >= 0 ? `${formatted} (${age} y.o)` : formatted
}

export function dateFormatPlaceholder(dateFormat: string): string {
  return normalizeDateFormat(dateFormat)
}

export function parseContactDateInput(value: string, dateFormat: string): string {
  const input = value.trim()
  if (!input) return ''
  if (isoDateParts(input)) return input
  const pattern = normalizeDateFormat(dateFormat)
  const match = pattern.match(/^(dd|mm|yyyy)([^a-z])(dd|mm|yyyy)([^a-z])(dd|mm|yyyy)$/)
  if (!match) return input
  const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^(\\d{1,4})${escapeRe(match[2])}(\\d{1,4})${escapeRe(match[4])}(\\d{1,4})$`)
  const raw = re.exec(input)
  if (!raw) return input
  const tokens = [match[1], match[3], match[5]]
  const values = [raw[1], raw[2], raw[3]]
  const year = Number(values[tokens.indexOf('yyyy')])
  const month = Number(values[tokens.indexOf('mm')])
  const day = Number(values[tokens.indexOf('dd')])
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return isoDateParts(iso) ? iso : input
}

/** Two-letter initials from a display name. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2)
  return (parts[0][0] + parts[parts.length - 1][0])
}

/** A short one-line subtitle for list rows (org title or first email). */
export function contactSubtitle(c: Contact): string {
  const org = c.organization[0]
  if (org) return [org.title, org.name].filter(Boolean).join(' · ')
  if (c.profession) return c.profession
  if (c.email[0]) return c.email[0].value
  return c.phone[0]?.value ?? ''
}

/** Lowercased haystack for searching a contact. */
export function searchHaystack(c: Contact): string {
  return [
    c.displayName,
    c.fileName,
    ...c.groups,
    ...c.organization.map((o) => [o.name, o.title, o.dept].filter(Boolean).join(' ')),
    ...c.email.map((e) => e.value),
    ...c.phone.map((p) => p.value),
    c.profession
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}
