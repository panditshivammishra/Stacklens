import { serverApi } from '../../../lib/api-server'
import { timeAgo, utcStamp } from '../../../lib/format'
import { Empty, PageHeader, Panel, ServiceTag } from '../../../components/ui'

export const metadata = { title: 'Incidents' }

// What each anomaly type is called on screen, and the colour of its edge mark.
const KIND: Record<string, { label: string; mark: string; text: string }> = {
  error_spike: { label: 'Error spike', mark: 'bg-err', text: 'text-err' },
  latency_spike: { label: 'Latency spike', mark: 'bg-warn', text: 'text-warn' },
}
const FALLBACK = { label: '', mark: 'bg-ink-faint', text: 'text-ink-muted' }

// The investigating model writes markdown, so service names and routes arrive
// wrapped in backticks. Shown raw, the backticks read as noise. This renders
// just that one piece of markdown — `code` — and nothing else. It builds React
// elements rather than HTML, so text from the model can never become markup.
function WithCode({ text }: { text: string }) {
  return text.split(/`([^`]+)`/g).map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} className="rounded-[3px] bg-raised px-1 py-px font-mono text-[0.9em] text-ink">
        {part}
      </code>
    ) : (
      part
    ),
  )
}

export default async function IncidentsPage() {
  const api = await serverApi()
  const incidents = await api.incidents().catch(() => [])

  return (
    <div>
      <PageHeader title="Incidents">
        <span>Opened and investigated automatically by the anomaly detector</span>
      </PageHeader>

      <Panel className="overflow-hidden">
        {incidents.length === 0 ? (
          <Empty title="No incidents.">
            The detector checks every service once a minute. When error rate or
            latency jumps, it investigates and files the result here.
          </Empty>
        ) : (
          <ul className="divide-y divide-line">
            {incidents.map(inc => {
              const kind = KIND[inc.type] ?? { ...FALLBACK, label: inc.type.replace(/_/g, ' ') }
              return (
                <li key={inc.id} className="relative px-5 py-4">
                  <span aria-hidden className={`absolute inset-y-4 left-0 w-0.5 rounded-r ${kind.mark}`} />

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <span className={`text-[12px] font-medium ${kind.text}`}>{kind.label}</span>
                    <ServiceTag id={inc.service_id} />
                    <span className="ml-auto text-[12px] text-ink-faint">
                      {timeAgo(inc.detected_at)}
                      {/* Fixed locale + timezone so server and browser render the
                          SAME string — otherwise hydration mismatch. */}
                      <span className="ml-2 text-ink-faint/70">{utcStamp(inc.detected_at)}</span>
                    </span>
                  </div>

                  {inc.root_cause && (
                    <p className="mt-2 max-w-3xl text-[14px] leading-relaxed text-ink"><WithCode text={inc.root_cause} /></p>
                  )}

                  {inc.post_mortem && (
                    <details className="group mt-3">
                      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-[12px] text-ink-muted transition-colors hover:text-ink [&::-webkit-details-marker]:hidden">
                        <span aria-hidden className="inline-block transition-transform group-open:rotate-90">›</span>
                        Post-mortem
                      </summary>
                      <div className="mt-2 max-w-3xl border-l border-line-strong pl-4 text-[13px] leading-relaxed whitespace-pre-wrap text-ink-muted">
                        <WithCode text={inc.post_mortem} />
                      </div>
                    </details>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Panel>
    </div>
  )
}
