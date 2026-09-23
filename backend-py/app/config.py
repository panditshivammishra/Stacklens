"""
─────────────────────────────────────────────────────────────────────────────
CONCEPT: One config module, loaded once

Node version: index.ts ran dotenv.config({ path: ../../.env }) FIRST, and the
lazy-Pool trick in postgres.ts existed only to dodge the import-order problem
(imports run before dotenv, so process.env was empty at import time).

Python has the same hazard: `import` runs a module's top-level code
immediately. The fix is the same idea, made explicit — this module calls
load_dotenv() at the very top, and every other module reads settings from
here instead of touching os.environ directly. Import config → env is loaded.
─────────────────────────────────────────────────────────────────────────────
"""
import os
from pathlib import Path

from dotenv import load_dotenv

# The shared .env lives at the monorepo root, two levels up from this file
# (backend-py/app/config.py → backend-py → stacklens/.env).
# Same path hop the Node backend does with path.resolve(__dirname, '../../.env').
ROOT_ENV = Path(__file__).resolve().parent.parent.parent / ".env"
load_dotenv(ROOT_ENV)

DATABASE_URL = os.getenv("DATABASE_URL", "")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
QDRANT_URL = os.getenv("QDRANT_URL", "http://localhost:6333")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

# Multi-LLM agent: comma-separated failover chain of provider:model entries.
# Free default is Gemini flash; add "openai:<model>" entries for OpenAI, or
# point OPENAI_BASE_URL at Groq/Ollama for other free options (see providers.py).
AGENT_MODELS = os.getenv("AGENT_MODELS", "gemini:gemini-2.5-flash")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL") or None

# 4001 while the Node backend still owns 4000 — lets both run side by side
# during the migration. Flip to 4000 when the port is retired from Node.
PORT = int(os.getenv("PY_PORT", "4001"))

# ─────────────────────────────────────────────────────────────────────────────
# AUTH
#
# JWT_SECRET signs the login cookie. Anyone holding it can mint a token for any
# user, so it must come from the environment in production — the fallback below
# exists only so a fresh clone boots for local development.
# ─────────────────────────────────────────────────────────────────────────────
JWT_SECRET = os.getenv("JWT_SECRET", "dev-only-insecure-secret-change-me")
JWT_ALGORITHM = "HS256"
JWT_TTL_HOURS = int(os.getenv("JWT_TTL_HOURS", "168"))   # 7 days

# The dashboard's origin. Cookies are forbidden with a wildcard CORS origin
# (allow_credentials + "*" is rejected by every browser), so once auth is on we
# must name the exact origin we trust.
DASHBOARD_ORIGIN = os.getenv("DASHBOARD_ORIGIN", "http://localhost:3000")

COOKIE_NAME = "stacklens_session"
# Secure=true requires HTTPS, which local dev doesn't have. Off by default,
# on in production via env.
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false").lower() == "true"

# Raw API keys are shown once, at creation, then only their hash is stored.
API_KEY_PREFIX_LEN = 12                       # the visible "sl_live_ab12cd34" part
