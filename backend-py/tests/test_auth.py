"""
Auth routes and the guards that protect every other route.

These need the databases running (`docker compose up -d`).
"""
import uuid


class TestProtectedRoutesRejectStrangers:
    """Nothing readable should be reachable without a session."""

    async def test_services_requires_login(self, client):
        assert (await client.get("/api/services")).status_code == 401

    async def test_stats_requires_login(self, client):
        assert (await client.get("/api/stats")).status_code == 401

    async def test_spans_requires_login(self, client):
        assert (await client.get("/api/spans")).status_code == 401

    async def test_incidents_requires_login(self, client):
        assert (await client.get("/api/incidents")).status_code == 401

    async def test_service_map_requires_login(self, client):
        assert (await client.get("/api/service-map")).status_code == 401

    async def test_keys_requires_login(self, client):
        assert (await client.get("/api/keys")).status_code == 401

    async def test_ingest_requires_an_api_key(self, client):
        res = await client.post("/ingest", json={"spans": []})
        assert res.status_code == 401

    async def test_health_is_public(self, client):
        """The one endpoint that must work with no credentials — load balancers
        and uptime checks call it."""
        res = await client.get("/health")
        assert res.status_code == 200
        assert res.json() == {"status": "ok"}


class TestSignup:
    async def test_creates_org_and_returns_owner(self, client):
        email = f"new-{uuid.uuid4().hex[:10]}@example.com"
        res = await client.post("/auth/signup", json={
            "email": email, "password": "password123", "org_name": "Acme",
        })
        assert res.status_code == 201
        body = res.json()
        assert body["email"] == email
        assert body["role"] == "owner"
        assert body["org_id"]

    async def test_sets_session_cookie(self, client):
        await client.post("/auth/signup", json={
            "email": f"c-{uuid.uuid4().hex[:10]}@example.com",
            "password": "password123", "org_name": "Acme",
        })
        assert "stacklens_session" in client.cookies

    async def test_duplicate_email_rejected(self, client):
        email = f"dupe-{uuid.uuid4().hex[:10]}@example.com"
        payload = {"email": email, "password": "password123", "org_name": "A"}
        assert (await client.post("/auth/signup", json=payload)).status_code == 201
        assert (await client.post("/auth/signup", json=payload)).status_code == 409

    async def test_short_password_rejected(self, client):
        """Backend enforces its own minimum — the browser form is not the guard."""
        res = await client.post("/auth/signup", json={
            "email": f"s-{uuid.uuid4().hex[:8]}@example.com",
            "password": "short", "org_name": "A",
        })
        assert res.status_code == 422

    async def test_invalid_email_rejected(self, client):
        res = await client.post("/auth/signup", json={
            "email": "not-an-email", "password": "password123", "org_name": "A",
        })
        assert res.status_code == 422


class TestLogin:
    async def test_correct_credentials(self, client, org):
        res = await client.post("/auth/login", json={
            "email": org.email, "password": "test-password-123",
        })
        assert res.status_code == 200
        assert res.json()["org_id"] == org.org_id

    async def test_wrong_password_rejected(self, client, org):
        res = await client.post("/auth/login", json={
            "email": org.email, "password": "definitely-wrong",
        })
        assert res.status_code == 401

    async def test_unknown_email_rejected(self, client):
        res = await client.post("/auth/login", json={
            "email": "nobody@example.com", "password": "whatever123",
        })
        assert res.status_code == 401

    async def test_same_error_for_unknown_email_and_wrong_password(self, client, org):
        """Different messages would let a stranger discover which emails are
        registered — a free list of accounts to attack."""
        wrong_pw = await client.post("/auth/login", json={
            "email": org.email, "password": "definitely-wrong"})
        no_user = await client.post("/auth/login", json={
            "email": "nobody@example.com", "password": "definitely-wrong"})
        assert wrong_pw.json()["detail"] == no_user.json()["detail"]


class TestSessionLifecycle:
    async def test_me_returns_current_user(self, client, org):
        res = await client.get("/auth/me")
        assert res.status_code == 200
        assert res.json()["email"] == org.email

    async def test_logout_ends_the_session(self, client, org):
        assert (await client.get("/api/services")).status_code == 200
        assert (await client.post("/auth/logout")).status_code == 200
        client.cookies.clear()
        assert (await client.get("/api/services")).status_code == 401

    async def test_forged_cookie_rejected(self, client):
        """Proves the backend verifies the signature — not just the cookie's
        presence. The dashboard's proxy.ts only checks presence, deliberately;
        THIS is the real gate."""
        client.cookies.set("stacklens_session", "totally.made.up")
        assert (await client.get("/api/services")).status_code == 401
