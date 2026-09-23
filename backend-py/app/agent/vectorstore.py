"""
─────────────────────────────────────────────────────────────────────────────
Qdrant wrapper — the "storage + search" half of RAG.

CONCEPT: Qdrant is a vector database
  Postgres is built to answer "find rows WHERE column = value" fast (via
  B-tree indexes). It's the wrong tool for "find rows whose 3072-number vector
  points in roughly the same direction as this other vector" — that needs an
  index built for high-dimensional nearest-neighbour search. That's the one
  job Qdrant does: store (vector, payload) pairs, answer "give me the K
  closest vectors to this one."

CONCEPT: cosine similarity (Distance.COSINE below)
  Two vectors are compared by the ANGLE between them, not their length. This
  is the standard choice for text embeddings, because the model's job was to
  make "similar meaning" point the same direction — length isn't meaningful
  here the way it would be for, say, comparing physical coordinates.

WHY THIS IS A THIN WRAPPER, LIKE app/db/postgres.py
  Same shape as the Postgres module: one client, created once, three plain
  functions (ensure_collection / upsert_incident / search_similar). No class,
  no ORM — the rest of the codebase already established that pattern for the
  other database, so this follows it rather than inventing a new shape.
─────────────────────────────────────────────────────────────────────────────
"""
from typing import Any

from qdrant_client import AsyncQdrantClient, models

from app import config
from app.agent.embeddings import EMBEDDING_DIM

COLLECTION = "incidents"

_client: AsyncQdrantClient | None = None


def get_client() -> AsyncQdrantClient:
    global _client
    if _client is None:
        _client = AsyncQdrantClient(url=config.QDRANT_URL)
    return _client


async def ensure_collection() -> None:
    """Create the collection on first boot. Safe to call every startup —
    same idempotent-on-every-run idea as schema.sql's CREATE TABLE IF NOT EXISTS."""
    if EMBEDDING_DIM == 0:
        print("[RAG] No embedding provider configured — skipping Qdrant setup")
        return

    client = get_client()
    if not await client.collection_exists(COLLECTION):
        await client.create_collection(
            COLLECTION,
            vectors_config=models.VectorParams(size=EMBEDDING_DIM, distance=models.Distance.COSINE),
        )
        print(f"[RAG] Created Qdrant collection '{COLLECTION}' (dim={EMBEDDING_DIM})")


async def upsert_incident(incident_id: str, vector: list[float], payload: dict[str, Any]) -> None:
    """
    Store one incident's embedding + the human-readable fields we want back
    later (service, type, root cause) so a search result is immediately useful
    without a second Postgres lookup.

    incident_id doubles as the Qdrant point id — it's already a UUID string
    (from runner.py's `str(uuid.uuid4())`), which is one of the two id formats
    Qdrant accepts, so no separate id scheme is needed.
    """
    await get_client().upsert(
        COLLECTION,
        points=[models.PointStruct(id=incident_id, vector=vector, payload=payload)],
    )


async def search_similar(vector: list[float], limit: int = 3) -> list[dict[str, Any]]:
    """
    K-nearest-neighbour search: the `limit` closest past incidents by meaning.

    Uses the older `.search()` call rather than `.query_points()`: this repo's
    docker-compose.yml pins Qdrant server v1.9.2, and `query_points` needs the
    Query API added in server v1.10 — calling it against an older server 404s.
    `.search()` maps to the long-stable `/points/search` endpoint instead.
    """
    points = await get_client().search(COLLECTION, query_vector=vector, limit=limit)
    return [{"score": point.score, **(point.payload or {})} for point in points]
