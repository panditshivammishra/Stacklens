// ─────────────────────────────────────────────────────────────────────────────
// TEST APP — service 1 of 2: "orders-api"
//
// This is the UPSTREAM service. It receives a request, does some fake DB work,
// then calls payments-api over plain HTTP.
//
// You write NO tracing code for that outgoing call. The SDK patched Node's
// http module at startup, so it stamps x-trace-id / x-parent-span-id onto the
// request automatically, and payments-api's middleware reads them back. That
// handshake is what makes one trace span two processes — and what draws the
// arrow on the service map.
//
// Run:  STACKLENS_API_KEY=<key for orders-api> node testapp/orders-service.js
// ─────────────────────────────────────────────────────────────────────────────

const http = require('http')
const { stacklens, stacklensMiddleware, runWithSpan } = require('../sdk/dist/index.js')

stacklens({
  serviceId: 'orders-api',
  apiKey: process.env.STACKLENS_API_KEY || '',
  backendUrl: process.env.STACKLENS_BACKEND_URL || 'http://localhost:4001',
  flushInterval: 2000,
})

const trace = stacklensMiddleware()
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const server = http.createServer((req, res) => {
  trace(req, res, async () => {
    if (req.url.startsWith('/checkout')) {
      await runWithSpan('db:cart.load', () => sleep(20 + Math.random() * 30))

      // Plain HTTP call — no tracing code. The SDK handles propagation.
      const payment = await callPayments()

      res.writeHead(payment.ok ? 200 : 402, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ orderId: 'ord_' + Math.random().toString(36).slice(2, 8) }))
    }

    res.writeHead(404)
    res.end(JSON.stringify({ error: 'Not found' }))
  })
})

function callPayments() {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: 'localhost', port: 5102, path: '/charge', method: 'POST' },
      (res) => { res.resume(); res.on('end', () => resolve({ ok: res.statusCode < 400 })) }
    )
    req.on('error', () => resolve({ ok: false }))
    req.end()
  })
}

// ─── Load generator ─────────────────────────────────────────────────────────
// Fires a request at ourselves every second so the dashboard has a live feed
// without you needing to curl anything.
server.listen(5101, () => {
  console.log('[orders-api] listening on http://localhost:5101')
  console.log('[orders-api] firing one /checkout per second — watch http://localhost:3000')

  setInterval(() => {
    http.request({ hostname: 'localhost', port: 5101, path: '/checkout', method: 'POST' },
      (r) => r.resume()).on('error', () => {}).end()
  }, 1000)
})
