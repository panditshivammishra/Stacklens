"""
─────────────────────────────────────────────────────────────────────────────
Redis client — the Python port of backend/src/db/redis.ts

redis-py's asyncio flavor plays the role ioredis played in Node.
decode_responses=True makes Redis hand back normal Python strings instead of
raw bytes (b"...") — one less thing to convert everywhere.

Like ioredis with lazyConnect, this client doesn't dial Redis until the
first command runs; main.py pings it at startup to fail fast if Redis is down.
─────────────────────────────────────────────────────────────────────────────
"""
import redis.asyncio as aioredis

from app import config

redis = aioredis.from_url(config.REDIS_URL, decode_responses=True)
