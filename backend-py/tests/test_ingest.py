"""
POST /ingest — the SDK's write path.

The headline guarantee: a caller cannot write spans for a service it does not
own, no matter what it puts in the request body.
"""
from tests.conftest import span


class TestIngestAuth:
    async def test_no_key_rejected(self, client, org):
        res = await client.post("/ingest", json={"spans": [span()]})
        assert res.status_code == 401

    async def test_bogus_key_rejected(self, client, org):
        res = await client.post(
            "/ingest",
            json={"spans": [span()]},
            headers={"x-api-key": "sl_live_completely_made_up_key_here"},
        )
        assert res.status_code == 401

    async def test_valid_key_accepted(self, client, org):
        res = await client.post(
            "/ingest",
            json={"spans": [span()]},
            headers={"x-api-key": org.api_key},
        )
        assert res.status_code == 202
        assert res.json() == {"accepted": 1}

    async def test_revoked_key_stops_working_immediately(self, client, org):
        """A leaked key must die the moment it is revoked — not when a cache
        expires. This is why keys are database rows and sessions are not."""
        keys = (await client.get("/api/keys")).json()
        key_id = next(k["id"] for k in keys if k["service_id"] == org.service_id)

        assert (await client.delete(f"/api/keys/{key_id}")).status_code == 200

        res = await client.post(
            "/ingest", json={"spans": [span()]},
            headers={"x-api-key": org.api_key},
        )
        assert res.status_code == 401


class TestSpoofingIsImpossible:
    """
    The payload carries a serviceId, and the sender controls it completely.
    The server must ignore it and use the one the key is scoped to.
    """

    async def test_payload_service_id_is_overwritten(self, client, org):
        attack = span(serviceId="SOME-OTHER-COMPANYS-SERVICE")
        res = await client.post(
            "/ingest", json={"spans": [attack]},
            headers={"x-api-key": org.api_key},
        )
        assert res.status_code == 202          # accepted...

        await _drain_worker()

        rows = (await client.get(f"/api/trace/{attack['traceId']}")).json()
        assert len(rows) == 1
        # ...but stored under the KEY's service, not the claimed one
        assert rows[0]["service_id"] == org.service_id
        assert "SOME-OTHER-COMPANYS-SERVICE" not in rows[0]["service_id"]

    async def test_cannot_write_into_another_orgs_service(
        self, client, org, other_org
    ):
        """Even naming the victim's exact service id doesn't help — the id is
        taken off the key, so the span lands in the attacker's own service."""
        attack = span(serviceId=other_org.service_id)
        res = await client.post(
            "/ingest", json={"spans": [attack]},
            headers={"x-api-key": org.api_key},
        )
        assert res.status_code == 202

        await _drain_worker()

        # the victim sees nothing
        victim_view = await other_org.client.get(f"/api/trace/{attack['traceId']}")
        assert victim_view.status_code == 404


class TestValidation:
    async def test_empty_batch_rejected(self, client, org):
        res = await client.post(
            "/ingest", json={"spans": []}, headers={"x-api-key": org.api_key}
        )
        assert res.status_code == 422

    async def test_missing_required_field_rejected(self, client, org):
        bad = span()
        del bad["traceId"]
        res = await client.post(
            "/ingest", json={"spans": [bad]}, headers={"x-api-key": org.api_key}
        )
        assert res.status_code == 422

    async def test_invalid_status_rejected(self, client, org):
        res = await client.post(
            "/ingest",
            json={"spans": [span(status="not-a-real-status")]},
            headers={"x-api-key": org.api_key},
        )
        assert res.status_code == 422


async def _drain_worker() -> None:
    """
    Push whatever is sitting in the Redis stream into Postgres, now.

    The background worker would do this within a couple of seconds anyway, but
    waiting on a timer makes tests slow and flaky. Calling the same functions
    it calls gives a deterministic result without mocking anything.
    """
    from app.workers.span_worker import (
        BATCH_SIZE, CONSUMER, GROUP, STREAM_KEY,
        parse_messages, persist_spans,
    )
    from app.db.redis_client import redis

    result = await redis.xreadgroup(
        GROUP, CONSUMER, streams={STREAM_KEY: ">"}, count=BATCH_SIZE, block=1500
    )
    if not result:
        return
    spans, ids = parse_messages(result[0][1])
    await persist_spans(spans)
    if ids:
        await redis.xack(STREAM_KEY, GROUP, *ids)
