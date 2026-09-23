import Link from 'next/link'
import { notFound } from 'next/navigation'
import { serverApi } from '../../../../lib/api-server'
import { formatMs, utcStamp } from '../../../../lib/format'
import { TraceWaterfall } from '../../../../components/TraceWaterfall'
import { CopyButton } from '../../../../components/CopyButton'

// ─────────────────────────────────────────────────────────────────────────────
// One trace, drawn as a waterfall.
//
// This page closes a gap that existed since the start: the live feed has always
// linked to /trace/<id>, and the TraceWaterfall component was written — but the
// page itself was never created, so every one of those links 404'd and the
// component was dead code.
//
// The whole point of distributed tracing shows up here. Each row is one span;
// spans share a traceId and point at their parent through parentSpanId, so the
// nesting you see IS the call tree, reconstructed from rows that arrived
// separately, from different services, in any order.
//
// CONCEPT: params is a Promise in Next.js 16
//   Dynamic route params are async now, so it has to be awaited before use.
// ─────────────────────────────────────────────────────────────────────────────
export default async function TracePage({
  params,
}: {
  params: Promise<{ traceId: string }>
}) {
  const { traceId } = await params
  const api = await serverApi()

  // The backend answers 404 both for "no such trace" and "that trace belongs to
  // another org" — deliberately indistinguishable, so trace ids cannot be probed.
  const spans = await api.trace(traceId).catch(() => null)
  if (!spans || spans.length === 0) notFound()

  const root = spans.find(s => !s.parent_span_id) ?? spans[0]
  const start = Math.min(...spans.map(s => s.start_time))
  const end = Math.max(...spans.map(s => s.start_time + (s.duration ?? 0)))
  const errors = spans.filter(s => s.status === 'error').length
  const servicesInTrace = new Set(spans.map(s => s.service_id)).size

  return (
    <div className="space-y-6">
      <div>
        <nav className="mb-3 flex items-center gap-2 text-[12px] text-ink-faint">
          <Link href="/" className="transition-colors hover:text-ink">Overview</Link>
          <span aria-hidden>/</span>
          <span>Trace</span>
        </nav>

        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="font-mono text-[18px] font-medium tracking-tight text-ink">
            {root.operation}
          </h1>
          <div className="flex items-center gap-2 font-mono text-[12px] text-ink-faint">
            <span>{traceId}</span>
            <CopyButton value={traceId} label="Copy trace id" />
          </div>
        </div>

        {/* The summary reads as one line of facts rather than four cards: it
            is context for the waterfall below, not the main event. */}
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[13px]">
          <Fact label="Duration" value={formatMs(end - start)} />
          <Fact label="Spans" value={spans.length} />
          <Fact label="Services" value={servicesInTrace} />
          <Fact label="Errors" value={errors} tone={errors ? 'text-err' : undefined} />
          <Fact label="Started" value={utcStamp(new Date(start).toISOString())} />
        </dl>
      </div>

      <TraceWaterfall spans={spans} />
      <p className="text-[12px] text-ink-faint">Select a row to see that span&rsquo;s attributes.</p>
    </div>
  )
}

function Fact({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-ink-faint">{label}</dt>
      <dd className={`font-mono ${tone ?? 'text-ink'}`}>{value}</dd>
    </div>
  )
}
