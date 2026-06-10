# Stacklens — Project Context

## What is Stacklens?

Stacklens is a zero-config observability SDK + dashboard for Node.js applications.
It automatically tracks every HTTP request, database query, and Redis operation across
your services — and uses an AI agent to investigate anomalies and generate incident reports.

Think of it as a free, self-hosted alternative to Datadog APM.

---

## The Problem It Solves

- Datadog / New Relic cost $300–$1000/month — unaffordable for small startups
- OpenTelemetry exists but needs 200+ lines of manual config
- Engineers fly blind in production: when something breaks, they grep logs manually
- Same incidents repeat because post-mortems are manual and not connected to code

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     YOUR NODE.JS APP                            │
│                                                                 │
│   require('stacklens')({ serviceId: 'payment-service' })       │
│          │                                                      │
│          ▼                                                      │
│   ┌─────────────┐    auto-patches    ┌──────────────────────┐  │
│   │  SDK Core   │ ─────────────────► │  http / mongo / redis│  │
│   │ (tracer.ts) │                    │   instrumentation    │  │
│   └──────┬──────┘                    └──────────────────────┘  │
│          │ emits spans                                          │
└──────────┼──────────────────────────────────────────────────────┘
           │
           ▼ HTTP POST /ingest
┌──────────────────────┐
│   BACKEND (Fastify)  │
│                      │
│  /ingest ──► Redis   │  ◄── Streams buffer (handles bursts)
│              Stream  │
│     │                │
│     ▼                │
│  Worker pulls from   │
│  Redis Stream        │
│     │                │
│     ▼                │
│  PostgreSQL          │  ◄── Stores spans, traces, services
│  (time-series)       │
│                      │
│  Qdrant              │  ◄── Stores incident embeddings for AI memory
│  (vector DB)         │
└──────────┬───────────┘
           │
           │ WebSocket (real-time push)
           ▼
┌──────────────────────┐
│  DASHBOARD (Next.js) │
│                      │
│  - Service Map       │  ◄── Which service calls which
│  - Trace Viewer      │  ◄── Request waterfall timeline
│  - Anomaly Feed      │  ◄── AI-detected issues
│  - Incident Reports  │  ◄── Auto-generated post-mortems
└──────────────────────┘
           │
           │ when anomaly detected
           ▼
┌──────────────────────┐
│    AI AGENT          │
│   (Gemini API)       │
│                      │
│  Tools:              │
│  - get_traces()      │
│  - get_deploys()     │
│  - get_errors()      │
│  - send_alert()      │
│                      │
│  Thinks → Acts →     │
│  Generates report    │
└──────────────────────┘
```

---

## Monorepo Structure

```
stacklens/
├── sdk/                      # npm package users install
│   ├── src/
│   │   ├── index.ts          # entry: require('stacklens')
│   │   ├── tracer.ts         # AsyncLocalStorage context manager
│   │   ├── exporter.ts       # sends spans to backend
│   │   └── instrumentations/
│   │       ├── http.ts       # patches Node.js http module
│   │       ├── mongo.ts      # patches mongoose
│   │       └── redis.ts      # patches ioredis
│   └── package.json
│
├── backend/                  # Fastify API server
│   ├── src/
│   │   ├── index.ts          # server entry
│   │   ├── routes/
│   │   │   ├── ingest.ts     # POST /ingest - receives spans
│   │   │   ├── traces.ts     # GET /traces - query traces
│   │   │   └── services.ts   # GET /services - service map data
│   │   ├── workers/
│   │   │   └── spanWorker.ts # reads from Redis Stream, writes to Postgres
│   │   ├── agent/
│   │   │   ├── index.ts      # AI agent orchestrator
│   │   │   └── tools.ts      # agent tools (get_traces, send_alert, etc.)
│   │   └── db/
│   │       ├── postgres.ts   # pg connection + queries
│   │       └── schema.sql    # table definitions
│   └── package.json
│
├── dashboard/                # Next.js 14 frontend
│   ├── app/
│   │   ├── page.tsx          # service map home
│   │   ├── traces/page.tsx   # trace list
│   │   └── incidents/page.tsx # AI incident reports
│   └── package.json
│
├── docker-compose.yml        # PostgreSQL + Redis + Qdrant
├── package.json              # root - npm workspaces
└── .env.example
```

---

## Tech Stack & Why Each Was Chosen

| Tool | Why |
|---|---|
| **AsyncLocalStorage** | Carries trace context across async calls without passing it manually |
| **Fastify** | 2x faster than Express, built-in schema validation, better for high-throughput ingestion |
| **PostgreSQL** | Reliable, supports time-range queries well, TimescaleDB extension for time-series |
| **Redis Streams** | Buffer between SDK and DB — handles traffic bursts without losing spans |
| **Qdrant** | Vector DB for storing past incident embeddings — enables AI to recall similar past incidents |
| **Gemini 2.0 Flash** | Free LLM with tool calling support — powers the AI agent |
| **Next.js 14 App Router** | Server components for fast initial load, easy WebSocket integration |

---

## Key Data Models

### Span
```typescript
{
  traceId: string,        // groups all spans for one request
  spanId: string,         // unique ID for this operation
  parentSpanId: string,   // links to parent span (builds the tree)
  serviceId: string,      // which service emitted this
  operation: string,      // e.g. "GET /users", "MongoDB.find"
  startTime: number,      // unix ms
  duration: number,       // ms
  status: 'ok' | 'error',
  metadata: object        // extra info (query, url, statusCode, etc.)
}
```

### Trace
A trace = collection of spans sharing the same `traceId`.
It represents the full journey of one request across services.

### Incident
```typescript
{
  id: string,
  detectedAt: Date,
  service: string,
  type: 'latency_spike' | 'error_spike' | 'traffic_anomaly',
  rootCause: string,      // AI-generated explanation
  postMortem: string,     // AI-generated report
  relatedTraceIds: string[]
}
```

---

## API Contracts

### POST /ingest
Receives spans from SDK.
```json
{
  "spans": [
    {
      "traceId": "abc123",
      "spanId": "span001",
      "serviceId": "payment-service",
      "operation": "POST /checkout",
      "startTime": 1718000000000,
      "duration": 230,
      "status": "ok"
    }
  ]
}
```

### GET /services
Returns service map data.
```json
{
  "services": ["api-gateway", "payment-service", "user-service"],
  "edges": [
    { "from": "api-gateway", "to": "payment-service", "callCount": 1203 }
  ]
}
```

### GET /traces?service=payment-service&from=1718000000&to=1718003600
Returns trace list for a time window.

---

## Environment Variables

```env
# Database
DATABASE_URL=postgresql://postgres:password@localhost:5432/stacklens

# Redis
REDIS_URL=redis://localhost:6379

# Qdrant
QDRANT_URL=http://localhost:6333

# AI
GEMINI_API_KEY=your_key_here

# Server
PORT=4000
```

---

## How the AI Agent Works

1. A background job checks metrics every 60 seconds
2. If error rate > 5% or p99 latency > 2x baseline → triggers agent
3. Agent receives anomaly context and available tools
4. Agent thinks step by step:
   - "Which service is affected?" → calls get_traces()
   - "Did a deploy happen?" → calls get_recent_deploys()
   - "What errors are occurring?" → calls get_error_logs()
5. Agent synthesizes findings → generates root cause + post-mortem
6. Stores incident in Postgres + embedding in Qdrant
7. Sends Slack alert (optional)

---

## How Context Propagation Works

When service A calls service B:
1. SDK on A generates a traceId and spanId
2. Injects them as HTTP headers: `x-trace-id`, `x-span-id`
3. SDK on B reads those headers, creates a child span
4. Both spans share the same traceId → they appear in the same trace tree

AsyncLocalStorage holds the current span context so you don't need to
pass it through every function argument.
