"""
Multi-tenancy: one customer must never see another's data.

Every test here uses TWO orgs. `org` is the owner of some data; `other_org` is
an unrelated, legitimately logged-in customer who must be shown nothing.
"""
from tests.conftest import span
from tests.test_ingest import _drain_worker


async def _ingest_and_persist(org, **overrides) -> dict:
    """Send one span as `org` and make sure it reaches Postgres."""
    payload = span(**overrides)
    res = await org.client.post(
        "/ingest", json={"spans": [payload]}, headers={"x-api-key": org.api_key}
    )
    assert res.status_code == 202
    await _drain_worker()
    return payload


class TestServiceNamesDoNotCollide:
    async def test_two_orgs_can_use_the_same_service_name(
        self, client, org, other_org
    ):
        """Before org-namespacing, the second org's service silently merged
        into the first one's row. Now they are separate.

        (`org` is requested so that `client` is signed in — the fixture is what
        creates the session this test needs.)"""
        name = "api"
        a = await client.post("/api/services", json={"name": name})
        b = await other_org.client.post("/api/services", json={"name": name})

        assert a.status_code == 201
        assert b.status_code == 201
        assert a.json()["service_id"] != b.json()["service_id"]


class TestReadsAreOrgScoped:
    async def test_service_list_excludes_other_orgs(self, client, org, other_org):
        mine = {s["id"] for s in (await client.get("/api/services")).json()}
        assert org.service_id in mine
        assert other_org.service_id not in mine

    async def test_trace_from_another_org_is_404(self, client, org, other_org):
        """404, not 403 — a trace that exists but isn't yours must look exactly
        like one that doesn't exist, or ids become probeable."""
        payload = await _ingest_and_persist(org)

        assert (await client.get(f"/api/trace/{payload['traceId']}")).status_code == 200
        res = await other_org.client.get(f"/api/trace/{payload['traceId']}")
        assert res.status_code == 404

    async def test_asking_for_another_orgs_service_returns_nothing(
        self, client, org, other_org
    ):
        await _ingest_and_persist(org)
        res = await other_org.client.get(f"/api/spans?serviceId={org.service_id}")
        assert res.status_code == 200
        assert res.json() == []

    async def test_stats_for_another_orgs_service_are_empty(
        self, client, org, other_org
    ):
        await _ingest_and_persist(org)
        body = (await other_org.client.get(
            f"/api/stats?serviceId={org.service_id}")).json()
        assert int(body["total"] or 0) == 0

    async def test_service_map_excludes_other_orgs(self, client, org, other_org):
        body = (await other_org.client.get("/api/service-map")).json()
        node_ids = {n["id"] for n in body["nodes"]}
        assert org.service_id not in node_ids

    async def test_incidents_are_scoped(self, client, org, other_org):
        """Both orgs may legitimately have incidents; neither may see the
        other's. An empty list is fine — a leak is not."""
        res = await other_org.client.get("/api/incidents")
        assert res.status_code == 200
        assert all(i["service_id"] != org.service_id for i in res.json())


class TestWriteScoping:
    async def test_cannot_issue_a_key_for_another_orgs_service(
        self, client, org, other_org
    ):
        """Guessing the victim's service NAME must not be enough to mint a key
        that writes to it."""
        res = await other_org.client.post(
            "/api/keys", json={"name": org.service_name}
        )
        assert res.status_code == 404

    async def test_cannot_revoke_another_orgs_key(self, client, org, other_org):
        keys = (await client.get("/api/keys")).json()
        victim_key_id = keys[0]["id"]

        res = await other_org.client.delete(f"/api/keys/{victim_key_id}")
        assert res.status_code == 404

        # and the victim's key still works
        res = await client.post(
            "/ingest", json={"spans": [span()]}, headers={"x-api-key": org.api_key}
        )
        assert res.status_code == 202
