"""
─────────────────────────────────────────────────────────────────────────────
Service + API-key management — the "explicit registration" that replaces the
old zero-config trust model.

BEFORE (the honest gap this closes):
  A service "registered" itself by simply sending a span with any serviceId it
  liked. Nothing verified the claim, so anyone who could reach /ingest could
  write spans as "payment-service" — and two unrelated teams that both picked
  the name "api" silently merged into one service.

NOW:
  1. A logged-in user creates a service under THEIR org  → POST /api/services
  2. The server returns an API key, shown exactly once
  3. The SDK sends that key on every ingest; the serviceId comes off the key

Note what this also fixes: services are now unique PER ORG. Two different
companies can each have a service called "api" without colliding, because the
row id is namespaced by org (see service_row_id).
─────────────────────────────────────────────────────────────────────────────
"""
import re

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.auth.crypto import generate_api_key, new_id
from app.auth.deps import CurrentUser, require_user
from app.db.postgres import execute, query

router = APIRouter(prefix="/api", tags=["admin"])

# A service name a human types. Kept strict so it stays readable in a URL,
# a graph label, and a log line.
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,48}[a-z0-9]$")


class CreateServiceBody(BaseModel):
    name: str = Field(min_length=2, max_length=50)


def service_row_id(org_id: str, name: str) -> str:
    """
    The services table has a single TEXT primary key, and spans reference it by
    that id. Namespacing the id with the org keeps two orgs' identically-named
    services apart without a schema migration:

        org 7f3a… + "api"  →  "7f3a…:api"
        org b91c… + "api"  →  "b91c…:api"

    The SDK never types this — it is derived from the API key on every request,
    so the ugly prefix stays entirely server-side. Public (no leading
    underscore) because bootstrap.py needs the identical scheme — imported
    from there rather than re-derived, so the two can never drift apart.
    """
    return f"{org_id}:{name}"


async def issue_key(org_id: str, service_id: str) -> str:
    """Generate + store a key for an existing service row. Returns the raw key —
    the only copy that will ever exist outside the hash. Shared by create_service
    (first key), create_key (rotation), and bootstrap.py's first-run setup, so
    the insert can't drift between any of them."""
    raw_key, prefix, key_hash = generate_api_key()
    await execute(
        """INSERT INTO api_keys (id, org_id, service_id, key_prefix, key_hash)
           VALUES ($1, $2, $3, $4, $5)""",
        new_id(),
        org_id,
        service_id,
        prefix,
        key_hash,
    )
    return raw_key


@router.post("/services", status_code=status.HTTP_201_CREATED)
async def create_service(
    body: CreateServiceBody,
    user: CurrentUser = Depends(require_user),
) -> dict[str, str]:
    """Create a service under my org and issue its first API key."""
    if not NAME_RE.match(body.name):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Name must be lowercase letters, digits, dot, dash or underscore "
            "(e.g. payment-service)",
        )

    service_id = service_row_id(user.org_id, body.name)

    existing = await query("SELECT id FROM services WHERE id = $1", service_id)
    if existing:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"Service '{body.name}' already exists in this org"
        )

    await execute(
        """INSERT INTO services (id, name, org_id, first_seen, last_seen)
           VALUES ($1, $2, $3, NOW(), NOW())""",
        service_id,
        body.name,
        user.org_id,
    )

    # THE ONLY TIME the raw key ever leaves this server. We stored just its
    # hash, so even we cannot show it again — lose it and you rotate it.
    raw_key = await issue_key(user.org_id, service_id)

    return {
        "service_id": service_id,
        "name": body.name,
        "api_key": raw_key,
        "warning": "Copy this key now — it will never be shown again.",
    }


@router.get("/services/manage")
async def list_my_services(
    user: CurrentUser = Depends(require_user),
) -> list[dict]:
    """Services my org owns, with their key status. Powers the settings screen."""
    return await query(
        """SELECT s.id,
                  s.name,
                  s.first_seen,
                  s.last_seen,
                  COUNT(k.id) FILTER (WHERE k.revoked_at IS NULL) AS active_keys
             FROM services s
             LEFT JOIN api_keys k ON k.service_id = s.id
            WHERE s.org_id = $1
            GROUP BY s.id, s.name, s.first_seen, s.last_seen
            ORDER BY s.name""",
        user.org_id,
    )


@router.get("/keys")
async def list_keys(user: CurrentUser = Depends(require_user)) -> list[dict]:
    """
    Never returns key material — only the prefix, which is enough for a human to
    recognise a key ("the one starting sl_live_9f2c") but useless to an attacker.
    """
    return await query(
        """SELECT id, service_id, key_prefix, created_at, last_used_at, revoked_at
             FROM api_keys
            WHERE org_id = $1
            ORDER BY created_at DESC""",
        user.org_id,
    )


@router.post("/keys", status_code=status.HTTP_201_CREATED)
async def create_key(
    body: CreateServiceBody,          # reuses {name}: the service to issue a key for
    user: CurrentUser = Depends(require_user),
) -> dict[str, str]:
    """Issue an ADDITIONAL key for an existing service — this is how you rotate.

    Rotation without downtime: create the new key, deploy it, then revoke the
    old one. Both work in the overlap, so no span is ever dropped.
    """
    service_id = service_row_id(user.org_id, body.name)

    # The org check is the important line here: without it, anyone could mint a
    # key for another org's service just by guessing the name.
    owned = await query(
        "SELECT id FROM services WHERE id = $1 AND org_id = $2", service_id, user.org_id
    )
    if not owned:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such service in your org")

    raw_key = await issue_key(user.org_id, service_id)
    return {"service_id": service_id, "api_key": raw_key,
            "warning": "Copy this key now — it will never be shown again."}


@router.delete("/keys/{key_id}")
async def revoke_key(
    key_id: str,
    user: CurrentUser = Depends(require_user),
) -> dict[str, bool]:
    """
    Soft delete: we stamp revoked_at instead of deleting the row.

    Why keep it? An incident review needs to answer "which key was writing this
    data, and when did we turn it off?" — a deleted row cannot answer that.
    require_api_key already filters on `revoked_at IS NULL`, so the key stops
    working the instant this runs.
    """
    rows = await query(
        """UPDATE api_keys
              SET revoked_at = NOW()
            WHERE id = $1
              AND org_id = $2            -- cannot revoke another org's key
              AND revoked_at IS NULL
        RETURNING id""",
        key_id,
        user.org_id,
    )
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Key not found or already revoked")
    return {"revoked": True}
