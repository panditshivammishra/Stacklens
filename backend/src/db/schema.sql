-- ─────────────────────────────────────────────────────────────────────────────
-- CONCEPT: Why these tables are designed this way
--
-- spans is the hottest table — millions of rows, always queried by time range.
-- Index on (service_id, created_at) covers: "all spans for service X in last 1hr"
-- metadata is JSONB — different span types carry different extra data
-- (HTTP span: statusCode, url  |  DB span: query, collection)
-- JSONB avoids 5 separate tables for 5 span types.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS services (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS spans (
  id              BIGSERIAL PRIMARY KEY,
  trace_id        TEXT NOT NULL,
  span_id         TEXT NOT NULL UNIQUE,
  parent_span_id  TEXT,
  service_id      TEXT NOT NULL REFERENCES services(id),
  operation       TEXT NOT NULL,
  start_time      BIGINT NOT NULL,
  duration        INTEGER,
  status          TEXT NOT NULL DEFAULT 'ok',
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- This index is the most important one in the whole schema.
-- Every dashboard query filters by service + time — without this index
-- Postgres scans the entire table for every query.
CREATE INDEX IF NOT EXISTS idx_spans_service_time
  ON spans (service_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_spans_trace_id
  ON spans (trace_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- service_edges: tracks which service calls which.
-- Updated (upserted) on every span that has a parent from a different service.
-- Powers the service dependency map on the dashboard.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS service_edges (
  from_service_id  TEXT NOT NULL REFERENCES services(id),
  to_service_id    TEXT NOT NULL REFERENCES services(id),
  call_count       BIGINT NOT NULL DEFAULT 1,
  avg_duration_ms  INTEGER NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (from_service_id, to_service_id)
);

CREATE TABLE IF NOT EXISTS incidents (
  id               TEXT PRIMARY KEY,
  service_id       TEXT NOT NULL REFERENCES services(id),
  type             TEXT NOT NULL,
  detected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  root_cause       TEXT,
  post_mortem      TEXT,
  related_trace_ids TEXT[],
  embedding_id     TEXT
);
