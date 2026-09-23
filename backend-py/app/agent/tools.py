"""
─────────────────────────────────────────────────────────────────────────────
Agent tools — the Python port of backend/src/agent/tools.ts

Two halves, and only one is vendor-flavored... now neither is:
  1. TOOL SPECS  — descriptions of what exists. Written ONCE here in neutral
     JSON-schema (lowercase types). Each adapter reformats them into its
     company's form (Gemini uppercases the types, OpenAI wraps them).
  2. IMPLEMENTATIONS — plain SQL against our own Postgres. No vendor anywhere.

CONCEPT: RAG as a tool, not a static prompt prefix
  The common, simpler way to build RAG is: always fetch similar documents
  first, glue them onto the prompt, then ask the model. That runs a retrieval
  on every single call, whether it's useful or not.
  Here, "check whether we've seen this before" is just ANOTHER tool
  (`find_similar_past_incidents`) sitting next to the SQL ones. The model
  decides, mid-investigation, whether historical context would actually help
  — the same Reason→Act→Observe loop that calls get_error_summary can equally
  well call this one. RAG becomes one more source of evidence the agent can
  reach for, not a mandatory step bolted onto every request.
─────────────────────────────────────────────────────────────────────────────
"""
import json
from typing import Any

from app.agent.embeddings import embed_text
from app.agent.vectorstore import search_similar
from app.db.postgres import query

AGENT_TOOLS: list[dict[str, Any]] = [
    {
        "name": "get_recent_spans",
        "description": "Fetch the most recent spans for a service to understand what operations are running and which ones are slow or failing.",
        "parameters": {
            "type": "object",
            "properties": {
                "service_id": {"type": "string", "description": "The service ID to query"},
                "limit": {"type": "number", "description": "Number of spans to return (default 50)"},
                "status_filter": {"type": "string", "description": 'Optional: "error" to only return error spans'},
            },
            "required": ["service_id"],
        },
    },
    {
        "name": "get_error_summary",
        "description": "Get a summary of errors for a service: count by operation, duration range.",
        "parameters": {
            "type": "object",
            "properties": {
                "service_id": {"type": "string", "description": "The service ID to analyse"},
                "minutes": {"type": "number", "description": "Look-back window in minutes (default 60)"},
            },
            "required": ["service_id"],
        },
    },
    {
        "name": "get_latency_stats",
        "description": "Get p50, p95, p99 latency stats for a service broken down by operation.",
        "parameters": {
            "type": "object",
            "properties": {
                "service_id": {"type": "string", "description": "The service ID to query"},
                "minutes": {"type": "number", "description": "Look-back window in minutes (default 60)"},
            },
            "required": ["service_id"],
        },
    },
    {
        "name": "get_trace",
        "description": "Get the full span waterfall for a specific trace ID to understand exactly what happened in one request.",
        "parameters": {
            "type": "object",
            "properties": {
                "trace_id": {"type": "string", "description": "The trace ID to retrieve"},
            },
            "required": ["trace_id"],
        },
    },
    {
        "name": "get_service_dependencies",
        "description": "Get the service dependency graph — which service calls which, with call counts and average duration.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "find_similar_past_incidents",
        "description": (
            "Search past incidents by MEANING, not exact text — useful when you suspect "
            "this anomaly resembles something seen before. Describe the symptom in plain "
            "words (e.g. 'checkout endpoint timing out under load') and get back past "
            "incidents whose root cause might explain this one too."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "A plain-language description of the current symptom",
                },
            },
            "required": ["query"],
        },
    },
]


def _jsonable(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Tool results travel inside LLM messages, which only carry plain JSON.
    Postgres rows contain datetimes/Decimals — round-trip through json with
    default=str turns everything into JSON-safe values."""
    return json.loads(json.dumps(rows, default=str))


async def execute_tool(name: str, args: dict[str, Any]) -> Any:
    if name == "get_recent_spans":
        status_clause = "AND status = 'error'" if args.get("status_filter") == "error" else ""
        return _jsonable(await query(
            f"""SELECT span_id, trace_id, operation, duration, status, metadata, created_at
                FROM spans
                WHERE service_id = $1 {status_clause}
                ORDER BY created_at DESC
                LIMIT $2""",
            args["service_id"], int(args.get("limit", 50)),
        ))

    if name == "get_error_summary":
        return _jsonable(await query(
            """SELECT operation,
                      COUNT(*)      AS error_count,
                      MIN(duration) AS min_duration,
                      MAX(duration) AS max_duration
               FROM spans
               WHERE service_id = $1
                 AND status = 'error'
                 AND created_at > NOW() - ($2 || ' minutes')::INTERVAL
               GROUP BY operation
               ORDER BY error_count DESC""",
            args["service_id"], str(int(args.get("minutes", 60))),
        ))

    if name == "get_latency_stats":
        return _jsonable(await query(
            """SELECT operation,
                      COUNT(*) AS call_count,
                      ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY duration))::int AS p50_ms,
                      ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration))::int AS p95_ms,
                      ROUND(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration))::int AS p99_ms
               FROM spans
               WHERE service_id = $1
                 AND created_at > NOW() - ($2 || ' minutes')::INTERVAL
                 AND duration IS NOT NULL
               GROUP BY operation
               ORDER BY p95_ms DESC NULLS LAST""",
            args["service_id"], str(int(args.get("minutes", 60))),
        ))

    if name == "get_trace":
        return _jsonable(await query(
            """SELECT span_id, parent_span_id, service_id, operation,
                      start_time, duration, status, metadata
               FROM spans WHERE trace_id = $1 ORDER BY start_time ASC""",
            args["trace_id"],
        ))

    if name == "get_service_dependencies":
        return _jsonable(await query(
            """SELECT from_service_id, to_service_id, call_count, avg_duration_ms
               FROM service_edges ORDER BY call_count DESC""",
        ))

    if name == "find_similar_past_incidents":
        # embed the model's own description of the symptom, then ask Qdrant
        # for whichever past incidents point in a similar direction
        vector = await embed_text(args["query"])
        matches = await search_similar(vector, limit=3)
        if not matches:
            return {"message": "No similar past incidents found."}
        return matches

    raise ValueError(f"Unknown tool: {name}")
