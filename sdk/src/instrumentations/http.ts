import type * as httpNS from 'http'
import { startSpan, endSpan } from '../tracer'

// ─────────────────────────────────────────────────────────────────────────────
// CONCEPT: Monkey patching
//
// We save the original http.request, then replace it with our own version.
// Our version starts a span, calls the original, and ends the span when done.
// Every outgoing HTTP call in the user's app is now traced automatically.
//
// This is exactly how Datadog, New Relic, and OpenTelemetry agents work.
//
// GOTCHA: we must use require(), NOT `import * as http`.
// An ES import creates a read-only namespace object (getters only) —
// assigning to module.request throws "Cannot set property request".
// require() returns the real, mutable exports object that the user's app
// also receives, so patching it patches everyone.
// This is why OpenTelemetry ships `require-in-the-middle` for hooking modules.
// ─────────────────────────────────────────────────────────────────────────────
/* eslint-disable @typescript-eslint/no-var-requires */
const http = require('http') as typeof httpNS
const https = require('https') as typeof import('https')

type Http = typeof httpNS
type Https = typeof import('https')
export function instrumentHttp(): void {
  patchModule(http)
  patchModule(https)
}

function patchModule(module: Http | Https): void {
  // GOTCHA 1: patching `request` alone is not enough. Node's http.get is not a
  // thin wrapper over the EXPORTED request — it closes over the module's own
  // internal binding, so it never sees our replacement. Verified: with only
  // `request` patched, http.get produced no span at all.
  const originalRequest = module.request.bind(module)

  // @ts-expect-error — we're intentionally overriding the function signature
  module.request = wrap(originalRequest)

  // GOTCHA 2: get cannot simply be wrapped the same way. Node's get is
  // `request(...)` followed by an immediate `req.end()`, and once a request is
  // ended its headers are already on the wire — setHeader then throws
  // ERR_HTTP_HEADERS_SENT. So we rebuild get out of our PATCHED request (which
  // starts the span and sets the headers while the request is still open) and
  // only then end it, exactly as Node does.
  module.get = function (...args: Parameters<RequestFn>) {
    const req = (module.request as RequestFn)(...args)
    req.end()
    return req
  }
}

type RequestFn = (
  options: httpNS.RequestOptions | string | URL,
  ...rest: unknown[]
) => httpNS.ClientRequest

function wrap(original: RequestFn): RequestFn {
  return function (options: httpNS.RequestOptions | string | URL, ...rest: unknown[]) {
    const url = resolveUrl(options)
    const method = (typeof options === 'object' && !('href' in options) ? options.method : 'GET') ?? 'GET'
    const operation = `${method.toUpperCase()} ${url}`

    const span = startSpan(operation, { url, method })

    const req = original(options, ...rest)

    // ─────────────────────────────────────────────────────────────────────
    // CONCEPT: Context propagation via HTTP headers
    //
    // We inject our traceId and spanId into the outgoing request headers.
    // When the receiving service has Stacklens installed, its SDK reads
    // these headers and creates a child span — linking the two services
    // into one trace.
    //
    // This is how a request "flows" through multiple services visually.
    //
    // The parent we advertise is THIS span (the outgoing call), not the
    // ambient one we happen to be sitting inside. Sending the ambient id
    // makes the remote service's root span a SIBLING of the client span
    // instead of its child — the trace still joins up, but the waterfall
    // can no longer show which outgoing call caused which remote work.
    //
    // The headers go on EVERY outgoing call, including ones made outside any
    // request (a timer, a startup job, a queue consumer). Those calls still get
    // a span — startSpan() just makes it a root — and the callee must be told
    // about it. This used to be skipped when there was no ambient context,
    // which split each such call into two unrelated traces: the caller's lone
    // client span, and the callee's work as a separate root.
    // ─────────────────────────────────────────────────────────────────────
    req.setHeader('x-trace-id', span.traceId)
    req.setHeader('x-parent-span-id', span.spanId)
    req.setHeader('x-service-id', span.serviceId)

    req.on('response', (res:any) => {
      const isError = res.statusCode !== undefined && res.statusCode >= 400
      endSpan(span, isError ? new Error(`HTTP ${res.statusCode}`) : undefined)
      if (span.metadata) {
        span.metadata.statusCode = res.statusCode
      }
    })

    req.on('error', (err:any) => {
      endSpan(span, err)
    })

    return req
  }
}

function resolveUrl(options: httpNS.RequestOptions | string | URL): string {
  if (typeof options === 'string') return options
  if (options instanceof URL) return options.pathname
  const { hostname, path, port } = options
  return `${hostname ?? ''}${port ? `:${port}` : ''}${path ?? '/'}`
}
