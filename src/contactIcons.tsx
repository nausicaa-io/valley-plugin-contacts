import type { ReactElement } from 'react'
import type { ValleyPluginApi } from '@valley/plugin-sdk'
import { React, api } from './runtime'
import { uiText } from './localization'

/** Realm-relative folder of the platform icons (seeded by the backend); add an SVG there to offer it. */
export const CONTACT_ICON_FOLDER = '.valley/assets/icons/contacts-icon'

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
  svgs: Record<string, string>
  /** iconKey → file name, so a lookup never scans every icon. */
  keys: Map<string, string>
  revision: number
  loaded: boolean
  listeners: Set<() => void>
  pending: Promise<void> | null
}

function registry(owner = api): Registry {
  return owner.runtime.getOrCreate('contacts.icons', () => ({
    svgs: { social: SOCIAL_SVG }, keys: new Map([['social', 'social']]), revision: 0, loaded: false, listeners: new Set<() => void>(), pending: null
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
  current.pending = owner.backend.call<{ icons?: Record<string, string> }>('contactIcons', {}).then((result) => {
    const svgs: Record<string, string> = { social: SOCIAL_SVG }
    for (const [name, source] of Object.entries(result?.icons ?? {})) {
      const svg = typeof source === 'string' ? clean(source) : null
      if (svg) svgs[name] = svg
    }
    const keys = new Map<string, string>()
    for (const name of Object.keys(svgs).sort()) if (!keys.has(iconKey(name))) keys.set(iconKey(name), name)
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

type Icon = (props: { className?: string }) => ReactElement
const components = new Map<string, Icon>()

export function hasContactIcon(name: string | undefined): boolean {
  return registry().keys.has(iconKey(name))
}

export function contactIcon(name: string | undefined): Icon {
  const key = registry().keys.get(iconKey(name)) ?? 'social'
  let component = components.get(key)
  if (!component) {
    component = ({ className }) => {
      const svg = registry().svgs[key] ?? SOCIAL_SVG
      return <span className={`ct-platform-icon${className ? ` ${className}` : ''}`} aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
    }
    components.set(key, component)
  }
  return component
}

export function ContactIconPicker({ name, icon, onChange, children }: {
  name: string
  icon?: string
  onChange: (icon: string | undefined) => void
  children: ReactElement
}): ReactElement {
  const ref = React.useRef<HTMLButtonElement>(null)
  const label = uiText('contacts.social.chooseIcon', { p0: name })
  return (
    <button ref={ref} type="button" className="ct-social-icon ct-social-icon-button" title={label} aria-label={label}
      onClick={() => {
        if (!ref.current) return
        void api.ui.openPopover((ctx) => <ContactIconGrid current={icon} onPick={(next) => { onChange(next); ctx.close() }} />,
          { anchor: ref.current }, { className: 'ct-social-picker', ariaLabel: label })
      }}
    >{children}</button>
  )
}

function ContactIconGrid({ current, onPick }: { current?: string; onPick: (icon: string | undefined) => void }): ReactElement {
  useContactIcons()
  const [query, setQuery] = React.useState('')
  const svgs = registry().svgs
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
      <span className="ct-social-picker-hint">{uiText('contacts.icons.folderHint', { p0: CONTACT_ICON_FOLDER })}</span>
    </div>
  )
}
