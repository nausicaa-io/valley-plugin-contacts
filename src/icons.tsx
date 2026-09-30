import { React } from './runtime'
import type { ReactElement, ReactNode } from 'react'

/**
 * Inline SVG icons drawn with the host's React — plugins cannot bundle
 * react-icons (it would drag in a second React instance), so the glyphs are
 * hand-rolled and stay monochrome via currentColor. Same pattern as the
 * Music / SideNotes / GraphView plugins.
 */
type IconProps = { className?: string; title?: string }

const Stroke = (props: IconProps & { children: ReactNode }): ReactElement =>
  React.createElement(
    'svg',
    {
      className: props.className,
      width: '1em',
      height: '1em',
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true
    },
    props.title ? <title>{props.title}</title> : null,
    props.children
  )

export const User = (p: IconProps): ReactElement => (
  <Stroke {...p}><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></Stroke>
)

export const Plus = (p: IconProps): ReactElement => (
  <Stroke {...p}><path d="M12 5v14M5 12h14" /></Stroke>
)

export const X = (p: IconProps): ReactElement => (
  <Stroke {...p}><path d="M18 6 6 18M6 6l12 12" /></Stroke>
)

/**
 * Material Design `MdDelete` (react-icons/md), inlined verbatim — a *filled*
 * trash can. Plugins can't bundle react-icons, so the path is copied in. Used
 * as the "confirm delete" glyph after the first click on a remove control.
 */
export const MdDelete = (p: IconProps): ReactElement =>
  React.createElement(
    'svg',
    { className: p.className, width: '1em', height: '1em', viewBox: '0 0 24 24', fill: 'currentColor', stroke: 'none', 'aria-hidden': true },
    p.title ? <title>{p.title}</title> : null,
    <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
  )

export const Search = (p: IconProps): ReactElement => (
  <Stroke {...p}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></Stroke>
)

export const Trash = (p: IconProps): ReactElement => (
  <Stroke {...p}>
    <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
  </Stroke>
)

export const Pencil = (p: IconProps): ReactElement => (
  <Stroke {...p}><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /><path d="m15 5 4 4" /></Stroke>
)

export const Mail = (p: IconProps): ReactElement => (
  <Stroke {...p}><rect width="20" height="16" x="2" y="4" rx="2" /><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" /></Stroke>
)

export const Phone = (p: IconProps): ReactElement => (
  <Stroke {...p}><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z" /></Stroke>
)

export const MapPin = (p: IconProps): ReactElement => (
  <Stroke {...p}><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" /><circle cx="12" cy="10" r="3" /></Stroke>
)

export const Building = (p: IconProps): ReactElement => (
  <Stroke {...p}>
    <rect width="16" height="20" x="4" y="2" rx="2" /><path d="M9 22v-4h6v4" />
    <path d="M8 6h.01M16 6h.01M8 10h.01M16 10h.01M8 14h.01M16 14h.01" />
  </Stroke>
)

export const Link = (p: IconProps): ReactElement => (
  <Stroke {...p}>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </Stroke>
)

export const Cake = (p: IconProps): ReactElement => (
  <Stroke {...p}>
    <path d="M20 21v-8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8" /><path d="M4 16s.5-1 2-1 2.5 2 4 2 2.5-2 4-2 2.5 2 4 2 2-1 2-1" />
    <path d="M2 21h20" /><path d="M7 8v3M12 8v3M17 8v3" /><path d="M7 4h.01M12 4h.01M17 4h.01" />
  </Stroke>
)

export const GroupGlyph = (p: IconProps): ReactElement => (
  <Stroke {...p}>
    <path d="M3 7V5c0-1.1.9-2 2-2h2M17 3h2c1.1 0 2 .9 2 2v2M21 17v2c0 1.1-.9 2-2 2h-2M7 21H5c-1.1 0-2-.9-2-2v-2" />
    <rect width="7" height="5" x="7" y="5" rx="1" />
    <rect width="7" height="5" x="10" y="14" rx="1" />
  </Stroke>
)

export const Download = (p: IconProps): ReactElement => (
  <Stroke {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M7 10l5 5 5-5" /><path d="M12 15V3" />
  </Stroke>
)


export const FolderOpen = (p: IconProps): ReactElement => (
  <Stroke {...p}>
    <path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
  </Stroke>
)

export const ExternalLink = (p: IconProps): ReactElement => (
  <Stroke {...p}><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></Stroke>
)

export const Copy = (p: IconProps): ReactElement => (
  <Stroke {...p}>
    <rect width="14" height="14" x="8" y="8" rx="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </Stroke>
)

export const FileText = (p: IconProps): ReactElement => (
  <Stroke {...p}>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v5h6" />
    <path d="M8 13h8M8 17h8M8 9h2" />
  </Stroke>
)

/** Drag handle — the app's `LuGripVertical`, restated under our own glyphs. */
export const GripVertical = (p: IconProps): ReactElement => (
  <Stroke {...p}>
    <circle cx="9" cy="5" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="9" cy="19" r="1" />
    <circle cx="15" cy="5" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="15" cy="19" r="1" />
  </Stroke>
)

export const ValleyIcon = (p: IconProps): ReactElement => (
  <svg className={p.className} width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true"
    style={{ mask: 'var(--icon-open-in-new) center / contain no-repeat' }}>
    {p.title ? <title>{p.title}</title> : null}
    <rect width="24" height="24" fill="currentColor" />
  </svg>
)
