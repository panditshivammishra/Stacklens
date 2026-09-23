"""
─────────────────────────────────────────────────────────────────────────────
GET /api/sse — authenticated, org-scoped live stream.

CONCEPT: The mailbox pattern (asyncio.Queue) replaces Node's Set of raw pipes
  Node stored the raw response object (reply.raw) per client and called
  .write() on it whenever news arrived.
  In FastAPI you don't hold raw responses. Instead each connected browser
  gets its own asyncio.Queue — a mailbox. broadcast() drops the message into
  every mailbox; each connection is an async generator that waits on its own
  mailbox and yields whatever arrives. FastAPI writes each yield down the
  still-open HTTP connection.

CONCEPT: How disconnects clean themselves up
  When the browser closes the tab, FastAPI cancels the generator mid-await.
  The `finally:` block runs and removes the mailbox from the set — the same
  job Node's req.raw.on('close') did, but expressed as normal control flow.

─────────────────────────────────────────────────────────────────────────────
SECURING A STREAM — two problems a normal endpoint never has
─────────────────────────────────────────────────────────────────────────────
PROBLEM 1: EventSource cannot send headers.
  The browser's EventSource API has no way to attach "Authorization: Bearer".
  This is precisely why the whole system authenticates with a COOKIE — the
  browser attaches cookies to the SSE request automatically, so `require_user`
  works here unchanged. (It does need `withCredentials: true` on the client for
  a cross-origin request, and a named CORS origin on the server — a wildcard
  origin is rejected outright when credentials are involved.)

PROBLEM 2: a connection outlives the check that opened it.
  A normal request is authorised once and finishes in milliseconds. An SSE
  connection is authorised once and then stays open for hours, so we cannot
  re-check per message. Instead we bind the caller's identity to the mailbox at
  connect time and filter every outgoing message against it, so a connection can
  never receive more than the org it was opened by. The window that remains — a
  user removed from an org keeps their stream until they disconnect — is closed
  by the heartbeat below, which re-validates periodically and drops the
  connection when the session is no longer good.
─────────────────────────────────────────────────────────────────────────────
"""
import asyncio
import json
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from app.auth.deps import CurrentUser, require_user
from app.db.postgres import query
from app.routes.query import service_ids_for_org

router = APIRouter()

# How often to send a comment line down each stream. Two jobs:
#   - keeps proxies/load balancers from closing an "idle" connection
#   - gives us a regular moment to re-check that the session is still valid
HEARTBEAT_S = 30


# eq=False is required, not cosmetic: a normal @dataclass generates __eq__, and
# Python then sets __hash__ to None, making instances unhashable — so
# `clients.add(client)` would raise TypeError. eq=False keeps the default
# identity-based __eq__/__hash__, which is what we actually want here: two
# connections are "the same" only if they are literally the same object, even if
# two tabs from the same user hold identical field values.
@dataclass(eq=False)
class Client:
    """One connected dashboard tab: its mailbox plus who it belongs to."""
    queue: asyncio.Queue[str] = field(default_factory=asyncio.Queue)
    org_id: str = ""
    user_id: str = ""
    # Services this org owns, refreshed on each heartbeat so a service created
    # after the tab was opened starts appearing without a page reload.
    service_ids: set[str] = field(default_factory=set)


clients: set[Client] = set()


def _to_row_shape(span: dict[str, Any]) -> dict[str, Any]:
    """
    Re-key one span from the SDK's camelCase into the snake_case shape the
    /api/* routes return.

    WHY THIS EXISTS: the dashboard receives spans down two different pipes —
    REST (rows straight out of Postgres, snake_case) and SSE (the in-memory
    dict the worker just parsed off Redis, camelCase, because that is how the
    SDK serialises it). One TypeScript `Span` interface describes both. It
    matched only the REST pipe, so every field the live feed read off an SSE
    span was `undefined` and the page crashed on `service_id.indexOf`.

    Converting here rather than in the dashboard keeps one wire shape for the
    dashboard to know about; the REST side is many endpoints, this is one place.
    `id` and `created_at` are assigned by Postgres and are not in this dict —
    the live feed does not use them, and inventing values would be worse.
    """
    return {
        "trace_id": span.get("traceId"),
        "span_id": span.get("spanId"),
        "parent_span_id": span.get("parentSpanId"),
        "service_id": span.get("serviceId"),
        "operation": span.get("operation"),
        "start_time": span.get("startTime"),
        "duration": span.get("duration"),
        "status": span.get("status"),
        "metadata": span.get("metadata") or {},
    }


def broadcast_spans(spans: list[dict[str, Any]]) -> None:
    """
    Called by the span worker after each persisted batch.

    THE FILTER IS THE SECURITY BOUNDARY: each client is sent only the spans
    belonging to services its org owns. Without this, every dashboard in the
    world would receive every customer's live traffic — the single worst leak
    this system could have, because it needs no attack at all, just a login.
    """
    if not clients:
        return

    rows = [_to_row_shape(s) for s in spans]

    for client in clients:
        mine = [s for s in rows if s.get("service_id") in client.service_ids]
        if not mine:
            continue
        payload = f"event: spans\ndata: {json.dumps(mine)}\n\n"
        # put_nowait: never block the worker on a slow client's mailbox
        client.queue.put_nowait(payload)


def broadcast(event: str, data: Any, org_id: str) -> None:
    """Generic org-targeted push (used for incidents)."""
    payload = f"event: {event}\ndata: {json.dumps(data)}\n\n"
    for client in clients:
        if client.org_id == org_id:
            client.queue.put_nowait(payload)


@router.get("/api/sse")
async def sse(user: CurrentUser = Depends(require_user)) -> StreamingResponse:
    # Depends(require_user) runs BEFORE the stream opens. An unauthenticated
    # request gets a plain 401 and no connection is ever established.
    client = Client(
        org_id=user.org_id,
        user_id=user.id,
        service_ids=set(await service_ids_for_org(user.org_id)),
    )
    clients.add(client)

    async def stream() -> AsyncGenerator[str, None]:
        try:
            yield ": connected\n\n"
            while True:
                try:
                    # Wait for mail, but give up after HEARTBEAT_S so the loop
                    # gets a turn even when nothing is happening. Without the
                    # timeout this coroutine would park forever and could never
                    # re-check anything.
                    payload = await asyncio.wait_for(client.queue.get(), HEARTBEAT_S)
                    yield payload
                except asyncio.TimeoutError:
                    # Quiet period. Re-validate the session, refresh the service
                    # allow-list, and send a comment line to keep the pipe warm.
                    # A line starting with ':' is a comment in the SSE format —
                    # the browser reads it and fires no event.
                    still_valid = await query(
                        "SELECT id FROM users WHERE id = $1 AND org_id = $2",
                        client.user_id,
                        client.org_id,
                    )
                    if not still_valid:
                        break          # account gone or moved orgs → close stream

                    client.service_ids = set(await service_ids_for_org(client.org_id))
                    yield ": heartbeat\n\n"
        finally:
            clients.discard(client)    # tab closed → generator cancelled → cleanup

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            # Tells nginx not to buffer the stream. Without it a proxy can hold
            # chunks back "to be efficient" and the live feed arrives in bursts.
            "X-Accel-Buffering": "no",
        },
    )
