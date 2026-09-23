// ─────────────────────────────────────────────────────────────────────────────
// TEST APP — service 2 of 2: "payments-api"
//
// This is the DOWNSTREAM service. orders-api calls it over HTTP.
// It exists to prove one thing: when a traced service calls another traced
// service, both sets of spans land in the SAME trace.
//
// Run:  STACKLENS_API_KEY=<key for payments-api> node testapp/payments-service.js
// ─────────────────────────────────────────────────────────────────────────────

const http = require('http')
const { stacklens, stacklensMiddleware, runWithSpan } = require('../sdk/dist/index.js')

// ─── STEP 1 of 2: initialise the SDK, before anything else runs ──────────────
// This monkey-patches Node's http module, so it has to happen before any
// outgoing request is made. `serviceId` is only a local label — the backend
// decides the real service from the API key.
stacklens({
  serviceId: 'payments-api',
  apiKey: process.env.STACKLENS_API_KEY || '',
  backendUrl: process.env.STACKLENS_BACKEND_URL || 'http://localhost:4001',
  flushInterval: 2000,
})

// ─── STEP 2 of 2: one middleware traces every route ─────────────────────────
// In Express this is literally `app.use(stacklensMiddleware())`. There is no
// express here, so we call the same function by hand on each request.
const trace = stacklensMiddleware()

const server = http.createServer((req, res) => {
  trace(req, res, async () => {
    // Everything below this line is inside the request's span.
    if (req.url.startsWith('/charge')) {
      await runWithSpan('db:payments.authorize', () => sleep(60 + Math.random() * 60))

      // 15% of charges fail — gives the dashboard real error spans to show,
      // and eventually trips the anomaly detector into opening an incident.
      if (Math.random() < 0.15) {
        res.writeHead(402, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: 'Card declined' }))
      }

      await runWithSpan('db:payments.capture', () => sleep(30 + Math.random() * 40))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ status: 'charged' }))
    }

    res.writeHead(404)
    res.end(JSON.stringify({ error: 'Not found' }))
  })
})

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

server.listen(5102, () => console.log('[payments-api] listening on http://localhost:5102'))
