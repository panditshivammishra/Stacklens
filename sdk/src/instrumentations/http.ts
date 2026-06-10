import * as http from 'http'
import * as https from 'https'
import { startSpan, endSpan, getCurrentContext } from '../tracer'

// ─────────────────────────────────────────────────────────────────────────────
// CONCEPT: Monkey patching
//
// We save the original http.request, then replace it with our own version.
// Our version starts a span, calls the original, and ends the span when done.
// Every outgoing HTTP call in the user's app is now traced automatically.
//
// This is exactly how Datadog, New Relic, and OpenTelemetry agents work.
// ─────────────────────────────────────────────────────────────────────────────
export function instrumentHttp(): void {
  patchModule(http)
  patchModule(https)
}

function patchModule(module: typeof http | typeof https): void {
  const originalRequest = module.request.bind(module)

  // @ts-expect-error — we're intentionally overriding the function signature
  module.request = function (options: http.RequestOptions | string | URL, callback?: (res: http.IncomingMessage) => void) {
    const url = resolveUrl(options)
    const method = (typeof options === 'object' && !('href' in options) ? options.method : 'GET') ?? 'GET'
    const operation = `${method.toUpperCase()} ${url}`

    const span = startSpan(operation, { url, method })

    const req = originalRequest(options, callback)

    // ─────────────────────────────────────────────────────────────────────
    // CONCEPT: Context propagation via HTTP headers
    //
    // We inject our traceId and spanId into the outgoing request headers.
    // When the receiving service has Stacklens installed, its SDK reads
    // these headers and creates a child span — linking the two services
    // into one trace.
    //
    // This is how a request "flows" through multiple services visually.
    // ─────────────────────────────────────────────────────────────────────
    const context = getCurrentContext()
    if (context) {
      req.setHeader('x-trace-id', context.traceId)
      req.setHeader('x-parent-span-id', context.spanId)
      req.setHeader('x-service-id', context.serviceId)
    }

    req.on('response', (res) => {
      const isError = res.statusCode !== undefined && res.statusCode >= 400
      endSpan(span, isError ? new Error(`HTTP ${res.statusCode}`) : undefined)
      if (span.metadata) {
        span.metadata.statusCode = res.statusCode
      }
    })

    req.on('error', (err) => {
      endSpan(span, err)
    })

    return req
  }
}

function resolveUrl(options: http.RequestOptions | string | URL): string {
  if (typeof options === 'string') return options
  if (options instanceof URL) return options.pathname
  const { hostname, path, port } = options
  return `${hostname ?? ''}${port ? `:${port}` : ''}${path ?? '/'}`
}
