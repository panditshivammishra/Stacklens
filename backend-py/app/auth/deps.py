"""
─────────────────────────────────────────────────────────────────────────────
Auth dependencies — the guards that answer "who is calling?"

CONCEPT: FastAPI's Depends() — the piece with no Node equivalent
  In Fastify you write a preHandler hook and remember to attach it to every
  protected route. Here you declare the requirement in the function signature:

      async def incidents(user: CurrentUser = Depends(require_user)):

  FastAPI sees the Depends(), runs require_user() BEFORE the route body, and
  passes whatever it returns in as `user`. If require_user raises 401, the route
  body never executes at all.

  Two things this buys over a hook:
    - it is impossible to "forget to attach" — the route cannot receive a user
      without declaring the dependency that produces one
    - the route body is typed: `user.org_id` is a real, checked attribute

  Two guards live here because this system has two kinds of caller:

      require_user     — a HUMAN, logged into the dashboard (session cookie)
      require_api_key  — a MACHINE, an SDK shipping spans (x-api-key header)

  They are deliberately separate. A dashboard cookie must never be able to
  write spans, and an SDK key must never be able to read another service's data.
─────────────────────────────────────────────────────────────────────────────
"""
from dataclasses import dataclass

from fastapi import Cookie, Header, HTTPException, status

from app import config
from app.auth.crypto import read_session_token, verify_api_key
from app.db.postgres import execute, query


@dataclass
class CurrentUser:
    """A logged-in human. org_id is what every read query gets filtered by."""
    id: str
    org_id: str
    email: str
    role: str


@dataclass
class ApiKeyIdentity:
    """A machine (SDK). service_id is the ONLY service it may write spans for."""
    key_id: str
    org_id: str
    service_id: str


# ─────────────────────────────────────────────────────────────────────────────
# HUMAN AUTH — session cookie
#
# CONCEPT: why the cookie and not an Authorization header.
#   The dashboard's live feed uses EventSource (SSE), and the browser's
#   EventSource API cannot set custom headers — there is no way to attach
#   "Authorization: Bearer ...". Cookies, however, are sent automatically on
#   every request including SSE. Choosing cookies is what makes an authenticated
#   live stream possible at all.
#
# CONCEPT: httpOnly.
#   The cookie is set with httpOnly=True, meaning JavaScript cannot read it
#   (document.cookie simply does not show it). If an attacker manages to inject
#   a script into the dashboard, they still cannot steal the session token.
#   A token kept in localStorage has no such protection.
# ─────────────────────────────────────────────────────────────────────────────
async def require_user(
    # Reading the cookie by name is all it takes — FastAPI pulls it off the
    # request. `None` default means "missing cookie" reaches us as None instead
    # of raising, so we can return a clean 401 rather than a 422.
    stacklens_session: str | None = Cookie(default=None),
) -> CurrentUser:
    if not stacklens_session:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not signed in")

    payload = read_session_token(stacklens_session)
    if not payload:
        # covers both "signature does not match" and "expired"
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session invalid or expired")

    # The token carries org_id, but we still re-read the user row. A token is a
    # snapshot of the moment it was issued: if the account was deleted or moved
    # orgs since, the token would happily keep asserting stale facts.
    rows = await query(
        "SELECT id, org_id, email, role FROM users WHERE id = $1",
        payload.get("sub"),
    )
    if not rows:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User no longer exists")

    r = rows[0]
    return CurrentUser(id=r["id"], org_id=r["org_id"], email=r["email"], role=r["role"])


# ─────────────────────────────────────────────────────────────────────────────
# MACHINE AUTH — API key header
#
# THE WHOLE POINT: this is what closes the "anyone can write spans as anyone"
# hole. Before this, /ingest believed whatever serviceId sat in the JSON body.
# Now the caller proves possession of a key, and the serviceId is read OFF THE
# KEY — the request body cannot influence it.
#
# The lookup is two-step on purpose (see crypto.py): find candidate rows by the
# indexed plaintext prefix, then verify the full key against the stored hash.
# ─────────────────────────────────────────────────────────────────────────────
async def require_api_key(
    # FastAPI maps the header name x-api-key onto this argument automatically
    # (underscores become dashes); alias spelled out for clarity.
    x_api_key: str | None = Header(default=None, alias="x-api-key"),
) -> ApiKeyIdentity:
    if not x_api_key:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Missing x-api-key header — create a key in the dashboard and set "
            "apiKey in your SDK config",
        )

    prefix = x_api_key[: config.API_KEY_PREFIX_LEN]
    rows = await query(
        """SELECT id, org_id, service_id, key_hash
             FROM api_keys
            WHERE key_prefix = $1
              AND revoked_at IS NULL""",     # revoked keys are kept for audit, not accepted
        prefix,
    )

    for row in rows:
        if verify_api_key(x_api_key, row["key_hash"]):
            # Fire-and-forget freshness stamp for the "last used 3h ago" UI.
            # Awaited (not a task) so it cannot outlive the request, but a
            # failure here must never reject a valid ingest.
            try:
                await execute(
                    "UPDATE api_keys SET last_used_at = NOW() WHERE id = $1", row["id"]
                )
            except Exception:  # noqa: BLE001
                pass
            return ApiKeyIdentity(
                key_id=row["id"], org_id=row["org_id"], service_id=row["service_id"]
            )

    # Same message whether the prefix was unknown or the hash did not match —
    # never tell an attacker which half of their guess was right.
    raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid API key")
