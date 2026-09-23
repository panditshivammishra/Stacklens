"""
─────────────────────────────────────────────────────────────────────────────
/auth routes — signup, login, logout, me.

THE OWNERSHIP CHAIN this creates and then enforces everywhere else:

    user ──belongs to──► org ──owns──► services ──produce──► spans

Signing up creates BOTH an org and its first user, because a user with no org
could not own anything and every later query filters by org_id.

CONCEPT: why the token goes in a cookie the server sets, not in the JSON body
  If we returned the token as JSON, the dashboard would have to store it
  (localStorage) and attach it by hand — readable by any injected script, and
  impossible to send from EventSource. Instead the server sets an httpOnly
  cookie: the browser stores it out of JavaScript's reach and attaches it to
  every subsequent request automatically, SSE included.
─────────────────────────────────────────────────────────────────────────────
"""
from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, EmailStr, Field

from app import config
from app.auth.crypto import (
    create_session_token,
    hash_password,
    new_id,
    verify_password,
)
from app.auth.deps import CurrentUser, require_user
from app.db.postgres import execute, query

router = APIRouter(prefix="/auth", tags=["auth"])


# ── Request shapes ───────────────────────────────────────────────────────────
# Pydantic does the validating, so the route body never sees a malformed email
# or a 3-character password. EmailStr rejects "not-an-email" with a 422.
class SignupBody(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=72)   # 72 = bcrypt's byte limit
    org_name: str = Field(min_length=1, max_length=80)


class LoginBody(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=72)


def _set_session_cookie(response: Response, token: str) -> None:
    """One place that decides every cookie flag — easy to audit, easy to change."""
    response.set_cookie(
        key=config.COOKIE_NAME,
        value=token,
        httponly=True,               # JavaScript cannot read it → XSS cannot steal it
        secure=config.COOKIE_SECURE, # HTTPS-only in production
        samesite="lax",              # not sent on cross-site POSTs → blocks basic CSRF
        max_age=config.JWT_TTL_HOURS * 3600,
        path="/",
    )


@router.post("/signup", status_code=status.HTTP_201_CREATED)
async def signup(body: SignupBody, response: Response) -> dict[str, str]:
    existing = await query("SELECT id FROM users WHERE email = $1", body.email)
    if existing:
        # Deliberately vague: confirming which emails are registered hands an
        # attacker a list of valid accounts to go after.
        raise HTTPException(status.HTTP_409_CONFLICT, "Could not create account")

    org_id = new_id()
    user_id = new_id()

    await execute("INSERT INTO orgs (id, name) VALUES ($1, $2)", org_id, body.org_name)
    await execute(
        """INSERT INTO users (id, org_id, email, password_hash, role)
           VALUES ($1, $2, $3, $4, 'owner')""",
        user_id,
        org_id,
        body.email,
        hash_password(body.password),      # the raw password is never stored, ever
    )

    _set_session_cookie(response, create_session_token(user_id, org_id))
    return {"id": user_id, "email": body.email, "org_id": org_id, "role": "owner"}


@router.post("/login")
async def login(body: LoginBody, response: Response) -> dict[str, str]:
    rows = await query(
        "SELECT id, org_id, email, password_hash, role FROM users WHERE email = $1",
        body.email,
    )

    # Same error and (roughly) the same work for "no such user" and "wrong
    # password". Answering "no such account" faster than "wrong password" would
    # let someone enumerate valid emails by timing alone.
    if not rows or not verify_password(body.password, rows[0]["password_hash"]):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")

    user = rows[0]
    _set_session_cookie(response, create_session_token(user["id"], user["org_id"]))
    return {
        "id": user["id"],
        "email": user["email"],
        "org_id": user["org_id"],
        "role": user["role"],
    }


@router.post("/logout")
async def logout(response: Response) -> dict[str, bool]:
    # A JWT cannot be un-issued (nothing about it is stored server-side), so
    # "logging out" means deleting the browser's copy. The token technically
    # stays valid until it expires — the accepted trade for stateless sessions.
    # Short TTLs and a revocation list are how you tighten this if you need to.
    response.delete_cookie(config.COOKIE_NAME, path="/")
    return {"ok": True}


@router.get("/me")
async def me(user: CurrentUser = Depends(require_user)) -> dict[str, str]:
    """Who am I? The dashboard calls this on load to decide login vs app."""
    return {
        "id": user.id,
        "email": user.email,
        "org_id": user.org_id,
        "role": user.role,
    }
