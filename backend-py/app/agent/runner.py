"""
─────────────────────────────────────────────────────────────────────────────
The ReAct loop — the Python port of backend/src/agent/index.ts,
rebuilt provider-agnostic.

Reason → Act → Observe, until the model answers in text (or 8 rounds pass).
Note what is MISSING from this file: any vendor SDK import. The loop only
speaks the neutral language from providers.py — that's the whole point.

FAILOVER: run_agent walks the provider chain (AGENT_MODELS order). If a
provider's API dies mid-investigation, the whole investigation restarts on
the next provider with a fresh conversation — simpler and safer than trying
to hand a half-finished chat across companies.
─────────────────────────────────────────────────────────────────────────────
"""
import json
import re
import uuid
from dataclasses import dataclass, field

from app.agent.embeddings import embed_text
from app.agent.providers import LLMProvider, Message, build_provider_chain
from app.agent.tools import AGENT_TOOLS, execute_tool
from app.agent.vectorstore import upsert_incident
from app.db.postgres import execute
from app.routes.sse import broadcast

MAX_ITERATIONS = 8

SYSTEM_PROMPT = """You are an SRE (Site Reliability Engineer) AI agent for Stacklens.
You have been triggered because an anomaly was detected.
Your job is to investigate using the available tools, identify the root cause,
and write a concise post-mortem report.

Use tools to gather evidence. Consider checking find_similar_past_incidents early —
if this matches something seen before, its root cause is a strong lead worth
verifying against the current data rather than starting from zero.

When you have enough information, respond with a JSON object:
{
  "rootCause": "one paragraph explaining what went wrong and why",
  "postMortem": "markdown formatted post-mortem with sections: Summary, Timeline, Root Cause, Impact, Action Items"
}

Be specific: reference actual operation names, durations, and error counts from the data you gathered.
Do not speculate without data — use tools to verify your hypotheses."""


@dataclass
class AnomalyContext:
    service_id: str
    # The detector already has this from its own services query — passing it
    # through means _save_incident doesn't need a second lookup to learn who
    # to broadcast the finished incident to. None only for pre-auth service
    # rows with no owning org (broadcast is skipped for those).
    org_id: str | None
    type: str                       # 'latency_spike' | 'error_spike' | 'traffic_anomaly'
    details: str
    sample_trace_ids: list[str] = field(default_factory=list)


async def run_agent(anomaly: AnomalyContext) -> None:
    chain = build_provider_chain()
    if not chain:
        print("[Agent] No providers configured (set GEMINI_API_KEY / OPENAI_API_KEY) — skipping")
        return

    for provider in chain:
        try:
            print(f"[Agent] Investigating {anomaly.type} on {anomaly.service_id} via {provider.name}")
            done = await _investigate(provider, anomaly)
            if done:
                return
        except Exception as err:  # noqa: BLE001 — provider failed: fall through to the next
            print(f"[Agent] {provider.name} failed ({err}) — trying next provider")

    print("[Agent] All providers failed or gave no final answer")


async def _investigate(provider: LLMProvider, anomaly: AnomalyContext) -> bool:
    """One full ReAct investigation on one provider. True = incident saved."""
    messages: list[Message] = [{
        "role": "user",
        "text": f"""Anomaly detected:
Service: {anomaly.service_id}
Type: {anomaly.type}
Details: {anomaly.details}
Sample trace IDs: {", ".join(anomaly.sample_trace_ids[:3])}

Please investigate and provide a root cause analysis.""",
    }]

    for _ in range(MAX_ITERATIONS):
        reply = await provider.chat(SYSTEM_PROMPT, messages, AGENT_TOOLS)

        if reply["type"] == "tool_call":
            name, args = reply["name"], reply["args"]
            print(f"[Agent] Tool call: {name}({json.dumps(args)})")
            try:
                result = await execute_tool(name, args)
            except Exception as err:  # noqa: BLE001 — feed errors back, let the model adapt
                result = {"error": str(err)}

            # Append BOTH sides to the neutral history: the model's request
            # and our answer — the next round sees all evidence so far.
            messages.append({"role": "assistant", "tool_call": reply})
            messages.append({"role": "tool", "id": reply["id"], "name": name, "result": result})
            continue

        # Plain text = the final answer
        await _save_incident(anomaly, reply["text"])
        return True

    print(f"[Agent] Reached max iterations ({MAX_ITERATIONS}) without final response")
    return False


async def _save_incident(anomaly: AnomalyContext, agent_response: str) -> None:
    root_cause = post_mortem = agent_response

    # The model was asked for JSON — try to pull it out (it may wrap it in prose)
    match = re.search(r"\{[\s\S]*\}", agent_response)
    if match:
        try:
            parsed = json.loads(match.group(0))
            root_cause = parsed.get("rootCause", agent_response)
            post_mortem = parsed.get("postMortem", agent_response)
        except json.JSONDecodeError:
            pass  # keep the raw text

    incident_id = str(uuid.uuid4())
    await execute(
        """INSERT INTO incidents
             (id, service_id, type, detected_at, root_cause, post_mortem, related_trace_ids)
           VALUES ($1, $2, $3, NOW(), $4, $5, $6)""",
        incident_id, anomaly.service_id, anomaly.type,
        root_cause, post_mortem, anomaly.sample_trace_ids,
    )
    print(f"[Agent] Incident saved: {incident_id}")

    # ── RAG write side ──────────────────────────────────────────────────────
    # Embed THIS incident now so a FUTURE investigation's find_similar_past_
    # incidents tool call can find it. Best-effort: the incident is already
    # safely in Postgres above, so a Qdrant/embedding failure here must not
    # lose it — same "auxiliary feature never blocks the core write" rule as
    # the API key's last_used_at stamp in auth/deps.py.
    try:
        vector = await embed_text(f"{anomaly.type} on {anomaly.service_id}: {root_cause}")
        await upsert_incident(incident_id, vector, {
            "service_id": anomaly.service_id,
            "type": anomaly.type,
            "root_cause": root_cause,
        })
        # embedding_id starts NULL; setting it only on success makes it double
        # as a marker of "this incident is actually searchable" — a future
        # backfill job could target `WHERE embedding_id IS NULL`.
        await execute("UPDATE incidents SET embedding_id = $1 WHERE id = $1", incident_id)
    except Exception as err:  # noqa: BLE001 — RAG is an enhancement, not core
        print(f"[RAG] Failed to embed incident {incident_id}: {err}")

    # Live-push so open dashboards show the incident immediately — but ONLY to
    # the org that owns the affected service. The incident text is written by an
    # LLM that read that org's spans, so it can quote real operation names and
    # error messages; pushing it to every connected tab would leak them.
    # anomaly.org_id came from the detector's own services query — no second
    # lookup needed here to learn who to broadcast to.
    if anomaly.org_id:
        broadcast(
            "incident",
            # snake_case to match what /api/incidents returns, so one TypeScript
            # `Incident` type describes both pipes. Sending camelCase here is the
            # bug that made the live span feed crash (see sse._to_row_shape).
            {
                "id": incident_id,
                "service_id": anomaly.service_id,
                "type": anomaly.type,
                "root_cause": root_cause,
            },
            org_id=anomaly.org_id,
        )
