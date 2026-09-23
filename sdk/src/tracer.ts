import { AsyncLocalStorage } from 'async_hooks'
import { v4 as uuidv4 } from 'uuid'
import type { Span, SpanContext, StacklensConfig } from '@stacklens/types'

// ─────────────────────────────────────────────────────────────────────────────
// AsyncLocalStorage is the heart of the tracer.
//
// CONCEPT: When Node.js runs async code (Promises, callbacks, setTimeout),
// variables go out of scope. AsyncLocalStorage solves this by creating a
// "storage slot" that automatically follows the async execution chain.
//
// Think of it like a backpack: once you put something in it at the start
// of a request, every async function called within that request can reach
// into the same backpack — without you passing it as a parameter.
// ─────────────────────────────────────────────────────────────────────────────
const storage = new AsyncLocalStorage<SpanContext>()

let config: StacklensConfig
const buffer: Span[] = []
let flushTimer: NodeJS.Timeout | null = null
// Auth failures repeat every flush; warn once instead of every 5 seconds forever.
let warnedAboutAuth = false

export function init(cfg: StacklensConfig): void {
  config = {
    backendUrl: 'http://localhost:4001',   // the Python backend (the Node one on :4000 was retired)
    flushInterval: 5000,
    maxBufferSize: 100,
    ...cfg,
  }
  startFlushTimer()
}

// ─────────────────────────────────────────────────────────────────────────────
// startSpan: creates a new span and sets it as the current context.
//
// If a parent context exists in storage (another span is already active),
// the new span becomes a child of it — sharing the same traceId.
// If no parent exists, this is the root span — we generate a new traceId.
// ─────────────────────────────────────────────────────────────────────────────
export function startSpan(operation: string, metadata?: Record<string, unknown>): Span {
  const parent = storage.getStore()

  const span: Span = {
    traceId: parent?.traceId ?? uuidv4(),
    spanId: uuidv4(),
    parentSpanId: parent?.spanId,
    serviceId: config?.serviceId ?? 'unknown',
    operation,
    startTime: Date.now(),
    status: 'ok',
    metadata,
  }

  return span
}

export function endSpan(span: Span, error?: Error): void {
  span.duration = Date.now() - span.startTime
  if (error) {
    span.status = 'error'
    span.metadata = { ...span.metadata, error: error.message }
  }
  bufferSpan(span)
}

// ─────────────────────────────────────────────────────────────────────────────
// runWithSpan: wraps an async function with a span context.
//
// storage.run() is what makes AsyncLocalStorage work — it sets the context
// for everything that runs inside the callback, including nested async calls.
// ─────────────────────────────────────────────────────────────────────────────
export async function runWithSpan<T>(
  operation: string,
  fn: () => Promise<T>,
  metadata?: Record<string, unknown>
): Promise<T> {
  const span = startSpan(operation, metadata)
  const context: SpanContext = {
    traceId: span.traceId,
    spanId: span.spanId,
    serviceId: span.serviceId,
  }

  return storage.run(context, async () => {
    try {
      const result = await fn()
      endSpan(span)
      return result
    } catch (err) {
      endSpan(span, err as Error)
      throw err
    }
  })
}

export function getCurrentContext(): SpanContext | undefined {
  return storage.getStore()
}

// Run fn with an explicit context in the backpack. Used by the middleware to
// seed an incoming request with the CALLER's trace context (read from the
// x-trace-id headers) so the whole cross-service journey shares one traceId.
export function runInContext<T>(context: SpanContext, fn: () => T): T {
  return storage.run(context, fn)
}

function bufferSpan(span: Span): void {
  if (buffer.length >= (config?.maxBufferSize ?? 100)) {
    buffer.shift() // drop oldest when buffer is full (backpressure handling)
  }
  buffer.push(span)
}

function startFlushTimer(): void {
  flushTimer = setInterval(() => {
    flush().catch(() => {}) // fire-and-forget — never throw to user's app
  }, config.flushInterval)

  // unref() so the timer doesn't keep the process alive if app wants to exit
  flushTimer.unref()
}

async function flush(): Promise<void> {
  if (buffer.length === 0) return

  const spans = buffer.splice(0, buffer.length)

  try {
    const response = await fetch(`${config.backendUrl}/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The key proves which service these spans belong to. The backend reads
        // the service id OFF THIS KEY and ignores whatever serviceId the payload
        // claims — which is what makes spoofing another service impossible.
        ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
      },
      body: JSON.stringify({ spans }),
    })

    if (!response.ok) {
      // 401 = bad/missing/revoked key. Retrying cannot fix that, and re-queuing
      // would grow the buffer forever while every flush failed. Warn once so the
      // developer sees the real reason, then drop the batch.
      if (response.status === 401) {
        if (!warnedAboutAuth) {
          warnedAboutAuth = true
          console.warn(
            '[stacklens] ingest rejected (401). Set `apiKey` in your stacklens() ' +
            'config — create one with POST /api/services. Spans are being dropped.'
          )
        }
        return
      }
      buffer.unshift(...spans) // transient failure — put them back and retry later
    }
  } catch {
    // backend is down — silently drop to avoid noise
  }
}
