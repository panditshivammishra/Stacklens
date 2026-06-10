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

export function init(cfg: StacklensConfig): void {
  config = {
    backendUrl: 'http://localhost:4000',
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spans }),
    })
    if (!response.ok) {
      buffer.unshift(...spans) // put them back on failure
    }
  } catch {
    // backend is down — silently drop to avoid noise
  }
}
