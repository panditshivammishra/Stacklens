"""
The read side: numbers the dashboard puts in front of people.

A wrong number on a dashboard is worse than a missing one — it gets believed.
These pin the arithmetic, not just the response shape.
"""
from app.db.postgres import execute
from app.workers.span_worker import persist_spans

from tests.conftest import span


class TestStats:
    async def test_rps_is_spans_per_second_over_the_last_minute(self, client, org):
        """
        Regression: rps was COUNT(*) / 60 over a ONE-HOUR window — an hour's
        count divided by the seconds in a minute. For steady traffic that is
        60x too high; the live dashboard read 286/s against a real ~6.6/s.

        The old formula only went wrong once there was OLDER traffic in the
        hour, so the test needs some: 30 spans from half an hour ago plus 30
        from just now. Current rate = 30 / 60 = 0.5. The old code said 1.0.
        """
        earlier = [span(org.service_id) for _ in range(30)]
        await persist_spans(earlier)
        await execute(
            "UPDATE spans SET created_at = NOW() - INTERVAL '30 minutes' WHERE span_id = ANY($1)",
            [s["spanId"] for s in earlier],
        )
        await persist_spans([span(org.service_id) for _ in range(30)])

        res = await org.client.get("/api/stats")
        assert res.status_code == 200
        body = res.json()
        assert int(body["total"]) == 60
        assert float(body["rps"]) == 0.5

    async def test_spans_older_than_a_minute_do_not_count_toward_rps(self, client, org):
        """They still count toward `total` (a one-hour figure) — only the rate
        is restricted to the recent window."""
        spans = [span(org.service_id) for _ in range(12)]
        await persist_spans(spans)
        await execute(
            "UPDATE spans SET created_at = NOW() - INTERVAL '10 minutes' WHERE service_id = $1",
            org.service_id,
        )

        body = (await org.client.get("/api/stats")).json()
        assert int(body["total"]) == 12
        assert float(body["rps"]) == 0
