import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { initDb } from './db/postgres'
import { redis } from './db/redis'
import { ingestRoutes } from './routes/ingest'

const app = Fastify({ logger: true })

async function start(): Promise<void> {
  await app.register(cors, { origin: true })
  await app.register(ingestRoutes)

  app.get('/health', async () => ({ status: 'ok' }))

  // Connect to Postgres and run schema migrations
  await initDb()

  // Connect to Redis
  await redis.connect()

  const port = Number(process.env.PORT ?? 4000)
  await app.listen({ port, host: '0.0.0.0' })
  console.log(`Stacklens backend running on port ${port}`)
}

start().catch((err) => {
  console.error(err)
  process.exit(1)
})
