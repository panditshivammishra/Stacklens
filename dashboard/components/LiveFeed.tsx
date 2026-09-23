'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSSE, type StreamStatus } from '../hooks/useSSE'
import { type Span } from '../lib/api'
import { clockTime, formatMs } from '../lib/format'
import { Empty, Panel, SectionHeader, ServiceTag, StatusMark, table } from './ui'

// ─────────────────────────────────────────────────────────────────────────────
// CONCEPT: Circular buffer for the live feed
//
// We keep at most MAX_ITEMS spans in state. When the buffer is full,
// unshift() + slice() discards the oldest — same strategy as the SDK buffer.
// React state update triggers re-render only when new spans arrive.
//
// SEEDING: the page's server component passes the most recent spans in as
// `initial`, so the table is full the moment the page opens. Without that it
// sat empty until the next batch arrived, which looked like nothing was
// happening even while traffic was flowing. Live rows are marked `live` so
// only they get the brief highlight — the seeded ones were already there.
// ─────────────────────────────────────────────────────────────────────────────
const MAX_ITEMS = 50

interface Row {
  span: Span
  live: boolean
}

export function LiveFeed({ initial = [] }: { initial?: Span[] }) {
  const [rows, setRows] = useState<Row[]>(() =>
    initial.slice(0, MAX_ITEMS).map(span => ({ span, live: false })),
  )
  const { record, buckets, rate } = useThroughput()

  const onSpans = useCallback(
    (incoming: Span[]) => {
      record(incoming)
      setRows(prev => {
        // A span can in principle reach us twice (once in `initial`, once
        // live); two rows with one key would confuse React's reconciliation.
        const seen = new Set(prev.map(r => r.span.span_id))
        const fresh = incoming
          .filter(s => !seen.has(s.span_id))
          .sort((a, b) => b.start_time - a.start_time)
          .map(span => ({ span, live: true }))
        return [...fresh, ...prev].slice(0, MAX_ITEMS)
      })
    },
    [record],
  )

  const status = useSSE<Span[]>('spans', onSpans)

  // Longest duration currently on screen — each row's small bar is drawn
  // relative to it, so the slow ones stand out without reading every number.
  const maxDuration = useMemo(
    () => Math.max(1, ...rows.map(r => r.span.duration ?? 0)),
    [rows],
  )

  return (
    <section>
      <SectionHeader title="Live spans">
        <div className="flex items-center gap-4 text-[12px] whitespace-nowrap text-ink-faint">
          <span className="hidden sm:inline-flex"><Sparkline buckets={buckets} /></span>
          <span className="font-mono">
            {rate == null ? '— /s' : `${rate.toFixed(1)} /s`}
          </span>
          <LiveStatus status={status} />
        </div>
      </SectionHeader>

      <Panel className="overflow-hidden">
        {rows.length === 0 ? (
          <Empty title="Listening for spans.">
            Nothing has arrived since this page opened. Spans appear here within a
            couple of seconds of an instrumented service handling a request.
          </Empty>
        ) : (
          // Its own scroll area, so fifty rows don't push the rest of the
          // overview off the page. The header stays pinned while it scrolls.
          <div className="max-h-140 overflow-auto">
            <table className={`${table.root} min-w-190`}>
              <thead className="sticky top-0 z-10 bg-panel">
                <tr className={table.headRow}>
                  <th className={`${table.th} w-30`}>Time</th>
                  <th className={`${table.th} w-45`}>Service</th>
                  <th className={table.th}>Operation</th>
                  <th className={`${table.th} w-40 text-right`}>Duration</th>
                  <th className={`${table.th} w-22.5`}>Status</th>
                  <th className={`${table.th} w-25`}>Trace</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ span: s, live }) => (
                  <tr key={s.span_id} className={`${table.row} ${live ? 'row-arrive' : ''}`}>
                    <td className={`${table.td} font-mono text-[12px] text-ink-faint`}>
                      {/* Formatted in the viewer's own time zone, which the
                          server cannot know — so its render may differ. */}
                      <time suppressHydrationWarning>{clockTime(s.start_time)}</time>
                    </td>
                    <td className={table.td}>
                      <ServiceTag id={s.service_id} />
                    </td>
                    <td className={`${table.td} max-w-0 truncate font-mono text-[12.5px] text-ink-muted`}>
                      {s.operation}
                    </td>
                    <td className={table.td}>
                      <DurationCell ms={s.duration} max={maxDuration} failed={s.status === 'error'} />
                    </td>
                    <td className={`${table.td} text-[12px]`}>
                      <StatusMark status={s.status} />
                    </td>
                    <td className={table.td}>
                      <Link
                        href={`/trace/${s.trace_id}`}
                        className="font-mono text-[12px] text-ink-faint underline decoration-line-strong underline-offset-4 transition-colors hover:text-ink hover:decoration-ink-faint"
                      >
                        {s.trace_id.slice(0, 8)}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </section>
  )
}

function DurationCell({ ms, max, failed }: { ms: number | null; max: number; failed: boolean }) {
  const pct = ms == null ? 0 : Math.max(2, (ms / max) * 100)
  return (
    <div className="flex items-center justify-end gap-3">
      <span className="font-mono text-[12.5px] text-ink">{formatMs(ms)}</span>
      <span aria-hidden className="relative h-1 w-14 shrink-0 rounded-full bg-line">
        <span
          className={`absolute inset-y-0 left-0 rounded-full ${failed ? 'bg-err/80' : 'bg-ink-faint'}`}
          style={{ width: `${pct}%` }}
        />
      </span>
    </div>
  )
}

function LiveStatus({ status }: { status: StreamStatus }) {
  const view = {
    live: { dot: 'bg-ok pulse-ring', text: 'Live' },
    connecting: { dot: 'bg-warn', text: 'Connecting' },
    reconnecting: { dot: 'bg-warn', text: 'Reconnecting' },
    closed: { dot: 'bg-err', text: 'Disconnected' },
  }[status]
  return (
    <span className="inline-flex items-center gap-2 text-ink-muted" role="status">
      <span aria-hidden className={`size-1.5 rounded-full ${view.dot}`} />
      {view.text}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Throughput: spans per second over the last minute.
//
// Each span is counted in the second it STARTED (its start_time), not the
// second it reached us. Arrival is bursty — the SDK flushes every couple of
// seconds, so arrivals come in clumps of zero-zero-twelve — while start times
// reflect when the requests actually happened.
//
// The catch is that the most recent seconds are always incomplete: their spans
// are still sitting in some SDK's buffer. So the last SETTLE_S seconds are drawn
// faded and left out of the rate, rather than shown as a false drop-off.
//
// How late can a span be? It is buffered only when it ENDS, then waits for the
// SDK's next flush (5s by default, see sdk/src/tracer.ts), then for the worker
// to pick it up off Redis (up to 2s). Eight seconds covers a default-config SDK.
//
// Only spans that started after this page opened count. Before that we weren't
// listening, and counting a partial second would under-report the rate.
// ─────────────────────────────────────────────────────────────────────────────
const WINDOW_S = 60
const SETTLE_S = 8

interface Bucket {
  count: number
  settled: boolean
  observed: boolean
}

function useThroughput() {
  const [openedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  const [counts, setCounts] = useState<Record<number, number>>({})

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const record = useCallback(
    (spans: Span[]) => {
      setCounts(prev => {
        const next = { ...prev }
        const oldest = Math.floor(Date.now() / 1000) - WINDOW_S
        for (const s of spans) {
          if (s.start_time < openedAt) continue
          const sec = Math.floor(s.start_time / 1000)
          next[sec] = (next[sec] ?? 0) + 1
        }
        for (const k of Object.keys(next)) if (Number(k) < oldest) delete next[Number(k)]
        return next
      })
    },
    [openedAt],
  )

  const nowSec = Math.floor(now / 1000)
  const firstFullSec = Math.ceil(openedAt / 1000)
  const buckets: Bucket[] = []
  for (let sec = nowSec - WINDOW_S + 1; sec <= nowSec; sec++) {
    buckets.push({
      count: counts[sec] ?? 0,
      settled: sec <= nowSec - SETTLE_S,
      observed: sec >= firstFullSec,
    })
  }

  const usable = buckets.filter(b => b.settled && b.observed)
  // Five seconds is the least that gives a rate worth showing.
  const rate =
    usable.length >= 5 ? usable.reduce((n, b) => n + b.count, 0) / usable.length : null

  return { record, buckets, rate }
}

function Sparkline({ buckets }: { buckets: Bucket[] }) {
  const peak = Math.max(1, ...buckets.map(b => b.count))
  return (
    <span aria-hidden className="flex h-4 items-end gap-px" title="Spans per second, last 60s">
      {buckets.map((b, i) => (
        <span
          key={i}
          className={`w-0.5 rounded-[1px] ${
            !b.observed ? 'bg-line' : b.settled ? 'bg-ink-faint' : 'bg-ink-faint/35'
          }`}
          style={{ height: `${b.observed ? Math.max(8, (b.count / peak) * 100) : 8}%` }}
        />
      ))}
    </span>
  )
}
