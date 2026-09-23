'use client'

import { useEffect, useRef, useState } from 'react'
import type { ServiceMapData } from '../lib/api'
import { serviceColor } from '../lib/format'

// ─────────────────────────────────────────────────────────────────────────────
// CONCEPT: Force-directed graph on Canvas
//
// A force-directed layout simulates physics:
//   • Repulsion: nodes push each other apart (Coulomb's law)
//   • Attraction: edges act as springs pulling connected nodes together
//   • Damping: velocity decays so the simulation converges
//
// We run it with requestAnimationFrame so it's smooth and non-blocking.
// Canvas instead of SVG scales to many nodes without DOM overhead.
//
// INTERVIEW: "Why force-directed instead of a fixed layout?"
//   It works for any graph topology — you don't need to know the structure
//   in advance. Clustering emerges naturally from the edge weights.
//
// Two further forces and a stop condition were added:
//   • Gravity: a weak pull to the centre, so a service with no edges does not
//     drift off and pin itself against a wall.
//   • Settling: once the nodes have (nearly) stopped moving, the loop stops.
//     It used to redraw 60 times a second forever, on an unchanging picture.
// ─────────────────────────────────────────────────────────────────────────────

// `label` is the human name ("payment-service"); `id` is the org-namespaced row
// id ("<org-uuid>:payment-service"). Drawing the id would just show a slice of a
// UUID, so the two are kept separate.
interface Node {
  id: string; label: string
  x: number; y: number; vx: number; vy: number
  w: number; h: number // the drawn pill's size, so arrows can stop at its edge
}
interface Edge { from: string; to: string; callCount: number; avgMs: number }

const HEIGHT = 440

export function ServiceMap({ nodes: rawNodes, edges: rawEdges }: ServiceMapData) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)
  const hasNodes = rawNodes.length > 0

  // Size the canvas to its container, and again whenever the container
  // changes size. A canvas is a bitmap: drawn at one size and stretched by CSS
  // to another, its text and lines come out blurred.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [hasNodes])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || width === 0) return
    const ctx = canvas.getContext('2d')!

    // HiDPI: back the canvas with (devicePixelRatio x) more pixels than it
    // occupies, then scale the drawing context so we keep thinking in CSS px.
    const dpr = window.devicePixelRatio || 1
    const W = width, H = HEIGHT
    canvas.width = W * dpr
    canvas.height = H * dpr
    canvas.style.width = `${W}px`
    canvas.style.height = `${H}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // Pull colours and fonts from the page's CSS, so the canvas matches it.
    const css = getComputedStyle(document.documentElement)
    const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
    const C = {
      ink: token('--ink', '#ebe9e3'),
      muted: token('--ink-muted', '#a3a097'),
      faint: token('--ink-faint', '#6c6960'),
      line: token('--line-strong', '#34332e'),
      panel: token('--panel', '#121211'),
      canvas: token('--canvas', '#0b0b0a'),
    }
    const mono = token('--font-plex-mono', 'ui-monospace, monospace')
    const LABEL_FONT = `12px ${mono}`
    const EDGE_FONT = `10.5px ${mono}`

    // Initialise nodes in a circle to avoid initial overlap
    ctx.font = LABEL_FONT
    const nodes: Node[] = rawNodes.map((n, i) => {
      const angle = (2 * Math.PI * i) / rawNodes.length
      const r = Math.min(W, H) * 0.3
      return {
        id: n.id,
        label: n.name,
        x: W / 2 + r * Math.cos(angle),
        y: H / 2 + r * Math.sin(angle),
        vx: 0, vy: 0,
        w: ctx.measureText(n.name).width + 30,
        h: 26,
      }
    })

    const edges: Edge[] = rawEdges.map(e => ({
      from: e.from_service_id,
      to: e.to_service_id,
      callCount: e.call_count,
      avgMs: e.avg_duration_ms,
    }))

    const nodeById = new Map(nodes.map(n => [n.id, n]))
    let running = true
    let frame = 0

    // These are `const` arrow functions, not `function` declarations, and that
    // is load-bearing: a `function` declaration is hoisted, so TypeScript cannot
    // prove it runs after the `if (!canvas) return` guard above and drops the
    // non-null narrowing inside it ("'canvas' is possibly null"). Arrow consts
    // can only be called after this line, so the narrowing survives.
    const simulate = (): number => {
      const REPULSION = 9000
      const SPRING = 0.012
      const DAMPING = 0.82
      const REST_LEN = Math.max(200, W * 0.2) // wider canvas, longer edges
      const GRAVITY = 0.004

      // Repulsion between all node pairs
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j]
          const dx = b.x - a.x, dy = b.y - a.y
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          const force = REPULSION / (dist * dist)
          a.vx -= (dx / dist) * force
          a.vy -= (dy / dist) * force
          b.vx += (dx / dist) * force
          b.vy += (dy / dist) * force
        }
      }

      // Spring attraction along edges
      for (const e of edges) {
        const a = nodeById.get(e.from), b = nodeById.get(e.to)
        if (!a || !b) continue
        const dx = b.x - a.x, dy = b.y - a.y
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const force = (dist - REST_LEN) * SPRING
        a.vx += (dx / dist) * force
        a.vy += (dy / dist) * force
        b.vx -= (dx / dist) * force
        b.vy -= (dy / dist) * force
      }

      // Gravity, integrate, damp, clamp — and measure how much is still moving
      let energy = 0
      for (const n of nodes) {
        n.vx += (W / 2 - n.x) * GRAVITY
        n.vy += (H / 2 - n.y) * GRAVITY
        n.vx *= DAMPING; n.vy *= DAMPING
        n.x = Math.max(n.w / 2 + 8, Math.min(W - n.w / 2 - 8, n.x + n.vx))
        n.y = Math.max(n.h / 2 + 8, Math.min(H - n.h / 2 - 8, n.y + n.vy))
        energy += n.vx * n.vx + n.vy * n.vy
      }
      return energy
    }

    // Where the line from `a`'s centre towards `b`'s centre crosses the edge
    // of b's pill (plus a small gap), so arrowheads touch the pill, not hide
    // under it.
    const boundary = (a: Node, b: Node, gap = 5) => {
      const dx = b.x - a.x, dy = b.y - a.y
      const tx = dx === 0 ? Infinity : (b.w / 2 + gap) / Math.abs(dx)
      const ty = dy === 0 ? Infinity : (b.h / 2 + gap) / Math.abs(dy)
      const t = Math.min(tx, ty)
      return { x: b.x - dx * t, y: b.y - dy * t }
    }

    const draw = () => {
      ctx.clearRect(0, 0, W, H)

      // Draw edges
      for (const e of edges) {
        const a = nodeById.get(e.from), b = nodeById.get(e.to)
        if (!a || !b) continue
        const start = boundary(b, a, 3)
        const end = boundary(a, b)

        ctx.beginPath()
        ctx.moveTo(start.x, start.y)
        ctx.lineTo(end.x, end.y)
        // Edges carry the map's meaning, so they are drawn brighter than the
        // pill outlines (which only frame the labels).
        ctx.strokeStyle = C.faint
        // Thickness grows with the log of call volume: 10x the calls reads as
        // one step thicker, so a busy edge stands out without swamping the map.
        ctx.lineWidth = Math.min(4, 1 + Math.log10(e.callCount + 1) * 0.8)
        ctx.stroke()

        // Arrowhead
        const angle = Math.atan2(end.y - start.y, end.x - start.x)
        ctx.beginPath()
        ctx.moveTo(end.x, end.y)
        ctx.lineTo(end.x - 8 * Math.cos(angle - 0.42), end.y - 8 * Math.sin(angle - 0.42))
        ctx.lineTo(end.x - 8 * Math.cos(angle + 0.42), end.y - 8 * Math.sin(angle + 0.42))
        ctx.closePath()
        ctx.fillStyle = C.muted
        ctx.fill()

        // Call count + average latency, on a background chip so it stays
        // legible where it crosses the line.
        const text = `${e.callCount.toLocaleString('en-US')} calls · ${Math.round(e.avgMs)} ms`
        ctx.font = EDGE_FONT
        const tw = ctx.measureText(text).width
        const mx = (start.x + end.x) / 2, my = (start.y + end.y) / 2
        ctx.fillStyle = C.canvas
        ctx.fillRect(mx - tw / 2 - 5, my - 8, tw + 10, 16)
        ctx.fillStyle = C.faint
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(text, mx, my)
      }

      // Draw nodes as labelled pills, marked with the service's colour
      ctx.font = LABEL_FONT
      for (const n of nodes) {
        const x = n.x - n.w / 2, y = n.y - n.h / 2
        ctx.beginPath()
        ctx.roundRect(x, y, n.w, n.h, 4)
        ctx.fillStyle = C.panel
        ctx.fill()
        ctx.lineWidth = 1
        ctx.strokeStyle = C.line
        ctx.stroke()

        ctx.fillStyle = serviceColor(n.label)
        ctx.beginPath()
        ctx.roundRect(x + 10, n.y - 4, 8, 8, 2)
        ctx.fill()

        ctx.fillStyle = C.ink
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        ctx.fillText(n.label, x + 24, n.y + 0.5)
      }
    }

    const tick = () => {
      if (!running) return
      const energy = simulate()
      draw()
      frame++
      // Stop once settled (or after ~15s at 60fps, whichever comes first).
      if ((frame > 60 && energy < 0.02) || frame > 900) return
      requestAnimationFrame(tick)
    }

    requestAnimationFrame(tick)
    return () => { running = false }
  }, [rawNodes, rawEdges, width])

  if (!hasNodes) {
    return (
      <div className="rounded border border-line bg-panel px-5 py-8">
        <p className="text-[13px] text-ink-muted">No services yet.</p>
        <p className="mt-1 text-[13px] text-ink-faint">
          Services appear here once they are created and start sending spans.
        </p>
      </div>
    )
  }

  return (
    <div ref={wrapRef} className="overflow-hidden rounded border border-line bg-canvas">
      <canvas ref={canvasRef} role="img" aria-label="Service dependency map" className="block" />
    </div>
  )
}
