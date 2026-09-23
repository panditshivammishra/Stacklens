export interface Span {
  traceId: string
  spanId: string
  parentSpanId?: string
  serviceId: string
  operation: string
  startTime: number
  duration?: number
  status: 'ok' | 'error'
  metadata?: Record<string, unknown>
}

export interface SpanContext {
  traceId: string
  spanId: string
  serviceId: string
}

export interface StacklensConfig {
  /**
   * A human-readable name for this service, used in logs and local spans.
   *
   * NOTE: this is no longer what the backend stores. Since API-key auth landed,
   * the server derives the real service id from the key (so a leaked key can
   * only ever write its own service's spans, and two orgs can both have a
   * service called "api"). Keep it in sync with the name you registered — it is
   * what you'll see in your own logs.
   */
  serviceId: string
  /** Secret from POST /api/services, e.g. "sl_live_9f2c…". Sent as x-api-key. */
  apiKey?: string
  backendUrl?: string
  flushInterval?: number
  maxBufferSize?: number
}

export interface Incident {
  id: string
  serviceId: string
  type: 'latency_spike' | 'error_spike' | 'traffic_anomaly'
  detectedAt: Date
  rootCause: string
  postMortem: string
  relatedTraceIds: string[]
}

export interface ServiceEdge {
  fromService: string
  toService: string
  callCount: number
  avgDuration: number
}
