"""
─────────────────────────────────────────────────────────────────────────────
Postgres layer — the Python port of backend/src/db/postgres.ts

CONCEPT: Connection pool (same idea as pg.Pool)
  Opening a database connection is slow (network handshake + login).
  A pool opens a handful of connections ONCE and lends them out per query.
  asyncpg.create_pool() is the Python twin of Node's `new Pool()`.

CONCEPT: Parameterized queries
  asyncpg uses $1, $2 placeholders — exactly like node-pg. User input is sent
  separately from the SQL text, so it can never become SQL (no injection).
─────────────────────────────────────────────────────────────────────────────
"""
from pathlib import Path
from typing import Any

import asyncpg

from app import config

# The module-level pool, created once at startup by init_db() — the same
# "lazy init" shape as the Node version, except Python's config module makes
# the dotenv-timing bug impossible (env is loaded the moment config imports).
_pool: asyncpg.Pool | None = None


async def init_db() -> None:
    """Create the pool and apply schema.sql (idempotent CREATE IF NOT EXISTS)."""
    global _pool
    _pool = await asyncpg.create_pool(
        dsn=config.DATABASE_URL,
        min_size=1,
        max_size=20,           # same cap as the Node pool
        command_timeout=5,
    )
    schema = (Path(__file__).parent / "schema.sql").read_text(encoding="utf-8")
    async with _pool.acquire() as conn:
        await conn.execute(schema)


def get_pool() -> asyncpg.Pool:
    """Hand back the pool — with a clear error if startup never ran."""
    if _pool is None:
        raise RuntimeError("DB not initialized — init_db() must run at startup")
    return _pool


async def query(sql: str, *params: Any) -> list[dict[str, Any]]:
    """
    Every DB read/write in the backend goes through this one function
    (twin of the Node `query()` wrapper).

    asyncpg returns Record objects; we convert each to a plain dict so
    FastAPI can serialize results straight to JSON.
    """
    rows = await get_pool().fetch(sql, *params)
    return [dict(r) for r in rows]


async def execute(sql: str, *params: Any) -> str:
    """For INSERT/UPDATE where we don't need rows back."""
    return await get_pool().execute(sql, *params)


async def close_db() -> None:
    """Shutdown hook — return all connections cleanly."""
    if _pool is not None:
        await _pool.close()
