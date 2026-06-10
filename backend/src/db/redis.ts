import Redis from 'ioredis'

export const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
})

redis.on('error', (err) => {
  // Log but never crash the server — Redis being down shouldn't kill the API
  console.error('Redis error:', err.message)
})
