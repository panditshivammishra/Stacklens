"""
The span worker: persisting spans, and deriving the service map.

These call the worker's functions directly rather than waiting on its 60s
background loop — same code, deterministic timing.
"""
import uuid

from app.db.postgres import query
from app.workers.span_worker import persist_spans, rebuild_service_edges


def _raw_span(service_id: str, **overrides) -> dict:
    """A span in the worker's internal (camelCase) shape."""
    base = {
        "traceId": f"t-{uuid.uuid4().hex[:12]}",
        "spanId": f"s-{uuid.uuid4().hex[:12]}",
        "serviceId": service_id,
        "operation": "GET /x",
        "startTime": 1_700_000_000_000,
        "duration": 30,
        "status": "ok",
        "metadata": {},
    }
    base.update(overrides)
    return base


class TestPersistSpans:
    async def test_writes_a_span(self, client, org):
        s = _raw_span(org.service_id)
        await persist_spans([s])

        rows = await query("SELECT * FROM spans WHERE span_id = $1", s["spanId"])
        assert len(rows) == 1
        assert rows[0]["service_id"] == org.service_id

    async def test_is_idempotent(self, client, org):
        """At-least-once delivery means a span CAN arrive twice. ON CONFLICT
        DO NOTHING is what turns that into exactly-once storage."""
        s = _raw_span(org.service_id)
        await persist_spans([s])
        await persist_spans([s])          # replay

        rows = await query("SELECT * FROM spans WHERE span_id = $1", s["spanId"])
        assert len(rows) == 1

    async def test_refreshes_last_seen(self, client, org):
        before = (await query(
            "SELECT last_seen FROM services WHERE id = $1", org.service_id))[0]["last_seen"]

        await persist_spans([_raw_span(org.service_id)])

        after = (await query(
            "SELECT last_seen FROM services WHERE id = $1", org.service_id))[0]["last_seen"]
        assert after >= before

    async def test_empty_batch_is_a_no_op(self, client, org):
        await persist_spans([])           # must not raise

    async def test_error_spans_stored_as_errors(self, client, org):
        s = _raw_span(org.service_id, status="error")
        await persist_spans([s])
        rows = await query("SELECT status FROM spans WHERE span_id = $1", s["spanId"])
        assert rows[0]["status"] == "error"


class TestServiceMapEdges:
    """
    REGRESSION TESTS for a bug that shipped silently.

    The original code read `metadata.callerServiceId` — a field nothing has
    ever written — so the edges table stayed permanently empty with no error.
    Edges are now derived from the span tree instead.
    """

    async def test_cross_service_call_creates_an_edge(self, client, org):
        caller_id, _ = await _second_service(client, org)

        trace = f"t-{uuid.uuid4().hex[:12]}"
        parent = _raw_span(caller_id, traceId=trace, operation="GET /checkout")
        child = _raw_span(
            org.service_id, traceId=trace,
            parentSpanId=parent["spanId"], operation="GET /cart",
        )
        await persist_spans([parent, child])
        await rebuild_service_edges()

        edges = await query(
            """SELECT * FROM service_edges
               WHERE from_service_id = $1 AND to_service_id = $2""",
            caller_id, org.service_id,
        )
        assert len(edges) == 1
        assert edges[0]["call_count"] >= 1

    async def test_arrival_order_does_not_matter(self, client, org):
        """The caller's span usually arrives AFTER the callee's (A only
        finishes once B replies). A counter would lose that edge; a recompute
        picks it up regardless of order."""
        caller_id, _ = await _second_service(client, org)

        trace = f"t-{uuid.uuid4().hex[:12]}"
        parent = _raw_span(caller_id, traceId=trace)
        child = _raw_span(org.service_id, traceId=trace, parentSpanId=parent["spanId"])

        await persist_spans([child])      # child first — parent not stored yet
        await rebuild_service_edges()     # nothing to link yet
        await persist_spans([parent])     # parent arrives late
        await rebuild_service_edges()     # recompute finds it

        edges = await query(
            """SELECT * FROM service_edges
               WHERE from_service_id = $1 AND to_service_id = $2""",
            caller_id, org.service_id,
        )
        assert len(edges) == 1

    async def test_same_service_calls_are_not_edges(self, client, org):
        """A service calling itself is an internal call, not a dependency."""
        trace = f"t-{uuid.uuid4().hex[:12]}"
        parent = _raw_span(org.service_id, traceId=trace)
        child = _raw_span(org.service_id, traceId=trace, parentSpanId=parent["spanId"])
        await persist_spans([parent, child])
        await rebuild_service_edges()

        edges = await query(
            """SELECT * FROM service_edges
               WHERE from_service_id = $1 AND to_service_id = $1""",
            org.service_id,
        )
        assert edges == []

    async def test_rebuild_replaces_rather_than_accumulates(self, client, org):
        """Running it twice must not double the count — it is a recompute,
        not an increment."""
        caller_id, _ = await _second_service(client, org)

        trace = f"t-{uuid.uuid4().hex[:12]}"
        parent = _raw_span(caller_id, traceId=trace)
        child = _raw_span(org.service_id, traceId=trace, parentSpanId=parent["spanId"])
        await persist_spans([parent, child])

        await rebuild_service_edges()
        first = (await query(
            "SELECT call_count FROM service_edges WHERE from_service_id=$1 AND to_service_id=$2",
            caller_id, org.service_id))[0]["call_count"]

        await rebuild_service_edges()
        second = (await query(
            "SELECT call_count FROM service_edges WHERE from_service_id=$1 AND to_service_id=$2",
            caller_id, org.service_id))[0]["call_count"]

        assert first == second


class TestLiveFeedPayload:
    """
    The dashboard receives spans down two pipes: REST (Postgres rows,
    snake_case) and SSE (the worker's in-memory dict, camelCase off the SDK).
    One TypeScript `Span` interface describes both, so the two MUST agree.

    They did not: the live feed read `service_id` off an SSE span, got
    undefined, and the page crashed on `undefined.indexOf(':')`. Nothing
    caught it because no test had ever looked at what broadcast_spans emits.
    """

    # The column names /api/spans returns, minus the two Postgres assigns.
    REST_KEYS = {
        "trace_id", "span_id", "parent_span_id", "service_id",
        "operation", "start_time", "duration", "status", "metadata",
    }

    async def test_broadcast_uses_the_same_keys_as_the_rest_api(self, client, org):
        import json

        from app.routes import sse

        received: list[str] = []

        class _Mailbox:
            def put_nowait(self, payload): received.append(payload)

        listener = sse.Client(org_id=org.org_id, user_id="u", queue=_Mailbox())
        listener.service_ids = {org.service_id}
        sse.clients.add(listener)
        try:
            sse.broadcast_spans([_raw_span(org.service_id)])
        finally:
            sse.clients.discard(listener)

        assert received, "span was not delivered to a client of the owning org"
        pushed = json.loads(received[0].split("data: ", 1)[1].strip())[0]
        assert set(pushed) == self.REST_KEYS
        assert pushed["service_id"] == org.service_id

    async def test_other_orgs_still_do_not_receive_it(self, client, org, other_org):
        """The re-keying must not weaken the filter it runs alongside —
        that filter is the only thing stopping a cross-tenant live leak."""
        from app.routes import sse

        received: list[str] = []

        class _Mailbox:
            def put_nowait(self, payload): received.append(payload)

        stranger = sse.Client(org_id=other_org.org_id, user_id="u2", queue=_Mailbox())
        stranger.service_ids = {other_org.service_id}
        sse.clients.add(stranger)
        try:
            sse.broadcast_spans([_raw_span(org.service_id)])
        finally:
            sse.clients.discard(stranger)

        assert received == []


async def _second_service(client, org) -> tuple[str, str]:
    """Create another service in the same org, to act as the caller."""
    res = await client.post("/api/services", json={"name": f"gw-{uuid.uuid4().hex[:8]}"})
    assert res.status_code == 201
    body = res.json()
    return body["service_id"], body["api_key"]
