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

-- ─────────────────────────────────────────────────────────────────────────────
-- AUTH & MULTI-TENANCY
--
-- The whole security model hangs off one ownership chain:
--
--     user ──belongs to──► org ──owns──► services ──produce──► spans
--
-- A logged-in user may ONLY read spans whose service belongs to their org.
-- An SDK (api_key) may ONLY write spans for the one service its key is scoped to.
-- Everything below exists to make that chain enforceable.
-- ─────────────────────────────────────────────────────────────────────────────

-- A tenant. One customer/company using Stacklens. Everything is owned by an org.
CREATE TABLE IF NOT EXISTS orgs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- People who log in to the dashboard. Each user belongs to exactly one org.
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES orgs(id),
  email          TEXT NOT NULL UNIQUE,        -- login identifier; UNIQUE = no duplicates
  password_hash  TEXT NOT NULL,               -- bcrypt hash — NEVER the raw password
  role           TEXT NOT NULL DEFAULT 'member',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Secret keys the SDK uses to send spans. Each key is scoped to ONE service,
-- so a leaked key can only write that one service's spans — nothing else.
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs(id),
  service_id   TEXT NOT NULL,                 -- the only service this key may write
  key_prefix   TEXT NOT NULL,                 -- first chars of the key (shown in UI, used for fast lookup)
  key_hash     TEXT NOT NULL,                 -- hash of the FULL key — we never store the raw key
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,                   -- for "this key was last seen 3h ago"
  revoked_at   TIMESTAMPTZ                    -- set (not deleted) when a key is disabled
);

-- We look up an incoming key by its prefix first (indexed), then verify the hash.
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys (key_prefix);

-- Link every service to the org that owns it. Added via ALTER (not in the
-- services CREATE above) so it also applies to databases that already exist.
-- Nullable for backward-compat with services created before auth; the app layer
-- always stamps org_id on new services.
ALTER TABLE services ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES orgs(id);
