'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Settings — create services, issue and revoke API keys.
//
// This page is the "registration" that Stacklens used to lack entirely. Before,
// a service existed the moment anything sent a span claiming its name. Now a
// human creates it here, gets a key scoped to that one service, and the backend
// derives the service id from that key on every ingest.
//
// THE ONE-TIME REVEAL
//   The raw key is shown once, right after creation, and then it is genuinely
//   gone — we store only a sha256 hash, so not even the server can print it
//   again. Lose it and you issue a new one and revoke the old. GitHub, Stripe
//   and AWS all behave this way for the same reason: a key you can re-read is a
//   key that leaks from your own database.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react'
import { api, BACKEND_URL, type ApiKey, type ManagedService } from '../../../lib/api'
import { timeAgo } from '../../../lib/format'
import { CopyButton } from '../../../components/CopyButton'
import { button, Empty, input, PageHeader, Panel, ServiceTag, table } from '../../../components/ui'

// What the key-reveal box tells the user to paste. It must match what the SDK
// actually exports: a NAMED `stacklens` function. This used to show
// `require('@stacklens/sdk')({ ... })`, which calls the module object itself
// and throws "is not a function" on the first line of the user's app.
function setupSnippet(service: string, key: string): string {
  return `const { stacklens } = require('@stacklens/sdk')

stacklens({
  serviceId: '${service}',
  apiKey: '${key}',
  backendUrl: '${BACKEND_URL}',
})`
}

const fetchSettings = () => Promise.all([api.managedServices(), api.keys()])

export default function SettingsPage() {
  const [services, setServices] = useState<ManagedService[]>([])
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [newName, setNewName] = useState('')
  const [revealed, setRevealed] = useState<{ service: string; key: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [s, k] = await fetchSettings()
      setServices(s)
      setKeys(k)
    } catch {
      setError('Could not load settings.')
    }
  }, [])

  // The first load. State is only set in the promise callbacks — never
  // synchronously in the effect body, which would force a second render
  // straight after the first. `ignore` drops a response that arrives after the
  // user has already left the page (or, in development, after React's
  // deliberate mount-unmount-mount check).
  useEffect(() => {
    let ignore = false
    fetchSettings()
      .then(([s, k]) => {
        if (ignore) return
        setServices(s)
        setKeys(k)
      })
      .catch(() => {
        if (!ignore) setError('Could not load settings.')
      })
    return () => { ignore = true }
  }, [])

  // Every action below (create/rotate/revoke) is the same shape: clear the old
  // error, show busy, run one API call, reload the lists, and turn a thrown
  // error into a specific message. One helper keeps all three consistent —
  // previously only create showed a busy state, so the other two buttons gave
  // no feedback while their request was in flight.
  async function run(action: () => Promise<void>, errorMessage: string) {
    setError(null)
    setBusy(true)
    try {
      await action()
      await load()
    } catch {
      setError(errorMessage)
    } finally {
      setBusy(false)
    }
  }

  async function createService(e: React.FormEvent) {
    e.preventDefault()
    await run(async () => {
      const res = await api.createService(newName)
      setRevealed({ service: res.name, key: res.api_key })
      setNewName('')
    }, 'Could not create that service. Names must be lowercase, 2–50 chars, and unique in your org.')
  }

  async function rotate(name: string) {
    await run(async () => {
      const res = await api.createKey(name)
      setRevealed({ service: name, key: res.api_key })
    }, 'Could not issue a new key.')
  }

  async function revoke(id: string) {
    await run(() => api.revokeKey(id).then(() => undefined), 'Could not revoke that key.')
  }

  return (
    <div>
      <PageHeader title="Settings" />

      {error && (
        <p role="alert" className="mb-6 rounded border border-err/30 bg-err/10 px-4 py-2.5 text-[13px] text-err">
          {error}
        </p>
      )}

      {/* One-time key reveal */}
      {revealed && (
        <div className="mb-8 rounded border border-signal/40 bg-signal/5 p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-[14px] font-medium text-ink">
              New key for <span className="font-mono">{revealed.service}</span>
            </p>
            <p className="text-[12px] text-signal">Shown once. Only a hash is stored.</p>
          </div>

          <div className="mt-3 flex items-center gap-2 rounded-[3px] border border-line-strong bg-canvas py-1.5 pr-1.5 pl-3">
            <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[13px] whitespace-nowrap text-ink">
              {revealed.key}
            </code>
            <CopyButton value={revealed.key} label="Copy API key" />
          </div>

          <div className="mt-4 overflow-hidden rounded-[3px] border border-line bg-canvas">
            <div className="flex items-center justify-between border-b border-line px-3 py-1">
              <span className="text-[12px] text-ink-faint">Add to your service&rsquo;s entry file</span>
              <CopyButton value={setupSnippet(revealed.service, revealed.key)} label="Copy setup code" />
            </div>
            <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-ink-muted">
              {setupSnippet(revealed.service, revealed.key)}
            </pre>
          </div>

          <button onClick={() => setRevealed(null)} className={`${button.secondary} mt-4`}>
            Done, I&rsquo;ve saved it
          </button>
        </div>
      )}

      <div className="divide-y divide-line">
        <Setting
          title="Services"
          description="Each service you want to trace gets its own entry and its own API key. The key decides which service a span belongs to — whatever name the SDK sends is ignored."
        >
          <form onSubmit={createService} className="mb-4 flex gap-2">
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              required
              placeholder="payment-service"
              aria-label="New service name"
              className={`${input} flex-1 font-mono`}
            />
            <button type="submit" disabled={busy} className={button.primary}>
              Add service
            </button>
          </form>

          <Panel className="overflow-hidden">
            {services.length === 0 ? (
              <Empty title="No services yet.">Add one above to get its API key.</Empty>
            ) : (
              <ul className="divide-y divide-line">
                {services.map(s => {
                  const n = Number(s.active_keys)
                  return (
                    <li key={s.id} className="flex items-center gap-4 px-4 py-3">
                      <ServiceTag id={s.name} className="flex-1" />
                      <span className={`text-[12px] ${n === 0 ? 'text-warn' : 'text-ink-faint'}`}>
                        {n === 0 ? 'no active key' : `${n} active key${n === 1 ? '' : 's'}`}
                      </span>
                      <span className="hidden w-24 text-right text-[12px] text-ink-faint sm:inline">
                        {timeAgo(s.last_seen)}
                      </span>
                      <button onClick={() => rotate(s.name)} disabled={busy} className={button.secondary}>
                        Issue key
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </Panel>
        </Setting>

        <Setting
          title="API keys"
          description="Only the first few characters of a key are kept in readable form, so you can tell keys apart. Revoking takes effect on the very next request. To rotate, issue a new key, deploy it, then revoke the old one."
        >
          <Panel className="overflow-hidden">
            {keys.length === 0 ? (
              <Empty title="No keys yet." />
            ) : (
              <div className="overflow-x-auto">
                <table className={`${table.root} min-w-150`}>
                  <thead>
                    <tr className={table.headRow}>
                      <th className={table.th}>Key</th>
                      <th className={table.th}>Service</th>
                      <th className={table.th}>Last used</th>
                      <th className={table.th}>Status</th>
                      <th className={table.th}><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {keys.map(k => (
                      <tr key={k.id} className={table.row}>
                        <td
                          className={`${table.td} font-mono text-[12.5px] ${
                            k.revoked_at ? 'text-ink-faint line-through decoration-ink-faint/50' : 'text-ink'
                          }`}
                        >
                          {k.key_prefix}…
                        </td>
                        <td className={`${table.td} ${k.revoked_at ? 'opacity-50' : ''}`}>
                          <ServiceTag id={k.service_id} />
                        </td>
                        <td className={`${table.td} text-[12px] text-ink-faint`}>
                          {k.last_used_at ? timeAgo(k.last_used_at) : 'never'}
                        </td>
                        <td className={`${table.td} text-[12px]`}>
                          {k.revoked_at ? (
                            <span className="text-ink-faint">revoked {timeAgo(k.revoked_at)}</span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 text-ink-muted">
                              <span aria-hidden className="size-1.5 rounded-full bg-ok" />
                              active
                            </span>
                          )}
                        </td>
                        <td className={`${table.td} text-right`}>
                          {!k.revoked_at && (
                            <button onClick={() => revoke(k.id)} disabled={busy} className={button.danger}>
                              Revoke
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </Setting>
      </div>
    </div>
  )
}

// The two-column settings row: what this is and why on the left, the controls
// on the right. The explanation stays beside the thing it explains instead of
// in a tooltip nobody opens.
function Setting({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section className="grid gap-x-10 gap-y-4 py-8 first:pt-0 lg:grid-cols-[280px_1fr]">
      <div>
        <h2 className="text-[14px] font-medium text-ink">{title}</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-faint">{description}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  )
}
