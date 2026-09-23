// ─────────────────────────────────────────────────────────────────────────────
// Stacklens Demo App
//
// Simulates a real e-commerce backend with:
//   - /api/products  — fast, always OK
//   - /api/orders    — medium latency, 20% error rate
//   - /api/users/:id — DB lookup simulation, occasional timeout
//   - /api/checkout  — slow, calls products + orders internally (creates child spans)
//
// Run: node demo/app.js
// Then open http://localhost:3000 to see live traces in the dashboard.
// ─────────────────────────────────────────────────────────────────────────────

const http = require('http')
const { stacklens, runWithSpan, startSpan, endSpan } = require('../sdk/dist/index.js')

// ─────────────────────────────────────────────────────────────────────────────
// Initialize the SDK.
//
// The backend now requires an API key on /ingest — spans are rejected with a 401
// without one. Get a key by running, from backend-py/:
//
//     .venv\Scripts\python bootstrap.py
//
// then pass it here (or export STACKLENS_API_KEY before starting the demo).
// The server derives the real service id FROM the key, so `serviceId` below is
// only a local label.
// ─────────────────────────────────────────────────────────────────────────────
const API_KEY = process.env.STACKLENS_API_KEY || ''

if (!API_KEY) {
  console.warn(
    '[Demo] No STACKLENS_API_KEY set — /ingest will reject these spans with 401.\n' +
    '       Run `python bootstrap.py` in backend-py/ and export the key it prints.\n'
  )
}

stacklens({
  serviceId: 'shop-api',
  apiKey: API_KEY,
  backendUrl: process.env.STACKLENS_BACKEND_URL || 'http://localhost:4001',
  flushInterval: 2000,   // flush every 2s so data appears in dashboard quickly
  maxBufferSize: 200,
})

console.log('[Demo] shop-api started — SDK initialized, flushing every 2s')
console.log('[Demo] Open http://localhost:3000 to see live traces\n')

// ─── Simulated DB/cache helpers ──────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function jitter(base, variance) {
  return base + Math.floor(Math.random() * variance) - variance / 2
}

async function fakeDbQuery(operation, baseMs) {
  return runWithSpan(`db:${operation}`, async () => {
    await sleep(jitter(baseMs, baseMs * 0.6))
    if (Math.random() < 0.05) throw new Error('Connection pool timeout')
  })
}

async function fakeCacheGet(key) {
  return runWithSpan('cache:get', async () => {
    await sleep(jitter(3, 4))
    return Math.random() > 0.4  // 60% cache hit rate
  })
}

// ─── Request handlers ────────────────────────────────────────────────────────

async function handleProducts(req, res) {

  return runWithSpan('GET /api/products', async () => {
    const cached = await fakeCacheGet('products:all')
    if (!cached) {
      await fakeDbQuery('products.findAll', 40)
    }

    // MY FIRST CUSTOM SPAN — added by me to learn how runWithSpan works
    await runWithSpan('my:first-custom-span', async () => {
      await sleep(100)
    })

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ products: [
      { id: 1, name: 'Widget Pro', price: 29.99 },
      { id: 2, name: 'Gadget Plus', price: 49.99 },
      { id: 3, name: 'Doohickey', price: 9.99 },
    ]}))
  })
}

async function handleOrders(req, res) {
  return runWithSpan('POST /api/orders', async () => {
    // 20% error rate — will eventually trigger anomaly detector
    if (Math.random() < 0.20) {
      await fakeDbQuery('orders.validate', 15)
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Insufficient inventory for SKU-' + Math.floor(Math.random() * 100) }))
      throw new Error('Order validation failed: insufficient inventory')
    }

    await fakeDbQuery('orders.insert', 60)
    await fakeDbQuery('payments.charge', 120)
    res.writeHead(201, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ orderId: 'ord_' + Math.random().toString(36).slice(2, 10) }))
  })
}

async function handleUser(req, res, userId) {
  return runWithSpan('GET /api/users/:id', async () => {
    const cached = await fakeCacheGet(`user:${userId}`)
    if (!cached) {
      await fakeDbQuery('users.findById', 35)
    }
    // Rare slow path — ~5% chance of very slow query (will show up in p95)
    if (Math.random() < 0.05) {
      await fakeDbQuery('users.loadPermissions', 800)
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ id: userId, name: 'User ' + userId, email: `user${userId}@example.com` }))
  })
}

async function handleCheckout(req, res) {
  // Checkout calls products + validates cart + charges — creates a waterfall trace
  return runWithSpan('POST /api/checkout', async () => {
    // These nested runWithSpan calls create child spans with shared traceId
    await runWithSpan('validate:cart', async () => {
      await fakeDbQuery('cart.findBySession', 25)
    })

    await runWithSpan('fetch:products', async () => {
      await fakeDbQuery('products.findByIds', 30)
    })

    if (Math.random() < 0.10) {
      // 10% chance of payment failure — creates an error span deep in the trace
      await runWithSpan('payment:charge', async () => {
        await fakeDbQuery('payments.authorize', 90)
        throw new Error('Card declined: insufficient funds')
      }).catch(() => {})  // caught at checkout level
      res.writeHead(402, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Payment failed' }))
      throw new Error('Checkout failed: payment declined')
    }

    await runWithSpan('payment:charge', async () => {
      await fakeDbQuery('payments.authorize', 90)
      await fakeDbQuery('payments.capture', 45)
    })

    await runWithSpan('notify:email', async () => {
      await sleep(jitter(20, 15))
    })

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'success', orderId: 'ord_' + Math.random().toString(36).slice(2, 10) }))
  })
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = req.url || '/'

  try {
    if (url === '/api/products' && req.method === 'GET') {
      await handleProducts(req, res)
    } else if (url === '/api/orders' && req.method === 'POST') {
      await handleOrders(req, res)
    } else if (url.startsWith('/api/users/') && req.method === 'GET') {
      const userId = url.split('/')[3]
      await handleUser(req, res, userId)
    } else if (url === '/api/checkout' && req.method === 'POST') {
      await handleCheckout(req, res)
    } else {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'Not found' }))
    }
  } catch {
    // Error already recorded by runWithSpan — just ensure response is sent
    if (!res.headersSent) {
      res.writeHead(500)
      res.end(JSON.stringify({ error: 'Internal server error' }))
    }
  }
})

server.listen(5001, () => {
  console.log('[Demo] HTTP server listening on http://localhost:5001')
  startLoadGenerator()
})

// ─── Load Generator ───────────────────────────────────────────────────────────
// Automatically fires requests against our own server every ~500ms
// so traces appear in the dashboard without needing to manually curl anything.

const endpoints = [
  { method: 'GET',  path: '/api/products' },
  { method: 'POST', path: '/api/orders' },
  { method: 'GET',  path: '/api/users/1' },
  { method: 'GET',  path: '/api/users/2' },
  { method: 'GET',  path: '/api/users/42' },
  { method: 'POST', path: '/api/checkout' },
  { method: 'POST', path: '/api/checkout' },  // weighted heavier (more interesting traces)
  { method: 'POST', path: '/api/orders' },
]

function makeRequest(endpoint) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'localhost',
      port: 5001,
      path: endpoint.path,
      method: endpoint.method,
      headers: { 'Content-Type': 'application/json' },
    }

    const req = http.request(options, (res) => {
      res.resume()  // drain response
      res.on('end', resolve)
    })
    req.on('error', resolve)  // ignore load gen errors
    if (endpoint.method === 'POST') {
      req.write(JSON.stringify({ userId: 1 }))
    }
    req.end()
  })
}

function startLoadGenerator() {
  let count = 0

  const tick = async () => {
    const endpoint = endpoints[Math.floor(Math.random() * endpoints.length)]
    await makeRequest(endpoint)
    count++
    if (count % 20 === 0) {
      console.log(`[Demo] ${count} requests sent — check http://localhost:3000`)
    }
  }

  // Ramp up: start with one request per 800ms, then increase to burst
  const interval = setInterval(tick, 800)

  // After 30s, send small bursts to create more interesting patterns
  setTimeout(() => {
    console.log('[Demo] Ramping up traffic...')
    setInterval(async () => {
      // Send 3 concurrent requests every 500ms
      await Promise.all([tick(), tick(), tick()])
    }, 500)
  }, 30_000)

  // Keep process alive
  process.stdin.resume()

  console.log('[Demo] Load generator started — firing requests every 800ms')
  console.log('[Demo] Press Ctrl+C to stop\n')
}
