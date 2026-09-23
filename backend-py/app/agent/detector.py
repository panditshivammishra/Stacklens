"""
─────────────────────────────────────────────────────────────────────────────
Anomaly detector — the Python port of backend/src/agent/detector.ts

Every 60s, for every service: compare the last 5 minutes against the last
hour's baseline. Error rate over 10%, or p95 over 2x baseline → wake the
AI agent. A 10-minute cooldown per service stops alert spam.

Node ran this on setInterval; here it's one more asyncio background task
(started in main.py's lifespan, next to the span worker).
─────────────────────────────────────────────────────────────────────────────
"""
import asyncio
import time

from app.agent.runner import AnomalyContext, run_agent
from app.db.postgres import query

CHECK_INTERVAL_S = 60
ERROR_RATE_THRESHOLD = 0.10
LATENCY_SPIKE_RATIO = 2.0
COOLDOWN_S = 10 * 60

_last_triggered: dict[str, float] = {}   # service_id → epoch seconds


async def anomaly_detector() -> None:
    print("Anomaly detector started (60s interval)")
    while True:
        try:
            await asyncio.sleep(CHECK_INTERVAL_S)
            services = await query("SELECT id, org_id FROM services")
            for row in services:
                await _check_service(row["id"], row["org_id"])
        except asyncio.CancelledError:
            raise                      # shutdown — same rule as the span worker
        except Exception as err:       # noqa: BLE001
            print(f"Detector error: {err}")


async def _check_service(service_id: str, org_id: str | None) -> None:
    # Cooldown: at most one investigation per service per 10 minutes
    last = _last_triggered.get(service_id, 0)
    if time.time() - last < COOLDOWN_S:
        return

    anomaly = (
        await _detect_error_spike(service_id, org_id)
        or await _detect_latency_spike(service_id, org_id)
    )
    if not anomaly:
        return

    _last_triggered[service_id] = time.time()
    print(f"[Detector] Anomaly on {service_id}: {anomaly.type} — {anomaly.details}")

    # Fire-and-forget: the investigation must not block the 60s check loop
    asyncio.create_task(run_agent(anomaly))


async def _detect_error_spike(service_id: str, org_id: str | None) -> AnomalyContext | None:
    rows = await query(
        """SELECT
             COUNT(*)                                         AS total,
             SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors,
             SUM(CASE WHEN status='error' AND created_at > NOW()-INTERVAL '5 min' THEN 1 ELSE 0 END) AS recent_errors,
             SUM(CASE WHEN created_at > NOW()-INTERVAL '5 min' THEN 1 ELSE 0 END) AS recent_total
           FROM spans
           WHERE service_id = $1
             AND created_at > NOW() - INTERVAL '1 hour'""",
        service_id,
    )
    if not rows:
        return None
    row = rows[0]
    recent_total = int(row["recent_total"] or 0)
    recent_errors = int(row["recent_errors"] or 0)
    if recent_total < 10:                      # not enough traffic to judge
        return None
    rate = recent_errors / recent_total
    if rate < ERROR_RATE_THRESHOLD:
        return None

    traces = await query(
        """SELECT DISTINCT trace_id FROM spans
           WHERE service_id = $1 AND status = 'error'
             AND created_at > NOW() - INTERVAL '5 min'
           LIMIT 5""",
        service_id,
    )
    baseline = int(row["errors"] or 0) / max(int(row["total"] or 1), 1)
    return AnomalyContext(
        service_id=service_id,
        org_id=org_id,
        type="error_spike",
        details=(
            f"Error rate jumped to {rate * 100:.1f}% in the last 5 minutes "
            f"({recent_errors}/{recent_total} requests). "
            f"Hourly baseline was {baseline * 100:.1f}%."
        ),
        sample_trace_ids=[t["trace_id"] for t in traces],
    )


async def _detect_latency_spike(service_id: str, org_id: str | None) -> AnomalyContext | None:
    rows = await query(
        """SELECT
             ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration)
                   FILTER (WHERE created_at BETWEEN NOW()-INTERVAL '1 hour' AND NOW()-INTERVAL '5 min')
             )::int AS baseline_p95,
             ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration)
                   FILTER (WHERE created_at > NOW()-INTERVAL '5 min')
             )::int AS recent_p95
           FROM spans
           WHERE service_id = $1
             AND created_at > NOW() - INTERVAL '1 hour'
             AND duration IS NOT NULL""",
        service_id,
    )
    if not rows:
        return None
    baseline_p95 = rows[0]["baseline_p95"]
    recent_p95 = rows[0]["recent_p95"]
    if not baseline_p95 or not recent_p95:
        return None
    if recent_p95 < 200:                       # fast services don't page anyone
        return None
    ratio = recent_p95 / baseline_p95
    if ratio < LATENCY_SPIKE_RATIO:
        return None

    traces = await query(
        """SELECT DISTINCT trace_id FROM spans
           WHERE service_id = $1 AND duration > $2
             AND created_at > NOW() - INTERVAL '5 min'
           LIMIT 5""",
        service_id, baseline_p95 * 1.5,
    )
    return AnomalyContext(
        service_id=service_id,
        org_id=org_id,
        type="latency_spike",
        details=(
            f"p95 latency spiked to {recent_p95}ms "
            f"({ratio:.1f}x the {baseline_p95}ms baseline from the past hour)."
        ),
        sample_trace_ids=[t["trace_id"] for t in traces],
    )
