"""
─────────────────────────────────────────────────────────────────────────────
Read-side API — every endpoint is now login-protected AND org-scoped.

CONCEPT: Query parameters live in the function signature
  Node:   const { serviceId, limit = '100' } = req.query
  Python: async def spans(serviceId: str | None = None, limit: int = 100)
  FastAPI reads ?serviceId=...&limit=... from the URL, converts the types
  ("100" → int 100), and rejects garbage (?limit=abc → 422) automatically.

CONCEPT: Path parameters
  Node:   '/api/trace/:traceId'  → req.params.traceId
  Python: '/api/trace/{trace_id}' → a trace_id argument on the function

─────────────────────────────────────────────────────────────────────────────
MULTI-TENANCY: the rule every query below obeys
─────────────────────────────────────────────────────────────────────────────
    A user may only ever see spans whose service belongs to their org.

Two mistakes are easy here, and both are guarded against:

1. FORGETTING THE FILTER on one endpoint. One unscoped query leaks every
   customer's data through that hole, no matter how careful the other five are.
   So the org filter is never hand-written per query — it goes through the same
   `service_ids_for_org()` helper everywhere, and each endpoint takes the user
   as a required dependency, which makes an unscoped query hard to write by
   accident.

2. TRUSTING AN ID FROM THE URL. ?serviceId=... and /trace/{id} are attacker-
   controlled. Passing them straight into SQL would let someone read another
   org's data just by guessing an id. Every one of them is intersected with the
   caller's own services before it reaches the database.
─────────────────────────────────────────────────────────────────────────────
"""
import asyncio
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status

from app.auth.deps import CurrentUser, require_user
from app.db.postgres import query

router = APIRouter()


async def service_ids_for_org(org_id: str) -> list[str]:
    """Every service this org owns. The allow-list all reads are filtered by."""
    rows = await query("SELECT id FROM services WHERE org_id = $1", org_id)
    return [r["id"] for r in rows]


async def _scoped_ids(user: CurrentUser, requested: str | None) -> list[str]:
    """
    Resolve "which services am I allowed to read?", honouring an optional filter.

    If the caller asked for a specific service, we return it ONLY if it is in
    their own allow-list. Asking for someone else's service yields an empty list
    (→ empty results), never their data.
    """
    owned = await service_ids_for_org(user.org_id)
    if requested is None:
        return owned
    return [requested] if requested in owned else []


@router.get("/api/services")
async def services(user: CurrentUser = Depends(require_user)) -> list[dict[str, Any]]:
    return await query(
        """SELECT
             s.id,
             s.name,
             s.last_seen,
             COUNT(sp.id)                                            AS total_spans,
             SUM(CASE WHEN sp.status = 'error' THEN 1 ELSE 0 END)   AS error_count,
             ROUND(
               PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY sp.duration)
             )::int                                                  AS p95_ms
           FROM services s
           LEFT JOIN spans sp ON sp.service_id = s.id
             AND sp.created_at > NOW() - INTERVAL '1 hour'
           WHERE s.org_id = $1
           GROUP BY s.id, s.name, s.last_seen
           ORDER BY s.last_seen DESC""",
        user.org_id,
    )


@router.get("/api/spans")
async def spans(
    serviceId: str | None = None,   # camelCase to match the existing dashboard URLs
    limit: int = 100,
    since: datetime | None = None,
    user: CurrentUser = Depends(require_user),
) -> list[dict[str, Any]]:
    allowed = await _scoped_ids(user, serviceId)
    if not allowed:
        return []                   # no services yet, or asked for one they don't own

    # ANY($2) is asyncpg's way of saying "service_id IN (this list)" with a
    # single parameter — the list still travels separately from the SQL text,
    # so it is as injection-proof as any other placeholder.
    params: list[Any] = [limit, allowed]
    where = " AND s.service_id = ANY($2)"
    if since:
        params.append(since)
        where += f" AND s.created_at > ${len(params)}"

    return await query(
        f"""SELECT * FROM spans s
            WHERE 1=1 {where}
            ORDER BY created_at DESC
            LIMIT $1""",
        *params,
    )


@router.get("/api/trace/{trace_id}")
async def trace(
    trace_id: str,
    user: CurrentUser = Depends(require_user),
) -> list[dict[str, Any]]:
    allowed = await service_ids_for_org(user.org_id)
    if not allowed:
        return []

    rows = await query(
        """SELECT * FROM spans
           WHERE trace_id = $1
             AND service_id = ANY($2)
           ORDER BY start_time ASC""",
        trace_id,
        allowed,
    )

    # A trace id that exists but belongs to another org must look exactly like a
    # trace id that does not exist — otherwise the difference between 404 and
    # 200-with-nothing tells an attacker which ids are real.
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Trace not found")
    return rows


@router.get("/api/service-map")
async def service_map(user: CurrentUser = Depends(require_user)) -> dict[str, Any]:
    allowed = await service_ids_for_org(user.org_id)
    if not allowed:
        return {"nodes": [], "edges": []}

    # asyncio.gather = Promise.all — both queries run concurrently.
    nodes, edges = await asyncio.gather(
        query(
            "SELECT id, name, last_seen FROM services WHERE org_id = $1 ORDER BY name",
            user.org_id,
        ),
        # BOTH ends of an edge must be ours. Checking only one end would reveal
        # that some unknown outside service talks to ours.
        query(
            """SELECT from_service_id, to_service_id, call_count, avg_duration_ms
               FROM service_edges
              WHERE from_service_id = ANY($1)
                AND to_service_id   = ANY($1)
              ORDER BY call_count DESC""",
            allowed,
        ),
    )
    return {"nodes": nodes, "edges": edges}


@router.get("/api/incidents")
async def incidents(user: CurrentUser = Depends(require_user)) -> list[dict[str, Any]]:
    allowed = await service_ids_for_org(user.org_id)
    if not allowed:
        return []
    return await query(
        """SELECT * FROM incidents
            WHERE service_id = ANY($1)
            ORDER BY detected_at DESC
            LIMIT 50""",
        allowed,
    )


@router.get("/api/stats")
async def stats(
    serviceId: str | None = None,
    user: CurrentUser = Depends(require_user),
) -> dict[str, Any]:
    allowed = await _scoped_ids(user, serviceId)
    if not allowed:
        return {"total": 0, "errors": 0, "p95_ms": None, "rps": 0}

    # `rps` is spans per second over the LAST 60 SECONDS — current throughput.
    # It used to be COUNT(*) / 60.0 over the whole hour, i.e. a one-hour count
    # divided by the seconds in a MINUTE: 60x too high once a service had been
    # running an hour (286 "per second" for real traffic of about 6.6). It also
    # counts spans, not requests — one request is several spans — so the
    # dashboard labels it spans/s. The key keeps its name for API compatibility.
    rows = await query(
        """SELECT
              COUNT(*)                                            AS total,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)  AS errors,
              ROUND(
                PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration)
              )::int                                              AS p95_ms,
              ROUND(
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '60 seconds')
                / 60.0, 2
              )                                                   AS rps
            FROM spans
            WHERE created_at > NOW() - INTERVAL '1 hour'
              AND service_id = ANY($1)""",
        allowed,
    )
    return rows[0]
