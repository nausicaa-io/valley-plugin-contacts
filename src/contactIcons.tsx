import type { ReactElement } from 'react'
import type { ValleyPluginApi } from '@valley/plugin-sdk'
import { React, api } from './runtime'
import { uiText } from './localization'

declare const CONTACT_ICON_SVGS: Record<string, string>

function iconKey(name: string | undefined): string {
  return (name ?? '').trim().toLowerCase().replace(/\.svg$/, '').replace(/[^\p{L}\p{N}]/gu, '')
}

const ICON_DIRECTORY = 'plugins/data/contacts/contact-icon'
const safeFilename = (name: string): boolean => /^[\p{L}\p{N}][\p{L}\p{N} _.-]*\.svg$/iu.test(name) && !name.includes('..')
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

function registry(owner = api) {
  return owner.runtime.getOrCreate('contacts.icons', () => ({
    svgs: { ...CONTACT_ICON_SVGS }, revision: 0, error: '', listeners: new Set<() => void>(), pending: null as Promise<void> | null
  }))
}
function emitIcons(owner: ValleyPluginApi): void {
  registry(owner).revision += 1
  for (const listener of registry(owner).listeners) listener()
}
export function useContactIcons(): void {
  const owner = api
  React.useSyncExternalStore(listener => { registry(owner).listeners.add(listener); return () => { registry(owner).listeners.delete(listener) } }, () => registry(owner).revision)
}

export function refreshContactIcons(owner = api): Promise<void> {
  const current = registry(owner)
  if (current.pending) return current.pending
  current.pending = (async () => {
    for (const [name, svg] of Object.entries(CONTACT_ICON_SVGS)) {
      const path = `contact-icon/${name}.svg`
      if (!await owner.data.files.readTextBaseline(path)) {
        const result = await owner.data.files.writeTextGuarded(path, svg, null)
        if (!result.ok && result.reason !== 'conflict') throw new Error(uiText('contacts.icons.invalid'))
      }
    }
    const svgs: Record<string, string> = {}
    const failures: string[] = []
    for (const entry of await owner.data.files.list('contact-icon')) {
      if (entry.isDirectory || !safeFilename(entry.name)) continue
      try {
        const source = await owner.data.files.readText(`contact-icon/${entry.name}`)
        if (source === null) throw new Error(uiText('contacts.icons.invalid'))
        svgs[entry.name.slice(0, -4)] = sanitizeContactSvg(source)
      } catch { failures.push(entry.name) }
    }
    current.svgs = svgs
    current.error = failures.length ? `${uiText('contacts.icons.invalid')}: ${failures.join(', ')}` : ''
  })().catch(reason => { current.error = reason instanceof Error ? reason.message : String(reason) }).finally(() => {
    current.pending = null
    emitIcons(owner)
  })
  return current.pending
}

export function initializeContactIcons(owner: ValleyPluginApi): () => void {
  let disposed = false
  const refresh = (): void => { if (!disposed) void refreshContactIcons(owner) }
  refresh()
  const off = owner.data.files.onChanged(path => { if (path.startsWith('contact-icon/')) refresh() })
  window.addEventListener('focus', refresh)
  return () => { disposed = true; off(); window.removeEventListener('focus', refresh) }
}

type Icon = (props: { className?: string }) => ReactElement
const components = new Map<string, Icon>()
export function hasContactIcon(name: string | undefined): boolean {
  return Object.keys(registry().svgs).some(key => iconKey(key) === iconKey(name))
}
export function contactIcon(name: string | undefined): Icon {
  const key = Object.keys(registry().svgs).find(key => iconKey(key) === iconKey(name)) ?? 'social'
  if (!components.has(key)) components.set(key, ({ className }) => {
    useContactIcons()
    const svg = registry().svgs[key] ?? registry().svgs.social ?? CONTACT_ICON_SVGS.social
    return <span className={`ct-platform-icon${className ? ` ${className}` : ''}`} aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
  })
  return components.get(key)!
}

export function ContactIconSettings(): ReactElement {
  useContactIcons()
  const [error, setError] = React.useState('')
  const reveal = async (): Promise<void> => {
    try {
      await refreshContactIcons()
      api.files.revealInFinder(`.valley/${ICON_DIRECTORY}`)
      setError('')
    } catch (reason) { setError(String(reason)) }
  }
  return <>
    <api.ui.settings.Row title={uiText('contacts.icons.title')} description={uiText('contacts.icons.description')}>
      <api.ui.settings.Button onClick={() => void reveal()}>{uiText('contacts.icons.open')}</api.ui.settings.Button>
      <api.ui.settings.Button onClick={() => void refreshContactIcons()}>{uiText('contacts.icons.refresh')}</api.ui.settings.Button>
    </api.ui.settings.Row>
    {(error || registry().error) && <p role="alert">{error || registry().error}</p>}
  </>
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
  const shown = Object.keys(registry().svgs).sort().filter(name => iconKey(name).includes(iconKey(query))).map(name => ({ name, Icon: contactIcon(name) }))
  return (
    <div className="ct-social-picker-body">
      <input className="ct-input ct-social-picker-search" autoFocus value={query}
        placeholder={uiText('contacts.social.searchIcons')} aria-label={uiText('contacts.social.searchIcons')}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && shown[0]) { event.preventDefault(); onPick(shown[0].name) }
        }} />
      <button type="button" className="ct-social-picker-custom" aria-pressed={!current} onClick={() => onPick(undefined)}>
        {uiText('contacts.social.autoIcon')}
      </button>
      <div className="ct-social-picker-grid">
        {shown.map(({ name, Icon }) => (
          <button key={name} type="button" className={`ct-social-picker-tile${name === current ? ' selected' : ''}`}
            title={`${name}.svg`} aria-label={`${name}.svg`} aria-pressed={name === current} onClick={() => onPick(name)}>
            <Icon />
          </button>
        ))}
      </div>
      {!shown.length && <span className="settings-empty-text">{uiText('contacts.social.noIcons')}</span>}
    </div>
  )
}
