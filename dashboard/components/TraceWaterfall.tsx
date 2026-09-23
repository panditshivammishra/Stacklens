'use client'

import { Fragment, useState } from 'react'
import { serviceName, type Span } from '../lib/api'
import { clockTime, formatMs, serviceColor } from '../lib/format'
import { ServiceTag } from './ui'

// ─────────────────────────────────────────────────────────────────────────────
// CONCEPT: Trace waterfall (Gantt chart)
//
// Every span has a start_time (epoch ms) and duration.
// We normalize all spans relative to the earliest start_time = 0.
// Each span bar is: left offset = (start - min) / totalDuration * 100%
//                   width       = duration / totalDuration * 100%
//
// ROW ORDER IS THE CALL TREE, not the clock.
// Spans are linked child → parent through parent_span_id. We turn that into a
// tree and walk it depth-first: a span, then each of its children (earliest
// first), then the next span. Sorting purely by start time — what this used to
// do — can print a child underneath the wrong parent whenever two siblings'
// work overlaps in time, and then the indentation lies about who called whom.
//
// A span whose parent is not in the trace (the parent lived in a service that
// is not instrumented, or its batch has not arrived yet) is treated as a root
// rather than dropped.
// ─────────────────────────────────────────────────────────────────────────────

interface Row {
  span: Span
  depth: number
  /** One entry per ancestor level: keep drawing that level's vertical guide? */
  guides: boolean[]
  isLast: boolean
}

function buildRows(spans: Span[]): Row[] {
  const ids = new Set(spans.map(s => s.span_id))
  const children = new Map<string | null, Span[]>()
  for (const s of spans) {
    const parent = s.parent_span_id && ids.has(s.parent_span_id) ? s.parent_span_id : null
    const list = children.get(parent) ?? []
    list.push(s)
    children.set(parent, list)
  }
  for (const list of children.values()) list.sort((a, b) => a.start_time - b.start_time)

  const rows: Row[] = []
  const visited = new Set<string>() // cycle guard: a malformed trace must not hang the page

  const walk = (parent: string | null, depth: number, guides: boolean[]) => {
    const list = children.get(parent) ?? []
    list.forEach((span, i) => {
      if (visited.has(span.span_id)) return
      visited.add(span.span_id)
      const isLast = i === list.length - 1
      rows.push({ span, depth, guides, isLast })
      walk(span.span_id, depth + 1, [...guides, !isLast])
    })
  }
  walk(null, 0, [])
  return rows
}

const INDENT = 16   // px per tree level
const ROW_H = 30    // px — the tree guides are drawn against this

interface Props { spans: Span[] }

export function TraceWaterfall({ spans }: Props) {
  const [open, setOpen] = useState<string | null>(null)

  if (spans.length === 0) return <p className="text-ink-faint">No spans found.</p>

  const rows = buildRows(spans)
  const minStart = Math.min(...spans.map(s => s.start_time))
  const maxEnd = Math.max(...spans.map(s => s.start_time + (s.duration ?? 0)))
  const total = maxEnd - minStart || 1
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  const services = [...new Set(spans.map(s => serviceName(s.service_id)))]

  return (
    <div>
      {/* Legend — which colour is which service in THIS trace. */}
      <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1">
        {services.map(name => (
          <ServiceTag key={name} id={name} />
        ))}
        <span className="inline-flex items-center gap-2 text-[12px] text-ink-faint">
          <span aria-hidden className="h-2 w-3 rounded-xs bg-err" />
          error
        </span>
      </div>

      <div className="overflow-x-auto rounded border border-line bg-panel">
        <div className="min-w-190">
          {/* Ruler */}
          <div className="grid grid-cols-[minmax(260px,34%)_1fr_84px] border-b border-line text-[11.5px] text-ink-faint">
            <div className="px-4 py-2 font-medium">Span</div>
            <div className="relative mx-3">
              {ticks.map(t => (
                <span
                  key={t}
                  className="absolute top-1/2 -translate-y-1/2 font-mono"
                  // Only the horizontal centring goes in `transform`. Tailwind v4's
                  // -translate-y-1/2 uses the separate CSS `translate` property,
                  // and the two stack — a translate(-50%,-50%) here would shift
                  // these labels up twice.
                  style={
                    t === 0 ? { left: 0 } :
                    t === 1 ? { right: 0 } :
                    { left: `${t * 100}%`, transform: 'translateX(-50%)' }
                  }
                >
                  {formatMs(t * total)}
                </span>
              ))}
            </div>
            <div className="px-4 py-2 text-right font-medium">Duration</div>
          </div>

          {rows.map(({ span, depth, guides, isLast }) => {
            const left = ((span.start_time - minStart) / total) * 100
            const width = Math.max(((span.duration ?? 0) / total) * 100, 0.4)
            const failed = span.status === 'error'
            const expanded = open === span.span_id
            const code = span.metadata?.statusCode
            const color = serviceColor(span.service_id)

            return (
              <Fragment key={span.span_id}>
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : span.span_id)}
                  aria-expanded={expanded}
                  className={`grid w-full grid-cols-[minmax(260px,34%)_1fr_84px] items-stretch border-b border-line text-left transition-colors last:border-0 ${
                    expanded ? 'bg-raised' : 'hover:bg-raised/60'
                  }`}
                  style={{ height: ROW_H }}
                >
                  {/* Label, with tree guides */}
                  <span className="relative flex min-w-0 items-center gap-2 pr-3" style={{ paddingLeft: 16 + depth * INDENT }}>
                    <TreeGuides depth={depth} guides={guides} isLast={isLast} />
                    <span aria-hidden className="size-2 shrink-0 rounded-xs" style={{ background: color }} />
                    <span className="shrink-0 font-mono text-[12px] text-ink-faint">
                      {serviceName(span.service_id)}
                    </span>
                    <span className="truncate font-mono text-[12.5px] text-ink">{span.operation}</span>
                    {failed && code != null && (
                      <span className="shrink-0 rounded-[3px] bg-err/15 px-1 font-mono text-[11px] text-err">
                        {String(code)}
                      </span>
                    )}
                  </span>

                  {/* Bar track, with quarter gridlines behind it */}
                  <span className="relative mx-3 block">
                    {ticks.slice(1, -1).map(t => (
                      <span key={t} aria-hidden className="absolute inset-y-0 w-px bg-line/70" style={{ left: `${t * 100}%` }} />
                    ))}
                    <span
                      className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-xs"
                      style={{
                        left: `${left}%`,
                        width: `${width}%`,
                        background: failed ? 'var(--err)' : color,
                        opacity: failed ? 1 : 0.85,
                      }}
                    />
                  </span>

                  <span className={`flex items-center justify-end px-4 font-mono text-[12.5px] ${failed ? 'text-err' : 'text-ink-muted'}`}>
                    {formatMs(span.duration)}
                  </span>
                </button>

                {expanded && <SpanDetail span={span} offsetMs={span.start_time - minStart} />}
              </Fragment>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// The ├ and └ connectors, drawn with borders. For each ancestor level we either
// continue a vertical line (that ancestor still has siblings further down) or
// leave a gap; the final level gets the elbow into this row.
function TreeGuides({ depth, guides, isLast }: { depth: number; guides: boolean[]; isLast: boolean }) {
  if (depth === 0) return null
  const x = (level: number) => 16 + level * INDENT + 3.5 // centre of that level's colour mark
  return (
    <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0">
      {guides.slice(0, -1).map((on, level) =>
        on ? <span key={level} className="absolute inset-y-0 w-px bg-line-strong" style={{ left: x(level) }} /> : null,
      )}
      <span
        className="absolute top-0 w-px bg-line-strong"
        style={{ left: x(depth - 1), height: isLast ? ROW_H / 2 : ROW_H }}
      />
      <span
        className="absolute h-px bg-line-strong"
        style={{ left: x(depth - 1), top: ROW_H / 2, width: INDENT - 6 }}
      />
    </span>
  )
}

function SpanDetail({ span, offsetMs }: { span: Span; offsetMs: number }) {
  const fields: [string, string][] = [
    ['service', serviceName(span.service_id)],
    ['operation', span.operation],
    ['status', span.status],
    ['duration', formatMs(span.duration)],
    ['starts at', `+${formatMs(offsetMs)} into the trace`],
    ['wall clock', clockTime(span.start_time)],
    ['span id', span.span_id],
    ['parent id', span.parent_span_id ?? '— (root)'],
    ...Object.entries(span.metadata ?? {}).map(
      ([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)] as [string, string],
    ),
  ]
  return (
    <div className="border-b border-line bg-canvas/60 px-4 py-3">
      <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-1 text-[12.5px] sm:grid-cols-[120px_1fr_120px_1fr]">
        {fields.map(([k, v]) => (
          <Fragment key={k}>
            <dt className="text-ink-faint">{k}</dt>
            <dd className="truncate font-mono text-ink-muted" title={v} suppressHydrationWarning>
              {v}
            </dd>
          </Fragment>
        ))}
      </dl>
    </div>
  )
}
