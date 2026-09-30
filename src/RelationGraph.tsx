import type { ReactElement } from 'react'
import { assetUrlForRelPath } from '@valley/plugin-sdk/fileTypes'
import { readPaletteColor } from '@valley/plugin-sdk/palette'
import { React } from './runtime'
import type { Contact, ContactGroup, RelationType } from './types'
import {
  RELATION_COLORS,
  RELATION_LABELS,
  RELATION_TYPES,
  SETTLE_ALPHA,
  buildRelationGraph,
  graphLoopShouldContinue,
  tick,
  type GraphData,
  type GraphNode
} from './relationGraphModel'
import { DEFAULT_AVATAR_COLOR } from './data'
import { uiText } from './localization'

interface Props {
  contacts: Contact[]
  groupConfigs: ContactGroup[]
  coverPaths: Record<string, string | null>
  focusPath: string | null
  onOpen: (relPath: string) => void
}

/** Force-directed relationship graph rendered on a canvas. */
export function RelationGraph({ contacts, groupConfigs, coverPaths, focusPath, onOpen }: Props): ReactElement {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const [local, setLocal] = React.useState(false)
  const [hidden, setHidden] = React.useState<Set<RelationType>>(new Set())

  // Mutable rendering state kept in refs so the RAF loop sees the latest values.
  const graphRef = React.useRef<GraphData>({ nodes: [], edges: [] })
  const imageCacheRef = React.useRef(new Map<string, HTMLImageElement | null>())
  const camRef = React.useRef({ scale: 1, x: 0, y: 0 })
  const dragRef = React.useRef<{ node: GraphNode | null; moved: boolean; px: number; py: number }>(
    { node: null, moved: false, px: 0, py: 0 }
  )
  const alphaRef = React.useRef(1)
  // Restarts the render loop after it self-terminates (settled). Populated by the
  // loop effect; called by input changes and pointer / zoom / resize interactions.
  const kickRef = React.useRef<() => void>(() => {})
  // Latest focusPath, read inside the stable loop without re-creating it.
  const focusPathRef = React.useRef(focusPath)
  focusPathRef.current = focusPath

  // Rebuild the graph whenever inputs change.
  React.useEffect(() => {
    const typeFilter = hidden.size ? new Set(RELATION_TYPES.filter((t) => !hidden.has(t))) : null
    graphRef.current = buildRelationGraph(contacts, {
      focusPath: local ? focusPath : null,
      typeFilter,
      groupConfigs,
      coverPaths
    })
    alphaRef.current = 1
    // Fit camera to content after the first settle.
    camRef.current = { scale: 1, x: 0, y: 0 }
    // Inputs changed → the layout must re-settle; restart the loop if it had
    // stopped (the loop is stable across these deps and won't restart itself).
    kickRef.current()
  }, [contacts, groupConfigs, coverPaths, focusPath, local, hidden])

  // Animation + rendering loop.
  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let raf = 0

    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      canvas.width = Math.max(1, Math.floor(rect.width * dpr))
      canvas.height = Math.max(1, Math.floor(rect.height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      // A resize changes the canvas backing store → repaint even if settled.
      kickRef.current()
    }
    resize()
    const Observer = (canvas.ownerDocument.defaultView as typeof window | null)?.ResizeObserver ?? globalThis.ResizeObserver
    const ro = Observer ? new Observer(resize) : null
    ro?.observe(canvas)

    const draw = (): void => {
      const rect = canvas.getBoundingClientRect()
      const cam = camRef.current
      const cx = rect.width / 2 + cam.x
      const cy = rect.height / 2 + cam.y
      const s = cam.scale
      ctx.clearRect(0, 0, rect.width, rect.height)
      const { nodes, edges } = graphRef.current
      const byId = new Map(nodes.map((n) => [n.id, n]))

      ctx.lineWidth = 1.2
      for (const e of edges) {
        const a = byId.get(e.source)
        const b = byId.get(e.target)
        if (!a || !b) continue
        ctx.strokeStyle = RELATION_COLORS[e.relType]
        ctx.globalAlpha = 0.55
        ctx.beginPath()
        ctx.moveTo(cx + a.x * s, cy + a.y * s)
        ctx.lineTo(cx + b.x * s, cy + b.y * s)
        ctx.stroke()
      }
      ctx.globalAlpha = 1

      const showLabels = nodes.length <= 80 || s > 1.1
      const coverImage = (coverPath: string | null): HTMLImageElement | null => {
        if (!coverPath) return null
        const cached = imageCacheRef.current.get(coverPath)
        if (cached !== undefined) return cached
        const img = new Image()
        img.onload = () => {
          imageCacheRef.current.set(coverPath, img)
          kickRef.current() // a late-loading avatar must repaint once, even if settled
        }
        img.onerror = () => imageCacheRef.current.set(coverPath, null)
        imageCacheRef.current.set(coverPath, img)
        img.src = assetUrlForRelPath(coverPath)
        return img
      }
      for (const n of nodes) {
        const px = cx + n.x * s
        const py = cy + n.y * s
        const r = Math.min(13, 5 + n.degree * 1.4) * Math.min(1.4, Math.max(0.7, s))
        const focused = n.id === focusPathRef.current
        const img = coverImage(n.coverPath)
        ctx.beginPath()
        ctx.arc(px, py, r, 0, Math.PI * 2)
        if (img && img.complete && img.naturalWidth > 0) {
          ctx.save()
          ctx.clip()
          ctx.drawImage(img, px - r, py - r, r * 2, r * 2)
          ctx.restore()
        } else {
          ctx.fillStyle = DEFAULT_AVATAR_COLOR
          ctx.fill()
          if (n.group) {
            ctx.lineWidth = 2
            ctx.strokeStyle = readPaletteColor(n.groupColor)
            ctx.stroke()
          }
        }
        if (focused) {
          ctx.lineWidth = 2.5
          ctx.strokeStyle = '#ffffff'
          ctx.stroke()
        }
        if (showLabels) {
          ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--text-color') || '#222'
          ctx.font = '11px system-ui, sans-serif'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'top'
          ctx.fillText(n.label, px, py + r + 2)
        }
      }

      if (alphaRef.current > SETTLE_ALPHA) {
        alphaRef.current = tick(graphRef.current, alphaRef.current, dragRef.current.node?.id ?? null)
      }
      // Stop once the layout has settled and nothing is being dragged; pointer /
      // zoom / resize / data-change interactions re-kick the loop via kickRef.
      raf = graphLoopShouldContinue(alphaRef.current, !!dragRef.current.node)
        ? requestAnimationFrame(draw)
        : 0
    }
    const kick = (): void => {
      if (!raf) raf = requestAnimationFrame(draw)
    }
    kickRef.current = kick
    kick()
    return () => {
      if (raf) cancelAnimationFrame(raf)
      ro?.disconnect()
      kickRef.current = () => {}
    }
  }, [])

  const toWorld = (clientX: number, clientY: number): { x: number; y: number } => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const cam = camRef.current
    const cx = rect.width / 2 + cam.x
    const cy = rect.height / 2 + cam.y
    return { x: (clientX - rect.left - cx) / cam.scale, y: (clientY - rect.top - cy) / cam.scale }
  }

  const hitNode = (clientX: number, clientY: number): GraphNode | null => {
    const w = toWorld(clientX, clientY)
    let best: GraphNode | null = null
    let bestD = 16 * 16
    for (const n of graphRef.current.nodes) {
      const dx = n.x - w.x
      const dy = n.y - w.y
      const d2 = dx * dx + dy * dy
      if (d2 < bestD) { bestD = d2; best = n }
    }
    return best
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    ;(e.target as HTMLCanvasElement).setPointerCapture(e.pointerId)
    const node = hitNode(e.clientX, e.clientY)
    dragRef.current = { node, moved: false, px: e.clientX, py: e.clientY }
    alphaRef.current = Math.max(alphaRef.current, 0.4)
    kickRef.current()
  }
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current
    if (e.buttons === 0) return
    const dx = e.clientX - drag.px
    const dy = e.clientY - drag.py
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
    drag.px = e.clientX
    drag.py = e.clientY
    if (drag.node) {
      const w = toWorld(e.clientX, e.clientY)
      drag.node.x = w.x
      drag.node.y = w.y
    } else {
      camRef.current.x += dx
      camRef.current.y += dy
    }
    // Panning a settled graph (drag.node === null) won't keep the loop alive on
    // its own — repaint this move.
    kickRef.current()
  }
  const onPointerUp = (_e: React.PointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current
    if (drag.node && !drag.moved) onOpen(drag.node.id)
    dragRef.current = { node: null, moved: false, px: 0, py: 0 }
  }
  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>): void => {
    const factor = e.deltaY < 0 ? 1.1 : 0.9
    camRef.current.scale = Math.min(4, Math.max(0.2, camRef.current.scale * factor))
    kickRef.current()
  }

  const toggleType = (t: RelationType): void => {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t)
      else next.add(t)
      return next
    })
  }

  return (
    <div className="ct-graph">
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
      />
      {focusPath && (
        <div className="ct-graph-modes">
          <button className={`ct-tab${local ? '' : ' active'}`} onClick={() => setLocal(false)}>{uiText('auto.5f1184f7df96')}</button>
          <button className={`ct-tab${local ? ' active' : ''}`} onClick={() => setLocal(true)}>{uiText('auto.dc99d54d9990')}</button>
        </div>
      )}
      <div className="ct-graph-legend">
        {RELATION_TYPES.map((t) => (
          <span key={t} className={`ct-legend-item${hidden.has(t) ? ' off' : ''}`} onClick={() => toggleType(t)}>
            <span className="ct-legend-dot" style={{ background: RELATION_COLORS[t] }} />
            {RELATION_LABELS[t]}
          </span>
        ))}
      </div>
    </div>
  )
}
