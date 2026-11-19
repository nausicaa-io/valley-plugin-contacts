import type { ReactElement } from 'react'
import type { ValleyPluginApi } from '@valley/plugin-sdk'
import { React, api } from './runtime'
import { uiText } from './localization'

/** Realm-relative folder of the Contacts icons (seeded by the backend), one subfolder per kind (19 Nov); add an SVG there to offer it. */
export const CONTACT_ICON_FOLDER = '.valley/assets/icons/contact-icon'
/** The icon folders: social platforms, the four label kinds and the birthday. */
export type ContactIconFolder = 'social-media' | 'phone' | 'email' | 'address' | 'website' | 'birthday'
export const SOCIAL_FOLDER: ContactIconFolder = 'social-media'

const SOCIAL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><circle cx="12" cy="14" r="3"/><path d="M12 7v4M6.7 17.8l2.8-2M17.3 17.8l-2.8-2"/></svg>'

function iconKey(name: string | undefined): string {
  return (name ?? '').trim().toLowerCase().replace(/\.svg$/, '').replace(/[^\p{L}\p{N}]/gu, '')
}

const elements = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'title', 'desc'])
const attributes = new Set(['xmlns', 'viewBox', 'width', 'height', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'points', 'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-opacity', 'stroke-dasharray', 'clip-rule', 'clip-path', 'mask', 'opacity', 'transform', 'id', 'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform'])

export function sanitizeContactSvg(source: string): string {
  if (source.length > 256_000 || /<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error(uiText('contacts.icons.invalid'))
  const document = new DOMParser().parseFromString(source, 'image/svg+xml')
  const root = document.documentElement
  if (root.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg' || document.querySelector('parsererror')) throw new Error(uiText('contacts.icons.invalid'))
  for (const node of [root, ...Array.from(root.querySelectorAll('*'))]) {
    if (!elements.has(node.tagName)) { node.remove(); continue }
    for (const attribute of Array.from(node.attributes)) {
      if (!attributes.has(attribute.name) || /url\s*\(/i.test(attribute.value) && !/^url\(#[\w-]+\)$/.test(attribute.value)) node.removeAttribute(attribute.name)
    }
  }
  return new XMLSerializer().serializeToString(root)
}

interface Registry {
  /** Sanitized sources by folder and file name. */
  svgs: Record<string, Record<string, string>>
  /** Per folder: iconKey → file name, so a lookup never scans every icon. */
  keys: Record<string, Map<string, string>>
  revision: number
  loaded: boolean
  listeners: Set<() => void>
  pending: Promise<void> | null
}

function registry(owner = api): Registry {
  return owner.runtime.getOrCreate('contacts.icons', () => ({
    svgs: { [SOCIAL_FOLDER]: { social: SOCIAL_SVG } }, keys: { [SOCIAL_FOLDER]: new Map([['social', 'social']]) }, revision: 0, loaded: false, listeners: new Set<() => void>(), pending: null
  }) as Registry)
}

/** Sanitized sources by raw source: a reload sanitizes only files that changed. */
const sanitized = new Map<string, string | null>()
function clean(source: string): string | null {
  let value = sanitized.get(source)
  if (value === undefined) {
    try { value = sanitizeContactSvg(source) } catch { value = null }
    sanitized.set(source, value)
  }
  return value
}

export function refreshContactIcons(owner = api): Promise<void> {
  const current = registry(owner)
  if (current.pending) return current.pending
  current.pending = owner.backend.call<{ icons?: Record<string, Record<string, string>> }>('contactIcons', {}).then((result) => {
    const svgs: Record<string, Record<string, string>> = { [SOCIAL_FOLDER]: { social: SOCIAL_SVG } }
    const keys: Record<string, Map<string, string>> = {}
    for (const [folder, files] of Object.entries(result?.icons ?? {})) {
      if (!files || typeof files !== 'object') continue
      const into = svgs[folder] ??= {}
      for (const [name, source] of Object.entries(files)) {
        const svg = typeof source === 'string' ? clean(source) : null
        if (svg) into[name] = svg
      }
    }
    for (const [folder, files] of Object.entries(svgs)) {
      const map = keys[folder] = new Map<string, string>()
      for (const name of Object.keys(files).sort()) if (!map.has(iconKey(name))) map.set(iconKey(name), name)
    }
    current.svgs = svgs
    current.keys = keys
    current.loaded = true
    current.revision += 1
    for (const listener of [...current.listeners]) listener()
  }).catch(() => {}).finally(() => { current.pending = null })
  return current.pending
}

/** Re-render when the icon folder is read again; the first caller in a document loads it. */
export function useContactIcons(): void {
  const current = registry(api)
  React.useEffect(() => { if (!current.loaded) void refreshContactIcons() }, [current])
  React.useSyncExternalStore(
    React.useCallback((listener: () => void) => { current.listeners.add(listener); return () => { current.listeners.delete(listener) } }, [current]),
    () => current.revision
  )
}

/** Load the icons now and again whenever a file in the folder changes. */
export function initializeContactIcons(owner: ValleyPluginApi): () => void {
  void refreshContactIcons(owner)
  let timer: number | undefined
  const off = owner.realm.onChanged((info) => {
    if (!info.full && !info.changes.some((change) => change.relPath.startsWith(`${CONTACT_ICON_FOLDER}/`))) return
    window.clearTimeout(timer)
    timer = window.setTimeout(() => { void refreshContactIcons(owner) }, 150)
  })
  return () => { window.clearTimeout(timer); off() }
}

/** The sanitized SVG source of an icon in a folder, or undefined when there is none by that name. */
export function contactIconSvg(name: string | undefined, folder: ContactIconFolder = SOCIAL_FOLDER, owner = api): string | undefined {
  const current = registry(owner)
  const key = current.keys[folder]?.get(iconKey(name))
  return key ? current.svgs[folder]?.[key] : undefined
}

/** Calls `listener` whenever the icon folder was read again. */
export function subscribeContactIcons(listener: () => void, owner = api): () => void {
  const current = registry(owner)
  current.listeners.add(listener)
  return () => { current.listeners.delete(listener) }
}

type Icon = (props: { className?: string }) => ReactElement
const components = new Map<string, Icon>()

export function hasContactIcon(name: string | undefined, folder: ContactIconFolder = SOCIAL_FOLDER): boolean {
  return Boolean(registry().keys[folder]?.has(iconKey(name)))
}

/** An icon of a folder as a component; a missing one draws the generic social glyph. */
export function contactIcon(name: string | undefined, folder: ContactIconFolder = SOCIAL_FOLDER): Icon {
  const key = registry().keys[folder]?.get(iconKey(name)) ?? 'social'
  const id = `${folder}/${key}`
  let component = components.get(id)
  if (!component) {
    component = ({ className }) => {
      const svg = registry().svgs[folder]?.[key] ?? SOCIAL_SVG
      return <span className={`ct-platform-icon${className ? ` ${className}` : ''}`} aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
    }
    components.set(id, component)
  }
  return component
}

export function ContactIconPicker({ name, icon, onChange, children, folder = SOCIAL_FOLDER }: {
  name: string
  icon?: string
  /** The folder whose icons it offers (19 Nov). */
  folder?: ContactIconFolder
  onChange: (icon: string | undefined) => void
  children: ReactElement
}): ReactElement {
  const ref = React.useRef<HTMLButtonElement>(null)
  const label = uiText('contacts.social.chooseIcon', { p0: name })
  return (
    <button ref={ref} type="button" className="ct-social-icon ct-social-icon-button" title={label} aria-label={label}
      onClick={() => {
        if (!ref.current) return
        void api.ui.openPopover((ctx) => <ContactIconGrid folder={folder} current={icon} onPick={(next) => { onChange(next); ctx.close() }} />,
          { anchor: ref.current }, { className: 'ct-social-picker', ariaLabel: label })
      }}
    >{children}</button>
  )
}

function ContactIconGrid({ folder, current, onPick }: { folder: ContactIconFolder; current?: string; onPick: (icon: string | undefined) => void }): ReactElement {
  useContactIcons()
  const [query, setQuery] = React.useState('')
  const svgs = registry().svgs[folder] ?? {}
  const shown = Object.keys(svgs).sort().filter(name => iconKey(name).includes(iconKey(query)))
  return (
    <div className="ct-social-picker-body">
      <input className="ct-input ct-social-picker-search" autoFocus value={query}
        placeholder={uiText('contacts.social.searchIcons')} aria-label={uiText('contacts.social.searchIcons')}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && shown[0]) { event.preventDefault(); onPick(shown[0]) }
        }} />
      <button type="button" className="ct-social-picker-custom" aria-pressed={!current} onClick={() => onPick(undefined)}>
        {uiText('contacts.social.autoIcon')}
      </button>
      <div className="ct-social-picker-grid">
        {shown.map((name) => (
          <button key={name} type="button" className={`ct-social-picker-tile${name === current ? ' selected' : ''}`}
            title={`${name}.svg`} aria-label={`${name}.svg`} aria-pressed={name === current} onClick={() => onPick(name)}>
            <span className="ct-platform-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svgs[name] }} />
          </button>
        ))}
      </div>
      {!shown.length && <span className="settings-empty-text">{uiText('contacts.social.noIcons')}</span>}
      <span className="ct-social-picker-hint">{uiText('contacts.icons.folderHint', { p0: `${CONTACT_ICON_FOLDER}/${folder}` })}</span>
    </div>
  )
}
