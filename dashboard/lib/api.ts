// ─────────────────────────────────────────────────────────────────────────────
// CONCEPT: API client layer
//
// Centralizing all fetch calls in one file means:
// 1. One place to change the base URL (env variable)
// 2. TypeScript knows the return type of every call
// 3. One place where authentication is attached
//
// ─────────────────────────────────────────────────────────────────────────────
// AUTH: why this file has to care WHERE it is running
// ─────────────────────────────────────────────────────────────────────────────
// The backend authenticates with an httpOnly session cookie. How that cookie
// reaches the API depends on who is doing the fetching, and the two cases are
// genuinely different:
//
//   IN THE BROWSER (client components)
//     The browser holds the cookie and will attach it automatically — but for a
//     CROSS-ORIGIN request (dashboard :3000 → API :4001) only if we opt in with
//     `credentials: 'include'`. Without that one line, fetch strips the cookie
//     and every call comes back 401.
//
//   ON THE SERVER (server components, which is most of this dashboard)
//     There is no browser here. Node is making an outgoing HTTP call and knows
//     nothing about the user's cookie jar — `credentials: 'include'` does
//     nothing at all. We have to read the cookie off the INCOMING request
//     (next/headers) and forward it by hand on the OUTGOING one.
//
// Getting this wrong is the classic "works in dev, 401 in the app" bug: the
// server-rendered page silently fails while client-side calls succeed.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:4001'

/** Exported for display — the login page and the SDK snippet show which
 *  backend this dashboard is talking to. */
export const BACKEND_URL = BASE

/** Thrown on 401 so callers can redirect to /login instead of showing a crash. */
export class UnauthorizedError extends Error {
  constructor() {
    super('Not signed in')
    this.name = 'UnauthorizedError'
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  cookieHeader?: string,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    cache: 'no-store',
    // Browser: send the cookie cross-origin. Ignored (harmlessly) on the server.
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      // Server: the cookie we manually lifted off the incoming request.
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...(init.headers ?? {}),
    },
  })

  if (res.status === 401) throw new UnauthorizedError()
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return res.json() as Promise<T>
}

export interface Service {
  id: string
  name: string
  last_seen: string
  total_spans: string
  error_count: string
  // null when the service sent nothing inside the stats window
  p95_ms: number | null
}

export interface Span {
  // `id` and `created_at` are assigned by Postgres, so only spans fetched over
  // REST have them. Spans pushed live over SSE come straight from the worker,
  // before the database has numbered them (see backend sse._to_row_shape).
  id?: number
  trace_id: string
  span_id: string
  parent_span_id: string | null
  service_id: string
  operation: string
  start_time: number
  duration: number | null
  status: 'ok' | 'error'
  metadata: Record<string, unknown>
  created_at?: string
}

export interface Stats {
  total: string
  errors: string
  p95_ms: number | null
  // The backend formats this as a string ("3.33"), not a number.
  rps: number | string
}

export interface ServiceMapData {
  nodes: { id: string; name: string; last_seen: string }[]
  edges: { from_service_id: string; to_service_id: string; call_count: number; avg_duration_ms: number }[]
}

export interface Incident {
  id: string
  service_id: string
  type: string
  detected_at: string
  root_cause: string
  post_mortem: string
}

export interface Me {
  id: string
  email: string
  org_id: string
  role: string
}

export interface ManagedService {
  id: string
  name: string
  first_seen: string
  last_seen: string
  active_keys: string
}

export interface ApiKey {
  id: string
  service_id: string
  key_prefix: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

/**
 * The spans table stores `metadata` as JSONB, and asyncpg hands JSONB back as
 * TEXT unless a decoder is registered — so the REST routes send the string
 * '{"url":"/charge",...}' rather than an object. Nothing read this field until
 * the trace page started listing span attributes, at which point
 * Object.entries() walked the string one character at a time.
 *
 * Parsed here, once, so every page gets the object the `Span` type promises.
 * (The cleaner fix is a JSONB codec on the backend's connection pool; that
 * changes the write path too, so it is left as a separate change.)
 */
function normalizeSpans(spans: Span[]): Span[] {
  for (const s of spans) {
    const raw = s.metadata as unknown
    if (typeof raw === 'string') {
      try {
        s.metadata = JSON.parse(raw) as Record<string, unknown>
      } catch {
        s.metadata = {}
      }
    }
    s.metadata ??= {}
  }
  return spans
}

/**
 * Build a client bound to a specific cookie header.
 * Server components use makeApi(cookieHeader); the browser uses `api` below.
 */
export function makeApi(cookieHeader?: string) {
  const get = <T>(path: string) => request<T>(path, {}, cookieHeader)
  const post = <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }, cookieHeader)
  const del = <T>(path: string) => request<T>(path, { method: 'DELETE' }, cookieHeader)

  return {
    // reads
    services: () => get<Service[]>('/api/services'),
    spans: (serviceId?: string, limit = 50) =>
      get<Span[]>(`/api/spans?limit=${limit}${serviceId ? `&serviceId=${encodeURIComponent(serviceId)}` : ''}`)
        .then(normalizeSpans),
    trace: (traceId: string) => get<Span[]>(`/api/trace/${traceId}`).then(normalizeSpans),
    serviceMap: () => get<ServiceMapData>('/api/service-map'),
    stats: (serviceId?: string) =>
      get<Stats>(`/api/stats${serviceId ? `?serviceId=${encodeURIComponent(serviceId)}` : ''}`),
    incidents: () => get<Incident[]>('/api/incidents'),

    // auth
    me: () => get<Me>('/auth/me'),
    login: (email: string, password: string) =>
      post<Me>('/auth/login', { email, password }),
    signup: (email: string, password: string, orgName: string) =>
      post<Me>('/auth/signup', { email, password, org_name: orgName }),
    logout: () => post<{ ok: boolean }>('/auth/logout'),

    // service + key management
    managedServices: () => get<ManagedService[]>('/api/services/manage'),
    createService: (name: string) =>
      post<{ service_id: string; name: string; api_key: string }>('/api/services', { name }),
    keys: () => get<ApiKey[]>('/api/keys'),
    createKey: (name: string) =>
      post<{ service_id: string; api_key: string }>('/api/keys', { name }),
    revokeKey: (id: string) => del<{ revoked: boolean }>(`/api/keys/${id}`),
  }
}

/** Browser-side client. Relies on the browser attaching the cookie itself. */
export const api = makeApi()

/**
 * Service ids are stored org-namespaced ("<org-uuid>:payment-service") so two
 * organisations can each own a service called "api" without colliding. Users
 * should never see that prefix — it is an internal key, not a name.
 */
export function serviceName(serviceId: string): string {
  const i = serviceId.indexOf(':')
  return i === -1 ? serviceId : serviceId.slice(i + 1)
}
