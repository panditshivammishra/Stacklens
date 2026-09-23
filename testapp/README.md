# testapp — a fake app for testing Stacklens

## What problem this folder solves

The pytest suite in `backend-py/tests/` proves the backend is correct.
It does not prove the **dashboard** is correct, because no test opens a browser.

To check the dashboard you need something producing real traffic. That is what
this folder is: two tiny services that call each other in a loop, so every page
of the dashboard has live data to show.

`demo/app.js` also exists and does something similar — but it is ONE service, so
it can never draw an arrow on the service map. This folder has two, on purpose.

## The five terminals

Run each line in its own terminal. Order matters: Docker → backend → dashboard →
services.

### 1. Infrastructure (Postgres, Redis, Qdrant)

```
cd c:\Users\pandi\Desktop\stacklens
docker compose up -d
```

### 2. Backend

```
cd backend-py
.venv\Scripts\uvicorn app.main:app --reload --port 4001
```

### 3. Get two API keys

The backend rejects spans without a key. `bootstrap.py` creates the account and
prints a key. Run it once per service — the key IS the service identity.

```
cd backend-py
.venv\Scripts\python bootstrap.py --service orders-api
.venv\Scripts\python bootstrap.py --service payments-api
```

Copy both keys. They are shown once and never again (only a hash is stored).

Default login it prints: `demo@stacklens.dev` / `demo-password-123`

### 4. Dashboard

```
cd dashboard
npm run dev
```

Open http://localhost:3000 and sign in with the login above.

### 5. The two test services

```
set STACKLENS_API_KEY=<the payments-api key>
node testapp\payments-service.js
```

```
set STACKLENS_API_KEY=<the orders-api key>
node testapp\orders-service.js
```

orders-api fires one request at itself every second, so you do not need to curl
anything. Traces start appearing within ~4 seconds (2s SDK flush + worker).

## What to check on each page

| Page | What proves it works |
|---|---|
| `/` (overview) | span count climbing on its own, without refreshing — that is SSE |
| `/` service list | `orders-api` and `payments-api` both listed, ~15% errors on payments |
| `/trace/<id>` | one waterfall containing spans from BOTH services |
| `/service-map` | an arrow `orders-api → payments-api` |
| `/incidents` | after a few minutes, an AI-written incident about the error rate |
| `/settings` | issue a key, revoke it, watch the service stop reporting |

The trace page is the important one. Two separate Node processes, one trace.
Nothing in `orders-service.js` passes a trace id — the SDK adds the headers on
the outgoing HTTP call and the middleware reads them on the way in.

## Adding Stacklens to YOUR OWN app

Three lines. Everything else in these files is fake business logic.

```js
const { stacklens, stacklensMiddleware } = require('@stacklens/sdk')

stacklens({ serviceId: 'my-app', apiKey: process.env.STACKLENS_API_KEY,
            backendUrl: 'http://localhost:4001' })   // 1. before anything else

app.use(stacklensMiddleware())                       // 2. Express: one line
```

```js
await runWithSpan('db:users.find', () => db.users.find())   // 3. optional detail
```

Line 1 must run before your app makes any HTTP call, because it patches Node's
`http` module. Put it at the very top of your entry file.

Line 3 is optional. Without it you still get one span per request. With it you
see where inside the request the time went.
