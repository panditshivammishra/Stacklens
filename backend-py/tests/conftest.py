"""
Shared test setup.

HOW THESE TESTS RUN
  The app is started IN-PROCESS — no `uvicorn` in another terminal. httpx's
  ASGITransport speaks to the FastAPI app object directly, and LifespanManager
  runs the real startup/shutdown (Postgres pool, Redis ping, Qdrant collection,
  background workers). So what is tested is the real wiring, not a mock.

WHAT YOU DO NEED RUNNING
  The databases: `docker compose up -d` from the repo root. These are
  integration tests on purpose — mocking Postgres would only prove the mock
  works, not that the SQL does.

TEST ISOLATION
  Every test that needs an account calls the `org` fixture, which signs up a
  BRAND NEW org with a random email. Tests never share data, so they can run in
  any order and one failure can't cascade into another.
"""
import uuid
from dataclasses import dataclass

import pytest
import pytest_asyncio
from asgi_lifespan import LifespanManager
from httpx import ASGITransport, AsyncClient

from app.main import app


@pytest_asyncio.fixture
async def client():
    """An HTTP client wired straight into the app, with the real lifespan run."""
    async with LifespanManager(app, startup_timeout=60, shutdown_timeout=60):
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as c:
            yield c


@dataclass
class Org:
    """One freshly created tenant: a logged-in client plus its first service."""
    client: AsyncClient
    email: str
    org_id: str
    service_name: str
    service_id: str
    api_key: str


async def _signup(c: AsyncClient) -> tuple[str, str]:
    """Create a brand new org + owner. Returns (email, org_id).

    The client keeps the session cookie automatically after this, because
    httpx.AsyncClient stores cookies like a browser does.
    """
    email = f"test-{uuid.uuid4().hex[:12]}@example.com"
    res = await c.post("/auth/signup", json={
        "email": email,
        "password": "test-password-123",
        "org_name": f"Test Org {uuid.uuid4().hex[:6]}",
    })
    assert res.status_code == 201, res.text
    return email, res.json()["org_id"]


async def _create_service(c: AsyncClient, name: str) -> tuple[str, str]:
    """Create a service under the logged-in org. Returns (service_id, api_key)."""
    res = await c.post("/api/services", json={"name": name})
    assert res.status_code == 201, res.text
    body = res.json()
    return body["service_id"], body["api_key"]


@pytest_asyncio.fixture
async def org(client) -> Org:
    """A signed-up org with one service and a usable API key."""
    email, org_id = await _signup(client)
    name = f"svc-{uuid.uuid4().hex[:8]}"
    service_id, api_key = await _create_service(client, name)
    return Org(client, email, org_id, name, service_id, api_key)


@pytest_asyncio.fixture
async def other_org(client) -> Org:
    """
    A SECOND, unrelated org — on its own client, so it has its own cookie jar.

    Used by the isolation tests: this is the "attacker" or "other customer"
    whose view must never include the first org's data.
    """
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c2:
        email, org_id = await _signup(c2)
        name = f"svc-{uuid.uuid4().hex[:8]}"
        service_id, api_key = await _create_service(c2, name)
        yield Org(c2, email, org_id, name, service_id, api_key)


def span(service_id: str = "ignored-by-server", **overrides) -> dict:
    """Build one valid span payload. Any field can be overridden per test."""
    base = {
        "traceId": f"trace-{uuid.uuid4().hex[:12]}",
        "spanId": f"span-{uuid.uuid4().hex[:12]}",
        "serviceId": service_id,
        "operation": "GET /test",
        "startTime": 1_700_000_000_000,
        "duration": 42,
        "status": "ok",
    }
    base.update(overrides)
    return base
