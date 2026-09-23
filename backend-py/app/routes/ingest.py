"""
─────────────────────────────────────────────────────────────────────────────
POST /ingest — the SDK's write path, now authenticated.

The SDK batches spans and POSTs them here. We do NOT write to Postgres in
this request (too slow under load) — we push onto a Redis Stream and return
in ~1ms. The background worker drains the stream into Postgres.

CONCEPT: APIRouter = a Fastify route-group
  In Node: export function ingestRoutes(app) { app.post(...) } + app.register().
  In Python: a router object collects routes; main.py include_router()s it.

CONCEPT: FastAPI validation happens in the signature
  `body: IngestBody` tells FastAPI to parse + validate the JSON body against
  the Pydantic model BEFORE our function runs. Invalid payload → automatic
  422 response with field-level errors (the manual safeParse in Node).

─────────────────────────────────────────────────────────────────────────────
THE SECURITY FIX — serviceId now comes from the KEY, never from the BODY
─────────────────────────────────────────────────────────────────────────────
Before, this route trusted `span.serviceId` straight out of the JSON. Anyone
who could reach the port could write spans as any service — poisoning another
team's dashboard, faking a healthy service, or burying a real incident under
noise. There was no way to even detect it after the fact.

Now the caller must present an API key, and that key is scoped to exactly ONE
service. We take the service id off the key and STAMP it onto every span in the
batch, overwriting whatever the payload claimed. The body simply has no say in
the matter any more.

That single move also fixes the name-collision problem: the key resolves to
"<org_id>:<name>", so two orgs can both run a service called "api" and their
spans can never mix.
─────────────────────────────────────────────────────────────────────────────
"""
from fastapi import APIRouter, Depends

from app.auth.deps import ApiKeyIdentity, require_api_key
from app.db.redis_client import redis
from app.models import IngestBody

router = APIRouter()

STREAM_KEY = "spans:stream"


@router.post("/ingest", status_code=202)
async def ingest(
    body: IngestBody,
    # Depends() runs require_api_key BEFORE this function body. A missing or
    # bad key raises 401 there and we are never reached — the route cannot
    # accidentally run unauthenticated, because `identity` has no other source.
    identity: ApiKeyIdentity = Depends(require_api_key),
) -> dict[str, int]:
    # One pipeline = all XADDs travel to Redis in a single round-trip,
    # same as ioredis' pipeline() in the Node version.
    pipe = redis.pipeline()

    for span in body.spans:
        # THE STAMP. Whatever serviceId the SDK sent is discarded here and
        # replaced with the one the key is scoped to. This is the line that
        # makes spoofing impossible rather than merely discouraged.
        span.service_id = identity.service_id

        pipe.xadd(
            STREAM_KEY,
            # by_alias=True → keep camelCase on the wire so the worker,
            # broadcast payloads, and the Node backend all read the same JSON.
            {"data": span.model_dump_json(by_alias=True)},
            maxlen=10000,        # cap stream size…
            approximate=True,    # …the '~' in MAXLEN ~ 10000
        )

    await pipe.execute()

    return {"accepted": len(body.spans)}
