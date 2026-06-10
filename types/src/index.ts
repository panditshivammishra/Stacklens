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
  serviceId: string
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
