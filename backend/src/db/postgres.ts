import { Pool } from 'pg'
import fs from 'fs'
import path from 'path'

// ─────────────────────────────────────────────────────────────────────────────
// CONCEPT: Lazy initialization
//
// The Pool is created inside initDb() — not at module load time.
// This guarantees dotenv has already run before we read process.env.DATABASE_URL.
// If we created the Pool at module level, it would capture DATABASE_URL = undefined
// because imports are hoisted and run before dotenv executes.
// ─────────────────────────────────────────────────────────────────────────────
let pool: Pool

export function getPool(): Pool {
  return pool
}

export async function initDb(): Promise<void> {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  })

  const schema = fs.readFileSync(
    path.join(__dirname, 'schema.sql'),
    'utf-8'
  )
  await pool.query(schema)
  console.log('Database schema ready')
}

export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const result = await getPool().query(sql, params)
  return result.rows as T[]
}
