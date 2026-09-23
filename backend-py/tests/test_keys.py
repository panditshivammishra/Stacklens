"""
Service + API-key management: creation, the one-time reveal, rotation, revocation.
"""
import uuid


class TestServiceCreation:
    async def test_returns_key_once(self, client, org):
        res = await client.post("/api/services", json={"name": f"s-{uuid.uuid4().hex[:8]}"})
        assert res.status_code == 201
        body = res.json()
        assert body["api_key"].startswith("sl_live_")
        assert "never be shown again" in body["warning"]

    async def test_duplicate_name_in_same_org_rejected(self, client, org):
        assert (await client.post(
            "/api/services", json={"name": org.service_name})).status_code == 409

    async def test_invalid_names_rejected(self, client, org):
        for bad in ["UPPERCASE", "has spaces", "a", "x" * 60]:
            res = await client.post("/api/services", json={"name": bad})
            assert res.status_code == 422, f"{bad!r} should have been rejected"


class TestKeyListing:
    async def test_never_returns_key_material(self, client, org):
        """The list shows only the prefix — enough for a human to recognise a
        key, useless to anyone who steals the response."""
        keys = (await client.get("/api/keys")).json()
        assert keys
        for k in keys:
            assert "api_key" not in k
            assert "key_hash" not in k
            assert k["key_prefix"].startswith("sl_live_")

    async def test_shows_service_and_status(self, client, org):
        keys = (await client.get("/api/keys")).json()
        mine = [k for k in keys if k["service_id"] == org.service_id]
        assert mine
        assert mine[0]["revoked_at"] is None


class TestRotation:
    async def test_second_key_works_alongside_the_first(self, client, org):
        """Zero-downtime rotation: deploy the new key, THEN revoke the old.
        Both must work during the overlap or spans get dropped mid-deploy."""
        from tests.conftest import span

        res = await client.post("/api/keys", json={"name": org.service_name})
        assert res.status_code == 201
        new_key = res.json()["api_key"]
        assert new_key != org.api_key

        for key in (org.api_key, new_key):
            r = await client.post(
                "/ingest", json={"spans": [span()]}, headers={"x-api-key": key}
            )
            assert r.status_code == 202

    async def test_revoking_one_key_leaves_the_other_working(self, client, org):
        from tests.conftest import span

        new_key = (await client.post(
            "/api/keys", json={"name": org.service_name})).json()["api_key"]

        keys = (await client.get("/api/keys")).json()
        old_id = next(
            k["id"] for k in keys
            if k["service_id"] == org.service_id
            and org.api_key.startswith(k["key_prefix"])
        )
        assert (await client.delete(f"/api/keys/{old_id}")).status_code == 200

        old = await client.post("/ingest", json={"spans": [span()]},
                                headers={"x-api-key": org.api_key})
        new = await client.post("/ingest", json={"spans": [span()]},
                                headers={"x-api-key": new_key})
        assert old.status_code == 401
        assert new.status_code == 202


class TestRevocation:
    async def test_is_a_soft_delete(self, client, org):
        """The row survives with a timestamp, so an audit can still answer
        'which key wrote this, and when was it turned off?'"""
        keys = (await client.get("/api/keys")).json()
        key_id = keys[0]["id"]
        await client.delete(f"/api/keys/{key_id}")

        after = (await client.get("/api/keys")).json()
        row = next(k for k in after if k["id"] == key_id)
        assert row["revoked_at"] is not None

    async def test_double_revoke_is_404(self, client, org):
        key_id = (await client.get("/api/keys")).json()[0]["id"]
        assert (await client.delete(f"/api/keys/{key_id}")).status_code == 200
        assert (await client.delete(f"/api/keys/{key_id}")).status_code == 404

    async def test_unknown_key_id_is_404(self, client, org):
        assert (await client.delete(f"/api/keys/{uuid.uuid4()}")).status_code == 404
