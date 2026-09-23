# Testing Stacklens

## TL;DR

```powershell
# once, from the repo root — the tests need real databases
docker compose up -d

# then, from backend-py/
.venv\Scripts\python -m pytest
```

That runs everything. To skip the tests that call a real AI API:

```powershell
.venv\Scripts\python -m pytest -m "not slow"
```

---

## What kind of tests are these?

**Integration tests, on purpose.** They run against real Postgres, real Redis
and real Qdrant in Docker.

Why not mock the database? Because almost every bug this system has actually
had lived in the SQL, the schema, or the wiring between services — not in
Python logic. A mocked database proves the mock works. It would not have caught
the service-map bug, the foreign-key constraint, or the Qdrant version
mismatch. All three were caught by talking to the real thing.

**No separate server needed.** The tests start the app *in-process* using
httpx's ASGI transport, and run the real startup/shutdown sequence. You do not
run `uvicorn` in another terminal.

---

## Requirements

| Needed | Why | How |
|---|---|---|
| Docker running | Postgres, Redis, Qdrant | `docker compose up -d` |
| Python venv | the app + pytest | `.venv\Scripts\pip install -r requirements.txt` |
| `GEMINI_API_KEY` in `.env` | only for the `slow` RAG tests | skip with `-m "not slow"` |

---

## The test files

| File | Covers | Needs DB? |
|---|---|---|
| `test_crypto.py` | password hashing, JWT signing/verifying, API-key generation | no — runs in ~2s |
| `test_auth.py` | signup, login, logout, `/auth/me`, and every route rejecting strangers | yes |
| `test_ingest.py` | API key required; **payload `serviceId` is overwritten from the key** (anti-spoofing) | yes |
| `test_isolation.py` | one org can never read or write another org's data | yes |
| `test_keys.py` | issue, list (prefix only), rotate, revoke | yes |
| `test_worker.py` | span persistence, idempotency, **service-map edge derivation** | yes |
| `test_rag.py` | embeddings + semantic retrieval | yes + AI API (`slow`) |

---

## Useful commands

```powershell
# one file
.venv\Scripts\python -m pytest tests/test_auth.py

# one test, by name
.venv\Scripts\python -m pytest -k "spoof"

# fast feedback: unit tests only, no databases needed
.venv\Scripts\python -m pytest tests/test_crypto.py

# stop at the first failure, show local variables
.venv\Scripts\python -m pytest -x -l

# see what the app printed during a test
.venv\Scripts\python -m pytest -s
```

---

## How test isolation works

Every test that needs an account uses the `org` fixture, which **signs up a
brand new organisation with a random email**. Nothing is shared between tests,
so they can run in any order and one failure cannot cascade.

Tests that check multi-tenancy also use `other_org` — a second, unrelated
customer on its own HTTP client (its own cookie jar). That second org is what
must be shown nothing.

The `slow` RAG tests delete every incident they create, from both Postgres and
Qdrant, in a `finally:` block — so repeated runs don't fill the vector store
with junk.

---

## Testing the parts pytest doesn't cover

Two pieces are outside the Python suite:

**The SDK (TypeScript)** — type-checks on build:
```powershell
cd sdk
npx tsc -p tsconfig.json
```

**The dashboard (Next.js)** — type-checks and builds:
```powershell
cd dashboard
npm run build
```

**The whole thing, by hand (the real smoke test):**
```powershell
# 1. databases
docker compose up -d

# 2. create an account + API key
cd backend-py
.venv\Scripts\python bootstrap.py       # prints a login and an sl_live_... key

# 3. backend
.venv\Scripts\uvicorn app.main:app --port 4001

# 4. dashboard (new terminal)      → http://localhost:3000
cd dashboard; npm run dev

# 5. traffic (new terminal)
$env:STACKLENS_API_KEY = "sl_live_...paste..."
node demo/app.js
```
Sign in at http://localhost:3000 and spans should appear in the live feed
within a few seconds.

`demo/app.js` is ONE service, so it can never draw an arrow on the service map.
To exercise the cross-service pages, use `testapp/` instead — two small services
that call each other, with their own README:

```powershell
cd backend-py
.venv\Scripts\python bootstrap.py --service orders-api      # key A
.venv\Scripts\python bootstrap.py --service payments-api    # key B

# terminal 1
$env:STACKLENS_API_KEY = "<key B>"; node testapp\payments-service.js
# terminal 2
$env:STACKLENS_API_KEY = "<key A>"; node testapp\orders-service.js
```

That is the only way to check the trace waterfall spanning two processes and
the `orders-api -> payments-api` edge on the service map. See `testapp/README.md`
for what to look for on each page.

---

## If tests fail

| Symptom | Cause | Fix |
|---|---|---|
| `ConnectionRefusedError` | databases not running | `docker compose up -d` |
| `404` from Qdrant | Qdrant container not up | check `docker ps` |
| RAG tests fail with a quota error | free-tier limit hit | `-m "not slow"`, or change the model in `.env` |
| `no embedding provider configured` | no API key in `.env` | expected — those tests skip themselves |
