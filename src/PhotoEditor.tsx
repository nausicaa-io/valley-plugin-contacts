import type { ReactElement } from 'react'
import { assetUrlForRelPath, fileExtension, IMAGE_EXTENSIONS } from '@valley/plugin-sdk/fileTypes'
import { React, api } from './runtime'
import { getContactIndex } from './indexOwner'
import { Plus, Search, User, X } from './icons'
import { uiText } from './localization'

const ZOOM_MAX = 5
/** Edge of the saved square photo: sharp on a retina avatar, small enough to keep a card light. */
const PHOTO_SIZE = 512
const CENTERED = { x: 50, y: 50, zoom: 1 }
type Crop = typeof CENTERED

const isImage = (path: string): boolean => (IMAGE_EXTENSIONS as readonly string[]).includes(fileExtension(path))
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    // Realm assets are served with an open CORS header, so the canvas stays readable.
    if (!src.startsWith('data:')) image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(uiText('contacts.photo.unreadable')))
    image.src = src
  })
}

/** The square the crop keeps, in image pixels: `object-fit: cover` scaled by `zoom` around the focal point. */
function cropRect(width: number, height: number, crop: Crop): { sx: number; sy: number; size: number } {
  const size = Math.min(width, height) / crop.zoom
  return { sx: (width - size) * crop.x / 100, sy: (height - size) * crop.y / 100, size }
}

/** Render the framed square to a JPEG data URI, the value a vCard 4.0 `PHOTO` carries. */
export async function renderPhoto(src: string, crop: Crop): Promise<string> {
  const image = await loadImage(src)
  const { sx, sy, size } = cropRect(image.naturalWidth, image.naturalHeight, crop)
  const out = Math.min(PHOTO_SIZE, Math.round(size)) || PHOTO_SIZE
  const canvas = document.createElement('canvas')
  canvas.width = out
  canvas.height = out
  const context = canvas.getContext('2d')
  if (!context) throw new Error(uiText('contacts.photo.unreadable'))
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, sx, sy, size, size, 0, 0, out, out)
  // JPEG keeps a card small; an image with see-through parts stays PNG so it is not flattened onto a colour.
  const pixels = context.getImageData(0, 0, out, out).data
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < 255) return canvas.toDataURL('image/png')
  return canvas.toDataURL('image/jpeg', 0.88)
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error(uiText('contacts.photo.unreadable')))
    reader.readAsDataURL(file)
  })
}

/** Drag to move the image, scroll or use the slider to zoom; the round frame is what the avatar shows. */
function CropFrame({ src, onBack, onSave }: { src: string; onBack: () => void; onSave: (crop: Crop) => void }): ReactElement {
  const [crop, setCrop] = React.useState<Crop>(CENTERED)
  const [natural, setNatural] = React.useState<{ w: number; h: number } | null>(null)
  const frameRef = React.useRef<HTMLDivElement>(null)
  const drag = React.useRef<{ id: number; px: number; py: number; x: number; y: number } | null>(null)
  const setZoom = (zoom: number): void => setCrop((c) => ({ ...c, zoom: Math.min(ZOOM_MAX, Math.max(1, zoom)) }))

  React.useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      setCrop((c) => ({ ...c, zoom: Math.min(ZOOM_MAX, Math.max(1, c.zoom * Math.exp(-event.deltaY * 0.002))) }))
    }
    frame.addEventListener('wheel', onWheel, { passive: false })
    return () => frame.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerMove = (event: React.PointerEvent): void => {
    const start = drag.current
    const frame = frameRef.current
    if (!start || start.id !== event.pointerId || !frame || !natural) return
    // Pixels on screen per percent of travel: the image overflows the frame by (scaled size − frame).
    const scale = frame.clientWidth / (Math.min(natural.w, natural.h) / crop.zoom)
    const sx = (natural.w - Math.min(natural.w, natural.h) / crop.zoom) * scale / 100
    const sy = (natural.h - Math.min(natural.w, natural.h) / crop.zoom) * scale / 100
    setCrop((c) => ({
      ...c,
      x: sx > 0 ? Math.min(100, Math.max(0, start.x - (event.clientX - start.px) / sx)) : 50,
      y: sy > 0 ? Math.min(100, Math.max(0, start.y - (event.clientY - start.py) / sy)) : 50
    }))
  }

  // Place the image so the crop square fills the frame exactly.
  const style = ((): React.CSSProperties | undefined => {
    const frame = frameRef.current
    if (!natural || !frame) return { opacity: 0 }
    const { sx, sy, size } = cropRect(natural.w, natural.h, crop)
    const scale = frame.clientWidth / size
    return { width: natural.w * scale, height: natural.h * scale, transform: `translate(${-sx * scale}px, ${-sy * scale}px)` }
  })()

  return (
    <div className="ct-photo-crop">
      <div
        ref={frameRef}
        className="ct-photo-crop-frame"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { id: event.pointerId, px: event.clientX, py: event.clientY, x: crop.x, y: crop.y }
        }}
        onPointerMove={onPointerMove}
        onPointerUp={() => { drag.current = null }}
        onPointerCancel={() => { drag.current = null }}
        onDoubleClick={() => setCrop(CENTERED)}
      >
        <img
          src={src}
          alt=""
          draggable={false}
          crossOrigin={src.startsWith('data:') ? undefined : 'anonymous'}
          onLoad={(event) => setNatural({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight })}
          style={style}
        />
        <div className="ct-photo-crop-mask" aria-hidden="true" />
      </div>
      <div className="ct-photo-crop-zoom">
        <button type="button" onClick={() => setZoom(crop.zoom / 1.25)} aria-label={uiText('contacts.photo.zoomOut')}>−</button>
        <input type="range" min={1} max={ZOOM_MAX} step={0.01} value={crop.zoom} aria-label={uiText('contacts.photo.zoom')} onChange={(event) => setZoom(Number(event.target.value))} />
        <button type="button" onClick={() => setZoom(crop.zoom * 1.25)} aria-label={uiText('contacts.photo.zoomIn')}>+</button>
      </div>
      <div className="ct-photo-crop-hint">{uiText('contacts.photo.hint')}</div>
      <div className="ct-photo-actions">
        <button type="button" onClick={onBack}>{uiText('contacts.photo.back')}</button>
        <button type="button" onClick={() => setCrop(CENTERED)}>{uiText('contacts.photo.reset')}</button>
        <button type="button" className="primary" disabled={!natural} onClick={() => onSave(crop)}>{uiText('contacts.photo.save')}</button>
      </div>
    </div>
  )
}

/** Pick an image (realm search, a file from disk, a drop or a paste), then frame it. */
function PhotoPicker({ initial, onPick, onClose }: { initial: string | null; onPick: (photo: string) => void; onClose: () => void }): ReactElement {
  const [query, setQuery] = React.useState('')
  const [editing, setEditing] = React.useState<string | null>(initial)
  const [dragOver, setDragOver] = React.useState(false)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const fileInput = React.useRef<HTMLInputElement>(null)
  // The contacts index already lists the realm's images (covers resolve by name).
  const index = getContactIndex(api)
  const snapshot = React.useSyncExternalStore(index.subscribe, index.getSnapshot)
  const entries = React.useMemo(() => snapshot.status === 'ready' ? snapshot.entries.map((entry) => entry.relPath).filter(isImage) : [], [snapshot])
  const images = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    return (q ? entries.filter((path) => baseName(path).toLowerCase().includes(q)) : entries).slice(0, 120)
  }, [entries, query])

  const useFile = async (file: File | undefined): Promise<void> => {
    if (!file || !file.type.startsWith('image/')) return
    try { setEditing(await readFile(file)); setError('') } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  React.useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      const file = Array.from(event.clipboardData?.files ?? []).find((entry) => entry.type.startsWith('image/'))
      if (file) { event.preventDefault(); void useFile(file) }
    }
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('paste', onPaste)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('paste', onPaste); document.removeEventListener('keydown', onKey) }
  }, [onClose])

  const save = async (crop: Crop): Promise<void> => {
    if (!editing) return
    setBusy(true)
    try { onPick(await renderPhoto(editing, crop)) } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false) }
  }

  return (
    <div className="ct-photo-backdrop" data-plugin-widget-occluder="" onMouseDown={onClose}>
      <div
        className={`ct-photo-picker${dragOver ? ' dragover' : ''}`}
        role="dialog"
        aria-label={uiText('contacts.photo.title')}
        onMouseDown={(event) => event.stopPropagation()}
        onDragOver={(event) => { if (Array.from(event.dataTransfer.types).includes('Files')) { event.preventDefault(); setDragOver(true) } }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOver(false) }}
        onDrop={(event) => { event.preventDefault(); setDragOver(false); void useFile(event.dataTransfer.files?.[0]) }}
      >
        <div className="ct-photo-head">
          <span>{editing ? uiText('contacts.photo.frame') : uiText('contacts.photo.title')}</span>
          <button type="button" onClick={onClose} aria-label={uiText('contacts.photo.close')}><X /></button>
        </div>
        {error && <p role="alert" className="ct-form-error">{error}</p>}
        {editing ? (
          <CropFrame src={editing} onBack={() => setEditing(null)} onSave={(crop) => { if (!busy) void save(crop) }} />
        ) : (
          <>
            <div className="ct-photo-toolbar">
              <div className="search-field ct-photo-search">
                <Search className="search-field-icon" />
                <input className="search-field-input" autoFocus value={query} placeholder={uiText('contacts.photo.search')} onChange={(event) => setQuery(event.target.value)} />
              </div>
              <button type="button" className="ct-photo-upload" onClick={() => fileInput.current?.click()}><Plus /> {uiText('contacts.photo.fromComputer')}</button>
              <input ref={fileInput} type="file" accept="image/*" hidden onChange={(event) => { void useFile(event.target.files?.[0]); event.target.value = '' }} />
            </div>
            <div className="ct-photo-grid">
              {images.map((path) => (
                <button key={path} type="button" className="ct-photo-tile" title={path} onClick={() => setEditing(assetUrlForRelPath(path))}>
                  <img src={assetUrlForRelPath(path)} alt="" loading="lazy" />
                  <span>{baseName(path)}</span>
                </button>
              ))}
            </div>
            {!images.length && <div className="ct-photo-empty">{uiText('contacts.photo.empty')}</div>}
            <div className="ct-photo-crop-hint ct-photo-drop-hint">{uiText('contacts.photo.dropHint')}</div>
          </>
        )}
      </div>
    </div>
  )
}

/** The contact's photo in the editor: preview, choose or edit, remove. The result is embedded in the card. */
export function PhotoField({ photo, fallback, initials, onChange }: {
  photo: string
  /** Shown when the card has no photo yet (a linked cover image). */
  fallback: string
  initials: string
  onChange: (photo: string) => void
}): ReactElement {
  const [open, setOpen] = React.useState<null | 'new' | 'edit'>(null)
  const shown = photo || fallback
  return (
    <div className="ct-photo-field">
      <button type="button" className="ct-photo-preview" onClick={() => setOpen(shown ? 'edit' : 'new')} aria-label={uiText(shown ? 'contacts.photo.edit' : 'contacts.photo.choose')}>
        {shown ? <img src={shown} alt="" /> : <span className="ct-photo-initials">{initials || <User />}</span>}
      </button>
      <div className="ct-photo-buttons">
        <button type="button" className="ct-rep-add" onClick={() => setOpen('new')}>{uiText('contacts.photo.choose')}</button>
        {shown && <button type="button" className="ct-rep-add" onClick={() => setOpen('edit')}>{uiText('contacts.photo.edit')}</button>}
        {photo && <button type="button" className="ct-rep-add" onClick={() => onChange('')}>{uiText('contacts.photo.remove')}</button>}
      </div>
      {open && (
        <PhotoPicker
          initial={open === 'edit' ? shown : null}
          onClose={() => setOpen(null)}
          onPick={(next) => { onChange(next); setOpen(null) }}
        />
      )}
    </div>
  )
}
