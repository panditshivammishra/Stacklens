"""
─────────────────────────────────────────────────────────────────────────────
Stacklens backend — FastAPI port. Entry point.

Node equivalent: backend/src/index.ts
  const app = Fastify()      →  app = FastAPI()
  app.register(cors)         →  app.add_middleware(CORSMiddleware)
  app.register(ingestRoutes) →  app.include_router(ingest.router)
  app.get('/health')         →  @app.get('/health')
  app.listen({ port })       →  uvicorn app.main:app --port 4001
  startSpanWorker().catch()  →  asyncio.create_task(span_worker())

Run (from backend-py/):
  .venv\\Scripts\\uvicorn app.main:app --reload --port 4001
─────────────────────────────────────────────────────────────────────────────
"""
import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import config
from app.agent.detector import anomaly_detector
from app.agent.vectorstore import ensure_collection
from app.db.postgres import close_db, init_db
from app.db.redis_client import redis
from app.routes import admin, auth, ingest, query, sse
from app.workers.span_worker import service_edge_builder, span_worker


# ─────────────────────────────────────────────────────────────────────────────
# CONCEPT: Lifespan — FastAPI's startup/shutdown hook
# Everything BEFORE `yield` runs once at startup (Node's start() sequence);
# everything AFTER it runs once at shutdown — where we cancel the worker task
# and close connections cleanly (the Node version never had a shutdown path).
# ─────────────────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()                                # Postgres pool + schema.sql
    await redis.ping()                             # fail fast if Redis is down
    await ensure_collection()                       # Qdrant collection for RAG (idempotent)
    worker = asyncio.create_task(span_worker())    # background consumer loop
    detector = asyncio.create_task(anomaly_detector())  # 60s anomaly checks → AI agent
    edges = asyncio.create_task(service_edge_builder())  # 60s service-map rebuild
    print("Stacklens backend (Python) ready")

    yield                                          # ← the server runs here

    worker.cancel()                                # stop the consume loop
    detector.cancel()
    edges.cancel()
    await redis.aclose()
    await close_db()


app = FastAPI(title="Stacklens", lifespan=lifespan)

# ─────────────────────────────────────────────────────────────────────────────
# CORS, now that auth uses cookies
#
# The old setting was allow_origins=["*"], which browsers REFUSE to combine with
# credentials: with allow_credentials=True a wildcard origin is rejected outright
# and every cookie-bearing request fails. That is not a quirk to work around —
# it is the browser preventing any site on the internet from making authenticated
# calls to this API using a logged-in user's cookie.
#
# So we name the one origin we trust. allow_credentials=True is what permits the
# browser to attach the session cookie cross-origin (dashboard :3000 → API :4001).
# ─────────────────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=[config.DASHBOARD_ORIGIN],
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "x-api-key"],
)

# include_router = Fastify's app.register(xRoutes)
app.include_router(auth.router)     # /auth/signup, /login, /logout, /me
app.include_router(admin.router)    # /api/services (create), /api/keys
app.include_router(ingest.router)   # /ingest — API-key protected
app.include_router(query.router)    # /api/* reads — cookie protected, org-scoped
app.include_router(sse.router)      # /api/sse — cookie protected, org-filtered


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
