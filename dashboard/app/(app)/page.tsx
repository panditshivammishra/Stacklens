import { serverApi } from '../../lib/api-server'
import { errorRate, formatCount, formatMs, timeAgo } from '../../lib/format'
import { LiveFeed } from '../../components/LiveFeed'
import {
  Empty,
  Metric,
  PageHeader,
  Panel,
  SectionHeader,
  ServiceTag,
  table,
  type Tone,
} from '../../components/ui'

// This is a Server Component — data fetched at request time on the server,
// no client JavaScript for the stats section.
//
// It uses serverApi() rather than the plain `api` client: a fetch made here runs
// in Node with no browser cookie jar attached, so the session cookie has to be
// lifted off the incoming request and forwarded by hand (see lib/api-server.ts).

// An error rate is only "bad" relative to something. These are the lines this
// page draws; they are deliberately simple and written down in one place.
function rateTone(pct: number | null): Tone {
  if (pct == null) return 'default'
  if (pct >= 5) return 'err'
  if (pct >= 1) return 'warn'
  return 'default'
}

export default async function OverviewPage() {
  const api = await serverApi()
  const [stats, services, recent] = await Promise.all([
    api.stats().catch(() => null),
    api.services().catch(() => []),
    // Seeds the live feed so it opens full instead of empty.
    api.spans(undefined, 50).catch(() => []),
  ])

  const overallRate = stats ? errorRate(stats.errors, stats.total) : null
  const [p95Value, p95Unit] = splitMs(stats?.p95_ms)

  return (
    <div className="space-y-8">
      <PageHeader title="Overview">
        <span>
          All services · <span className="font-mono">last 60 min</span>
        </span>
      </PageHeader>

      {/* The hairlines between metrics are the grid's own background showing
          through 1px gaps — so they sit correctly whether the strip is laid
          out 4-across or 2x2, with no per-cell border rules. */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded border border-line bg-line lg:grid-cols-4">
        <Metric label="Spans" value={formatCount(stats?.total ?? 0)} />
        <Metric
          label="Error rate"
          value={overallRate == null ? '—' : overallRate.toFixed(1)}
          unit={overallRate == null ? undefined : '%'}
          tone={rateTone(overallRate)}
          sub={stats ? `${formatCount(stats.errors)} failed spans` : undefined}
        />
        <Metric label="p95 latency" value={p95Value} unit={p95Unit} />
        <Metric
          label="Throughput"
          value={stats ? Number(stats.rps).toFixed(1) : '—'}
          unit="spans/s"
          sub="last 60 seconds"
        />
      </div>

      <section>
        <SectionHeader title="Services" count={services.length} />
        <Panel className="overflow-hidden">
          {services.length === 0 ? (
            <Empty title="No services yet.">
              Create one in Settings to get an API key, then point the SDK at it.
            </Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className={`${table.root} min-w-160`}>
                <thead>
                  <tr className={table.headRow}>
                    <th className={table.th}>Service</th>
                    <th className={`${table.th} text-right`}>Spans</th>
                    <th className={`${table.th} w-56`}>Error rate</th>
                    <th className={`${table.th} text-right`}>p95</th>
                    <th className={`${table.th} text-right`}>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {services.map(svc => {
                    const idle = Number(svc.total_spans) === 0
                    const pct = errorRate(svc.error_count, svc.total_spans)
                    return (
                      <tr key={svc.id} className={table.row}>
                        <td className={table.td}>
                          <span className={idle ? 'opacity-50' : ''}>
                            <ServiceTag id={svc.name} />
                          </span>
                        </td>
                        <td className={`${table.td} text-right font-mono text-[12.5px] ${idle ? 'text-ink-faint' : 'text-ink'}`}>
                          {formatCount(svc.total_spans)}
                        </td>
                        <td className={table.td}>
                          {idle ? (
                            <span className="text-[12px] text-ink-faint">no traffic in window</span>
                          ) : (
                            <ErrorRateBar pct={pct ?? 0} />
                          )}
                        </td>
                        <td className={`${table.td} text-right font-mono text-[12.5px] text-ink-muted`}>
                          {formatMs(svc.p95_ms)}
                        </td>
                        <td className={`${table.td} text-right text-[12px] text-ink-faint`}>
                          {timeAgo(svc.last_seen)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </section>

      <LiveFeed initial={recent} />
    </div>
  )
}

function ErrorRateBar({ pct }: { pct: number }) {
  const tone = rateTone(pct)
  const fill = tone === 'err' ? 'bg-err' : tone === 'warn' ? 'bg-warn' : 'bg-ok/70'
  const text = tone === 'err' ? 'text-err' : tone === 'warn' ? 'text-warn' : 'text-ink-muted'
  // The bar's full width is 20%, not 100%: real error rates live in single
  // digits, and on a 0–100 scale 3% and 12% would look almost the same.
  const width = Math.min(100, (pct / 20) * 100)
  return (
    <div className="flex items-center gap-3">
      <span aria-hidden className="relative h-1 w-28 shrink-0 rounded-full bg-line">
        <span className={`absolute inset-y-0 left-0 rounded-full ${fill}`} style={{ width: `${Math.max(width, 1.5)}%` }} />
      </span>
      <span className={`font-mono text-[12.5px] ${text}`}>{pct.toFixed(1)}%</span>
    </div>
  )
}

/** "235 ms" → ["235", "ms"] so the number and unit can be sized differently. */
function splitMs(ms: number | null | undefined): [string, string | undefined] {
  const text = formatMs(ms)
  const i = text.lastIndexOf(' ')
  return i === -1 ? [text, undefined] : [text.slice(0, i), text.slice(i + 1)]
}
