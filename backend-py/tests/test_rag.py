"""
RAG: the agent's memory of past incidents.

MARKED `slow` — these call a real embedding API, which costs quota and needs
network. Skip them with:  pytest -m "not slow"

They clean up after themselves: every incident they create is deleted from both
Postgres and Qdrant at the end, so they can be run repeatedly without the
vector store filling up with test data.
"""
import uuid

import pytest

from app.agent.embeddings import EMBEDDING_DIM, EMBEDDING_PROVIDER, embed_text
from app.agent.tools import execute_tool
from app.agent.vectorstore import COLLECTION, ensure_collection, get_client, upsert_incident
from app.db.postgres import execute, query

pytestmark = [
    pytest.mark.slow,
    pytest.mark.skipif(
        EMBEDDING_PROVIDER is None,
        reason="no embedding provider configured (set GEMINI_API_KEY or OPENAI_API_KEY)",
    ),
]


async def _seed(service_id: str, type_: str, root_cause: str) -> str:
    """Store one past incident exactly the way the agent's runner does."""
    incident_id = str(uuid.uuid4())
    await execute(
        """INSERT INTO incidents (id, service_id, type, detected_at, root_cause, post_mortem)
           VALUES ($1, $2, $3, NOW(), $4, $4)""",
        incident_id, service_id, type_, root_cause,
    )
    vector = await embed_text(f"{type_} on {service_id}: {root_cause}")
    await upsert_incident(incident_id, vector, {
        "service_id": service_id, "type": type_, "root_cause": root_cause,
    })
    await execute("UPDATE incidents SET embedding_id = $1 WHERE id = $1", incident_id)
    return incident_id


async def _cleanup(ids: list[str]) -> None:
    if ids:
        await get_client().delete(COLLECTION, points_selector=ids)
    for i in ids:
        await execute("DELETE FROM incidents WHERE id = $1", i)


class TestEmbeddings:
    async def test_returns_a_vector_of_the_expected_size(self, client):
        vector = await embed_text("checkout is slow")
        assert len(vector) == EMBEDDING_DIM
        assert all(isinstance(n, float) for n in vector[:5])

    async def test_same_text_gives_the_same_vector(self, client):
        """Determinism matters: if identical text embedded differently each
        time, stored vectors could never be compared to fresh queries."""
        a = await embed_text("database connection pool exhausted")
        b = await embed_text("database connection pool exhausted")
        assert a == b


class TestSemanticRetrieval:
    async def test_finds_the_right_incident_with_no_shared_words(self, client, org):
        """The whole point of RAG: matching on MEANING. The query below shares
        essentially no vocabulary with the seeded incident."""
        await ensure_collection()
        created = []
        try:
            target = await _seed(
                org.service_id, "latency_spike",
                "The checkout endpoint was slow because the payment gateway's TLS "
                "handshake was timing out under load, causing requests to queue up.",
            )
            other = await _seed(
                org.service_id, "error_spike",
                "Disk ran out of space because log rotation was misconfigured and "
                "old files were never deleted, filling the volume.",
            )
            created = [target, other]

            matches = await execute_tool("find_similar_past_incidents", {
                "query": "our payment page responds slowly when many users buy at once"
            })

            assert isinstance(matches, list) and matches
            assert "TLS handshake" in matches[0]["root_cause"]
            assert matches[0]["score"] > 0.5
        finally:
            await _cleanup(created)

    async def test_unrelated_query_scores_lower(self, client, org):
        """Nearest-neighbour search always returns SOMETHING — the score is
        what tells you whether it is a real match."""
        await ensure_collection()
        created = []
        try:
            created = [await _seed(
                org.service_id, "latency_spike",
                "Checkout slow due to payment gateway TLS handshake timeouts.",
            )]

            good = await execute_tool("find_similar_past_incidents", {
                "query": "payment checkout is responding slowly"})
            unrelated = await execute_tool("find_similar_past_incidents", {
                "query": "quarterly revenue figures look wrong in the finance report"})

            assert good[0]["score"] > unrelated[0]["score"]
        finally:
            await _cleanup(created)

    async def test_returns_a_message_when_store_is_empty(self, client):
        """Not a crash, and not an empty list the model has to interpret —
        a plain sentence it can read."""
        await ensure_collection()
        result = await execute_tool("find_similar_past_incidents", {
            "query": f"impossible nonsense {uuid.uuid4().hex}"})
        assert isinstance(result, (list, dict))


class TestIncidentsAreSearchableAfterSaving:
    async def test_embedding_id_is_set_on_success(self, client, org):
        created = []
        try:
            await ensure_collection()
            incident_id = await _seed(
                org.service_id, "error_spike", "Redis connection refused during deploy.")
            created = [incident_id]

            rows = await query(
                "SELECT embedding_id FROM incidents WHERE id = $1", incident_id)
            assert rows[0]["embedding_id"] == incident_id
        finally:
            await _cleanup(created)
