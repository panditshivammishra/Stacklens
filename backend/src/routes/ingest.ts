import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { redis } from '../db/redis'
import type { Span } from '@stacklens/types'

// ─────────────────────────────────────────────────────────────────────────────
// CONCEPT: Input validation at system boundaries
//
// The SDK sends spans to this endpoint. We must validate every field —
// bad data here corrupts the entire trace database.
// Zod gives us runtime type safety (TypeScript types are compile-time only).
// ─────────────────────────────────────────────────────────────────────────────
const SpanSchema = z.object({
  traceId: z.string().min(1),
  spanId: z.string().min(1),
  parentSpanId: z.string().optional(),
  serviceId: z.string().min(1),
  operation: z.string().min(1),
  startTime: z.number(),
  duration: z.number().optional(),
  status: z.enum(['ok', 'error']),
  metadata: z.record(z.unknown()).optional(),
})

const IngestBodySchema = z.object({
  spans: z.array(SpanSchema).min(1).max(500),
})

export async function ingestRoutes(app: FastifyInstance): Promise<void> {
  app.post('/ingest', async (request, reply) => {
    // Validate incoming payload
    const result = IngestBodySchema.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({ error: result.error.flatten() })
    }

    const { spans } = result.data

    // ─────────────────────────────────────────────────────────────────────
    // CONCEPT: Redis Streams — XADD
    //
    // Instead of writing spans directly to Postgres (slow under load),
    // we push them onto a Redis Stream. This returns in ~1ms.
    // A background worker drains the stream and batch-inserts to Postgres.
    //
    // XADD key * field1 value1 field2 value2 ...
    // The '*' tells Redis to auto-generate the message ID (timestamp-based).
    // MAXLEN ~ 10000 caps the stream size — drops oldest if exceeded.
    // ─────────────────────────────────────────────────────────────────────
    const pipeline = redis.pipeline()
    for (const span of spans) {
      pipeline.xadd(
        'spans:stream',
        'MAXLEN', '~', '10000',
        '*',
        'data', JSON.stringify(span)
      )
    }
    await pipeline.exec()

    return reply.status(202).send({ accepted: spans.length })
  })
}
