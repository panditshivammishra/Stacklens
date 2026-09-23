import { startSpan, endSpan, runInContext } from './tracer'
import type { SpanContext } from '@stacklens/types'

// ─────────────────────────────────────────────────────────────────────────────
// CONCEPT: One middleware instead of wrapping every route
//
// Without this, users must wrap each handler in runWithSpan by hand — and the
// route someone forgets becomes invisible. Express middlewares run BEFORE every
// route handler, so one app.use() traces the entire service:
//
//     app.use(stacklensMiddleware())
//
// It also completes the cross-service handshake: http.ts INJECTS
// x-trace-id / x-parent-span-id on outgoing calls — this middleware READS them
// on incoming requests, so the callee's spans join the caller's trace instead
// of starting a new one.
//
// The signature is connect-style (req, res, next) — works with Express, but
// also with a raw http server by calling it manually. No express dependency:
// we only type the few fields we touch.
// ─────────────────────────────────────────────────────────────────────────────

interface IncomingLike {
  method?: string
  url?: string
  path?: string
  headers: Record<string, string | string[] | undefined>
}

interface ResponseLike {
  statusCode: number
  on(event: 'finish', cb: () => void): void
}

function header(req: IncomingLike, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

export function stacklensMiddleware() {
  return function stacklensTrace(
    req: IncomingLike,
    res: ResponseLike,
    next: () => void
  ): void {
    // Route name without the query string: "GET /getData"
    const path = req.path ?? (req.url ?? '/').split('?')[0]
    const operation = `${(req.method ?? 'GET').toUpperCase()} ${path}`

    const traceId = header(req, 'x-trace-id')
    const parentSpanId = header(req, 'x-parent-span-id')

    const openSpan = (): void => {
      // startSpan reads the backpack: seeded (below) → continues the caller's
      // trace; empty → brand-new traceId (this service is where the journey starts).
      const span = startSpan(operation, { url: req.url, method: req.method })

      // 'finish' fires when the response has been sent — that's the span's end.
      res.on('finish', () => {
        span.metadata = { ...span.metadata, statusCode: res.statusCode }
        const failed = res.statusCode >= 400
        endSpan(span, failed ? new Error(`HTTP ${res.statusCode}`) : undefined)
      })

      // Put THIS span in the backpack and only then run the route handler —
      // so every child span (db, cache, outgoing calls) finds its parent.
      const context: SpanContext = {
        traceId: span.traceId,
        spanId: span.spanId,
        serviceId: span.serviceId,
      }
      runInContext(context, next)
    }

    if (traceId && parentSpanId) {
      // A traced service called us: seed the backpack with ITS context so our
      // root span inherits the traceId and points at the caller's span.
      const callerContext: SpanContext = {
        traceId,
        spanId: parentSpanId,
        serviceId: header(req, 'x-service-id') ?? 'unknown',
      }
      runInContext(callerContext, openSpan)
    } else {
      openSpan()
    }
  }
}
