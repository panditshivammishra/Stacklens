"""
─────────────────────────────────────────────────────────────────────────────
Pydantic models — the Python port of the Zod schemas in routes/ingest.ts

CONCEPT: Pydantic = Zod for Python
  A model class declares the shape of incoming JSON. FastAPI validates every
  request against it automatically and rejects bad payloads with a 422 —
  the same job Zod's safeParse did by hand in the Node route.

CONCEPT: Aliases
  The SDK sends camelCase JSON ("traceId") because it's JavaScript.
  Python style is snake_case (trace_id). Field(alias=...) maps between them:
  the wire format stays camelCase, the Python code reads snake_case.
─────────────────────────────────────────────────────────────────────────────
"""
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class Span(BaseModel):
    # populate_by_name lets code construct Spans with either name;
    # incoming JSON uses the camelCase aliases.
    model_config = ConfigDict(populate_by_name=True)

    trace_id: str = Field(alias="traceId", min_length=1)
    span_id: str = Field(alias="spanId", min_length=1)
    parent_span_id: str | None = Field(alias="parentSpanId", default=None)
    service_id: str = Field(alias="serviceId", min_length=1)
    operation: str = Field(min_length=1)
    start_time: float = Field(alias="startTime")
    duration: float | None = None
    status: Literal["ok", "error"]           # same as z.enum(['ok','error'])
    metadata: dict[str, Any] | None = None


class IngestBody(BaseModel):
    spans: list[Span] = Field(min_length=1, max_length=500)
