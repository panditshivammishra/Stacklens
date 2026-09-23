"""
─────────────────────────────────────────────────────────────────────────────
Span worker — the Python port of workers/spanWorker.ts

Same design, new language:
  XADD (ingest route)  →  XREADGROUP (this loop)  →  INSERT  →  XACK

CONCEPT: Consumer groups give at-least-once delivery
  Messages read via XREADGROUP sit in a "pending list" until XACKed.
  If this process crashes before XACK, recover_pending() re-reads them on
  the next boot (streams id '0' = my pending messages, '>' = brand new ones).

CONCEPT: ON CONFLICT DO NOTHING makes retries safe (idempotent)
  at-least-once delivery means a span may be processed twice; the UNIQUE
  span_id + DO NOTHING turns the second insert into a no-op → effectively
  exactly-once in Postgres.

CONCEPT: asyncio.create_task replaces Node's fire-and-forget promise
  Node: startSpanWorker().catch(...)  — a promise looping forever.
  Python: asyncio.create_task(span_worker()) in main.py's lifespan — a
  background task sharing the event loop with the web server.
─────────────────────────────────────────────────────────────────────────────
"""
import asyncio
import json
from typing import Any

from redis.exceptions import ResponseError

from app.db.postgres import execute
from app.db.redis_client import redis
from app.routes.sse import broadcast_spans

STREAM_KEY = "spans:stream"
GROUP = "span-workers"
CONSUMER = "worker-1"
BATCH_SIZE = 100
BLOCK_MS = 2000


async def ensure_consumer_group() -> None:
    try:
        # mkstream=True: create the stream if missing; id '$' = only new messages
        await redis.xgroup_create(STREAM_KEY, GROUP, id="$", mkstream=True)
    except ResponseError as err:
        # BUSYGROUP = group already exists — normal on every restart
        if "BUSYGROUP" not in str(err):
            raise


async def persist_spans(spans: list[dict[str, Any]]) -> None:
    if not spans:
        return

    # Services first — spans have a foreign key to services.id.
    #
    # Since auth landed, a service row is created explicitly (POST /api/services,
    # which also stamps org_id), and /ingest only accepts a service id that came
    # off a valid API key. So in practice this upsert now always takes the
    # ON CONFLICT branch and just refreshes last_seen — the "alive" signal the
    # dashboard sorts by. The INSERT branch is kept as a safety net for rows
    # predating auth; note it deliberately does not touch org_id, so an existing
    # service's ownership can never be overwritten by an incoming span.
    for service_id in {s["serviceId"] for s in spans}:
        await execute(
            """INSERT INTO services (id, name, first_seen, last_seen)
               VALUES ($1, $1, NOW(), NOW())
               ON CONFLICT (id) DO UPDATE SET last_seen = NOW()""",
            service_id,
        )

    for s in spans:
        await execute(
            """INSERT INTO spans
                 (trace_id, span_id, parent_span_id, service_id, operation,
                  start_time, duration, status, metadata)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
               ON CONFLICT (span_id) DO NOTHING""",
            s["traceId"],
            s["spanId"],
            s.get("parentSpanId"),
            s["serviceId"],
            s["operation"],
            int(s["startTime"]),
            int(s["duration"]) if s.get("duration") is not None else None,
            s["status"],
            json.dumps(s.get("metadata") or {}),
        )

    # Note: service_edges is NOT built here. See rebuild_service_edges() below
    # for why counting edges span-by-span cannot work.


# ─────────────────────────────────────────────────────────────────────────────
# SERVICE MAP EDGES — "who calls whom"
#
# THE BUG THIS REPLACES
#   The original code (both Node and Python) tried to build edges one span at a
#   time by reading `span.metadata.callerServiceId`. Nothing in the SDK has ever
#   written that field, so the `if` guarding it was ALWAYS false. Result: the
#   service_edges table stayed empty forever and the dashboard's service map
#   silently rendered nothing — no error, no log, just a feature that did not
#   exist. (Confirmed by grepping the whole repo: the field appears only in the
#   two workers that read it.)
#
# WHY NOT JUST LOOK UP THE PARENT PER SPAN?
#   The obvious fix — for each child span, look up its parent's service_id —
#   breaks on arrival order. When A calls B, A's span only ENDS once B has
#   replied, so A's span is usually flushed AFTER B's. Processing B's span, the
#   parent row does not exist yet, the lookup finds nothing, and that edge is
#   lost forever. Incremental counters can never repair themselves.
#
# THE DESIGN USED HERE: derive, don't count
#   Every 60s we RECOMPUTE the whole edge set from the span tree over a rolling
#   window. A span's parent_span_id points at the caller's span; joining spans
#   to itself on that column tells us exactly which service called which.
#     - order-independent: a late parent is simply picked up on the next pass
#     - self-healing: a wrong or partial result is overwritten, never accumulated
#     - no double counting: it is a recompute, not an increment
#     - call_count means "calls in the last 24h", so a decommissioned link
#       naturally disappears instead of lingering forever
# ─────────────────────────────────────────────────────────────────────────────
EDGE_WINDOW = "24 hours"
EDGE_REBUILD_INTERVAL_S = 60


async def rebuild_service_edges() -> None:
    """Recompute the service map's edges from the span tree. Idempotent."""
    await execute(
        f"""INSERT INTO service_edges
              (from_service_id, to_service_id, call_count, avg_duration_ms, updated_at)
            SELECT parent.service_id,
                   child.service_id,
                   COUNT(*),
                   COALESCE(ROUND(AVG(child.duration))::int, 0),
                   NOW()
              FROM spans child
              JOIN spans parent ON parent.span_id = child.parent_span_id
             WHERE child.created_at > NOW() - INTERVAL '{EDGE_WINDOW}'
               AND parent.service_id <> child.service_id   -- same service = internal call
             GROUP BY parent.service_id, child.service_id
            ON CONFLICT (from_service_id, to_service_id) DO UPDATE
              SET call_count      = EXCLUDED.call_count,      -- replace, don't add
                  avg_duration_ms = EXCLUDED.avg_duration_ms,
                  updated_at      = NOW()"""
    )

    # Links that produced no traffic in the window age out on their own: every
    # live edge just had updated_at set to NOW(), so anything older is stale.
    await execute(
        f"DELETE FROM service_edges WHERE updated_at < NOW() - INTERVAL '{EDGE_WINDOW}'"
    )


async def service_edge_builder() -> None:
    """Background task: keep the service map fresh. Started from lifespan."""
    while True:
        try:
            await asyncio.sleep(EDGE_REBUILD_INTERVAL_S)
            await rebuild_service_edges()
        except asyncio.CancelledError:
            raise                        # shutdown — let lifespan stop us
        except Exception as err:         # noqa: BLE001 — never kill the loop
            print(f"Service edge builder error: {err}")


def parse_messages(
    messages: list[tuple[str, dict[str, str]]],
) -> tuple[list[dict[str, Any]], list[str]]:
    """Turn raw stream entries into (spans, message_ids)."""
    spans: list[dict[str, Any]] = []
    ids: list[str] = []
    for msg_id, fields in messages:
        ids.append(msg_id)
        raw = fields.get("data")
        if raw:
            try:
                spans.append(json.loads(raw))
            except json.JSONDecodeError:
                pass  # malformed span — still ACK it so it can't block the stream
    return spans, ids


async def recover_pending() -> None:
    """Re-process messages delivered before a crash but never ACKed."""
    result = await redis.xreadgroup(
        GROUP, CONSUMER, streams={STREAM_KEY: "0"}, count=BATCH_SIZE
    )
    if not result or not result[0][1]:
        return
    spans, ids = parse_messages(result[0][1])
    print(f"Span worker: recovering {len(ids)} pending messages")
    await persist_spans(spans)
    if ids:
        await redis.xack(STREAM_KEY, GROUP, *ids)


async def span_worker() -> None:
    await ensure_consumer_group()
    await recover_pending()
    print("Span worker started — consuming spans:stream")

    while True:
        try:
            result = await redis.xreadgroup(
                GROUP, CONSUMER,
                streams={STREAM_KEY: ">"},   # '>' = only never-delivered messages
                count=BATCH_SIZE,
                block=BLOCK_MS,              # sleep up to 2s instead of busy-polling
            )
            if not result:
                continue                     # timeout, nothing new — loop again

            spans, ids = parse_messages(result[0][1])
            await persist_spans(spans)
            broadcast_spans(spans)           # live-feed push to open dashboards

            if ids:
                await redis.xack(STREAM_KEY, GROUP, *ids)
                print(f"Span worker: persisted {len(spans)} spans")

        except asyncio.CancelledError:
            raise                            # shutdown — let lifespan stop us
        except Exception as err:             # noqa: BLE001 — worker must survive anything
            print(f"Span worker error: {err}")
            await asyncio.sleep(1)           # back off; don't hammer a broken DB
