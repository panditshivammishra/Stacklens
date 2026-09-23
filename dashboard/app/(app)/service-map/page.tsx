import { serverApi } from '../../../lib/api-server'
import { formatCount, formatMs } from '../../../lib/format'
import { ServiceMap } from '../../../components/ServiceMap'
import { PageHeader, Panel, SectionHeader, ServiceTag, table } from '../../../components/ui'

export const metadata = { title: 'Service map' }

export default async function ServiceMapPage() {
  const api = await serverApi()
  const data = await api.serviceMap().catch(() => ({ nodes: [], edges: [] }))

  return (
    <div className="space-y-8">
      <PageHeader title="Service map">
        {/* The edges are rebuilt by a background job every 60s over the last
            24h of spans (see rebuild_service_edges in the span worker). */}
        <span>
          Arrows point from caller to callee · line weight is call volume ·{' '}
          <span className="font-mono">last 24 h</span>
        </span>
      </PageHeader>

      <ServiceMap nodes={data.nodes} edges={data.edges} />

      {data.edges.length > 0 && (
        <section>
          <SectionHeader title="Dependencies" count={data.edges.length} />
          <Panel className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className={`${table.root} min-w-120`}>
                <thead>
                  <tr className={table.headRow}>
                    <th className={table.th}>Caller</th>
                    <th className={table.th}>Callee</th>
                    <th className={`${table.th} text-right`}>Calls</th>
                    <th className={`${table.th} text-right`}>Avg latency</th>
                  </tr>
                </thead>
                <tbody>
                  {data.edges.map(e => (
                    <tr key={`${e.from_service_id}-${e.to_service_id}`} className={table.row}>
                      <td className={table.td}><ServiceTag id={e.from_service_id} /></td>
                      <td className={table.td}>
                        <span className="inline-flex items-center gap-3">
                          <span aria-hidden className="text-ink-faint">→</span>
                          <ServiceTag id={e.to_service_id} />
                        </span>
                      </td>
                      <td className={`${table.td} text-right font-mono text-[12.5px] text-ink`}>
                        {formatCount(e.call_count)}
                      </td>
                      <td className={`${table.td} text-right font-mono text-[12.5px] text-ink-muted`}>
                        {formatMs(e.avg_duration_ms)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </section>
      )}
    </div>
  )
}
