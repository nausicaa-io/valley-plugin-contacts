import React from 'react'
import { act, render } from '@testing-library/react'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { describe, it, expect, vi } from 'vitest'
import { RelationGraph } from '../src/RelationGraph'
import { initRuntime } from '../src/runtime'
import { graphLoopShouldContinue, SETTLE_ALPHA } from '../src/relationGraphModel'

// The contacts relationship graph used to redraw its canvas on every animation
// frame forever — even after the force layout had fully settled — repainting a
// static image at the display's refresh rate. `graphLoopShouldContinue` is the
// pure gate that now stops the loop once the graph is settled and idle; pointer /
// zoom / resize / data-change interactions re-kick it (wired in RelationGraph.tsx).

describe('graphLoopShouldContinue (graph render-loop gate)', () => {
  it('keeps drawing while the layout is still settling', () => {
    expect(graphLoopShouldContinue(1, false)).toBe(true)
    expect(graphLoopShouldContinue(SETTLE_ALPHA + 0.001, false)).toBe(true)
  })

  it('stops once settled and nothing is being dragged (idle graph = 0 frames)', () => {
    expect(graphLoopShouldContinue(SETTLE_ALPHA, false)).toBe(false)
    expect(graphLoopShouldContinue(0, false)).toBe(false)
  })

  it('keeps drawing while a node is being dragged, even if settled', () => {
    expect(graphLoopShouldContinue(0, true)).toBe(true)
    expect(graphLoopShouldContinue(SETTLE_ALPHA, true)).toBe(true)
  })

  it('uses a small positive settle threshold', () => {
    expect(SETTLE_ALPHA).toBeGreaterThan(0)
    expect(SETTLE_ALPHA).toBeLessThan(0.1)
  })
})

it('resizes the graph through the visible iframe observer and disconnects on unmount', () => {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const owner = frame.contentWindow as typeof window
  const container = owner.document.body.appendChild(owner.document.createElement('div'))
  let width = 100
  let resized: ResizeObserverCallback | undefined
  const observe = vi.fn()
  const disconnect = vi.fn()
  class FrameObserver {
    constructor(callback: ResizeObserverCallback) { resized = callback }
    observe = observe
    disconnect = disconnect
  }
  Object.defineProperty(owner, 'ResizeObserver', { value: FrameObserver })
  const context = { setTransform: vi.fn() }
  const getContext = vi.spyOn(owner.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
  const getBounds = vi.spyOn(owner.HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width, height: 80 }) as DOMRect)
  const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(1)
  initRuntime(createMockValleyApi({ manifest: { id: 'contacts' } }).api)
  const view = render(React.createElement(RelationGraph, {
    contacts: [], groupConfigs: [], coverPaths: {}, focusPath: null, onOpen: vi.fn()
  }), { container })
  try {
    const canvas = container.querySelector('canvas')!
    expect(observe.mock.calls.some(([element]) => element === canvas)).toBe(true)
    expect(canvas.width).toBe(100)
    width = 250
    act(() => resized?.([], {} as ResizeObserver))
    expect(canvas.width).toBe(250)
    view.unmount()
    expect(disconnect).toHaveBeenCalledOnce()
  } finally {
    view.unmount()
    raf.mockRestore()
    getContext.mockRestore()
    getBounds.mockRestore()
    frame.remove()
  }
})
