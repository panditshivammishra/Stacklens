"""
─────────────────────────────────────────────────────────────────────────────
Crypto helpers — passwords, session tokens, and API keys.

Everything here is about ONE rule: the server must be able to CHECK a secret
without being able to READ it back. That is why nothing in this file has a
"decrypt" counterpart — we store one-way hashes and compare hashes.

Three separate secrets live in this system, and they are deliberately handled
by three different mechanisms:

  1. PASSWORD    → bcrypt hash in users.password_hash
                   (slow on purpose, so stolen hashes resist brute force)
  2. SESSION     → a signed JWT in an httpOnly cookie
                   (not stored server-side at all — the signature IS the proof)
  3. API KEY     → sha256 hash in api_keys.key_hash
                   (fast on purpose, because it is checked on every ingest call)
─────────────────────────────────────────────────────────────────────────────
"""
import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import bcrypt
import jwt

from app import config


# ─────────────────────────────────────────────────────────────────────────────
# 1. PASSWORDS
#
# CONCEPT: a hash is a one-way function. "hunter2" always turns into the same
# long string, but that string cannot be turned back into "hunter2". So a
# database leak does not hand the attacker anyone's password.
#
# CONCEPT: salt. bcrypt mixes a random value (the salt) into every hash, so two
# users with the SAME password get DIFFERENT hashes. Without a salt, an attacker
# could hash "123456" once and instantly spot every account using it. The salt
# is not a secret — bcrypt stores it inside the hash string itself, which is why
# checkpw() needs only the hash to do its job.
#
# CONCEPT: why bcrypt and not sha256 here. sha256 is fast — a GPU can try
# billions per second, which is exactly what an attacker wants. bcrypt is
# deliberately slow (it repeats its work 2^rounds times), turning billions of
# guesses per second into thousands. Slowness is the security feature.
# ─────────────────────────────────────────────────────────────────────────────
def hash_password(plain: str) -> str:
    # bcrypt works on bytes, and silently truncates past 72 bytes — encode first
    # so a long unicode password fails loudly at validation instead of quietly here.
    salt = bcrypt.gensalt()
    return bcrypt.hashpw(plain.encode("utf-8"), salt).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    """Re-hash the attempt with the stored salt and compare. Never decrypts."""
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except ValueError:
        # malformed hash in the DB — treat as a failed login, never a 500
        return False


# ─────────────────────────────────────────────────────────────────────────────
# 2. SESSION TOKENS (JWT)
#
# CONCEPT: a JWT is three base64 parts joined by dots —
#     header.payload.signature
# The payload is NOT encrypted; anyone can read it (paste one into jwt.io). The
# security comes from the signature: it is computed from the payload plus our
# JWT_SECRET. Change one character of the payload and the signature no longer
# matches, so the server rejects it. You cannot forge a valid signature without
# the secret.
#
# CONCEPT: why we store no sessions in the database. The signature proves the
# token is ours, and `exp` proves it is still fresh, so verifying a request
# needs zero database work. The tradeoff is that a JWT cannot be un-issued —
# it stays valid until it expires. That is an acceptable trade for a dashboard
# session; it is NOT acceptable for API keys, which is why those live in the
# database where they can be revoked instantly.
#
# CONCEPT: never put secrets in the payload — only identifiers. Anyone holding
# the token can read every field in it.
# ─────────────────────────────────────────────────────────────────────────────
def create_session_token(user_id: str, org_id: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,                                        # "subject" — who this is
        "org": org_id,                                         # avoids a DB hit per request
        "iat": now,                                            # issued at
        "exp": now + timedelta(hours=config.JWT_TTL_HOURS),    # expiry — checked by decode()
    }
    return jwt.encode(payload, config.JWT_SECRET, algorithm=config.JWT_ALGORITHM)


def read_session_token(token: str) -> dict[str, Any] | None:
    """Verify signature + expiry. Returns the payload, or None if invalid."""
    try:
        # decode() does BOTH jobs: checks the signature against our secret AND
        # rejects an expired `exp`. A tampered or stale token raises here.
        return jwt.decode(
            token,
            config.JWT_SECRET,
            algorithms=[config.JWT_ALGORITHM],   # a list, and never "none" —
        )                                        # accepting alg:none is a classic JWT hole
    except jwt.PyJWTError:
        return None


# ─────────────────────────────────────────────────────────────────────────────
# 3. API KEYS
#
# The key we hand out looks like:  sl_live_9f2c1a7b4e6d8c0a3b5f7d9e1c2a4b6d
#                                  └─ prefix ─┘└──────── secret ──────────┘
#
# CONCEPT: why store a prefix AND a hash.
#   We cannot look a key up by its hash cheaply if we also want to salt it, and
#   we cannot store the raw key at all. So: the first 12 characters are stored
#   in plain text and indexed. On each request we find candidate rows by prefix
#   (fast, indexed), then verify the FULL key against the stored hash. The
#   prefix alone is useless to an attacker — it is also what the UI displays so
#   a user can tell their keys apart.
#
# CONCEPT: why sha256 here instead of bcrypt.
#   This check runs on EVERY ingest request — bcrypt's deliberate slowness would
#   become the bottleneck of the hot path. bcrypt is needed for passwords
#   because humans pick guessable ones ("password123"). An API key is 32 random
#   hex characters from a cryptographic generator — there is nothing to guess,
#   so a fast hash is safe here.
#
# CONCEPT: secrets.token_hex, not random.random().
#   random is a predictable pseudo-random generator seeded from the clock —
#   given a few outputs you can predict the rest. secrets draws from the OS
#   entropy pool and is designed for exactly this job.
# ─────────────────────────────────────────────────────────────────────────────
def generate_api_key() -> tuple[str, str, str]:
    """
    Returns (raw_key, prefix, key_hash).

    raw_key is shown to the user EXACTLY ONCE and never stored. If they lose it,
    they revoke it and create a new one — that is the correct, standard flow
    (GitHub, Stripe and AWS all behave this way).
    """
    raw_key = f"sl_live_{secrets.token_hex(16)}"      # 32 hex chars of real entropy
    prefix = raw_key[: config.API_KEY_PREFIX_LEN]
    return raw_key, prefix, hash_api_key(raw_key)


def hash_api_key(raw_key: str) -> str:
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()


def verify_api_key(raw_key: str, stored_hash: str) -> bool:
    # compare_digest instead of `==`: a normal string comparison exits at the
    # first differing character, so its RUNTIME leaks how much of the guess was
    # correct. An attacker can measure that and rebuild the secret one character
    # at a time (a timing attack). compare_digest always takes the same time.
    return secrets.compare_digest(hash_api_key(raw_key), stored_hash)


def new_id() -> str:
    """Random primary key for orgs/users/api_keys (Postgres has no uuid default here)."""
    return str(uuid.uuid4())
