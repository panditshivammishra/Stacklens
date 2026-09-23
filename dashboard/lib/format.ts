import { serviceName } from './api'

// ─────────────────────────────────────────────────────────────────────────────
// Formatting shared by every page, so a duration or a timestamp looks the same
// wherever it appears.
//
// Every function pins its locale ('en-US') instead of using the browser's. A
// client component is rendered twice — once on the server, once in the browser
// — and if the two produce different text React reports a hydration mismatch.
// A fixed locale makes both renders agree.
// ─────────────────────────────────────────────────────────────────────────────

/** 3 → "3 ms", 1250 → "1.25 s", null → "—" */
export function formatMs(ms: number | string | null | undefined): string {
  if (ms == null || ms === '') return '—'
  const n = Number(ms)
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return '0 ms'
  if (n < 1) return '<1 ms'
  if (n < 1000) return `${Math.round(n)} ms`
  return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)} s`
}

/** 12345 → "12,345" */
export function formatCount(n: number | string | null | undefined): string {
  if (n == null || n === '') return '—'
  return Number(n).toLocaleString('en-US')
}

/** Percentage with one decimal. Returns null when there is nothing to divide. */
export function errorRate(errors: number | string, total: number | string): number | null {
  const t = Number(total)
  if (!t) return null
  return (Number(errors) / t) * 100
}

/** "4s ago", "12m ago", "3h ago", "2d ago" */
export function timeAgo(when: string | number, now: number = Date.now()): string {
  const t = typeof when === 'number' ? when : Date.parse(when)
  if (!Number.isFinite(t)) return '—'
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/** Wall-clock time with milliseconds — "14:03:07.221". Spans are often only a
 *  few ms apart, so seconds alone would show a column of identical times. */
export function clockTime(epochMs: number): string {
  const d = new Date(epochMs)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/** "Sep 21, 10:02 UTC" — fixed zone so the server and browser agree. */
export function utcStamp(iso: string): string {
  return (
    new Date(iso).toLocaleString('en-US', {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }) + ' UTC'
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// CONCEPT: a stable colour per service
//
// The point of a distributed trace is watching a request cross from one
// service into the next. Giving each service its own colour makes that handoff
// visible at a glance — the waterfall bars change colour exactly where the
// request left one process and entered another.
//
// The colour must be the SAME everywhere (overview, live feed, waterfall, map)
// and the same tomorrow, so it cannot be random or depend on list order. We
// hash the service NAME (not the org-prefixed id) into an index. Same name in,
// same colour out, on every page and every reload.
//
// The six hues are muted and close in brightness, so no service looks more
// "important" than another, and none is pure red or green — those mean
// failing and healthy here, and a service should never be mistaken for a status.
//
// Six hues means two services WILL sometimes share one ("api" and "orders-api"
// both land on rose). That is why nothing in the UI relies on colour alone:
// every coloured mark sits next to the service's name. Colour speeds reading
// up; the text is what carries the meaning.
// ─────────────────────────────────────────────────────────────────────────────
const SERVICE_PALETTE = [
  '#6fa3d8', // steel blue
  '#b392d4', // lilac
  '#4fb3a9', // teal
  '#d98e6a', // clay
  '#c7b04f', // ochre
  '#d67fa4', // rose
]

export function serviceColor(serviceIdOrName: string): string {
  const name = serviceName(serviceIdOrName ?? '')
  // FNV-1a: a tiny, well-spread string hash. Math.imul keeps it in 32 bits.
  let h = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return SERVICE_PALETTE[(h >>> 0) % SERVICE_PALETTE.length]
}
