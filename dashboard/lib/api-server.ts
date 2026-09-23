import 'server-only'
import { cookies } from 'next/headers'
import { makeApi } from './api'

// ─────────────────────────────────────────────────────────────────────────────
// The server-side API client.
//
// WHY THIS FILE EXISTS
//   A server component runs in Node, not the browser. When it calls the backend
//   it is opening a brand new HTTP connection that has nothing to do with the
//   user's browser session — so the session cookie is simply not on it, and the
//   backend correctly answers 401.
//
//   The fix is to bridge the two requests: read the cookie off the request that
//   Next.js is currently handling (that IS the user's browser request, and it
//   does carry the cookie), then attach it to the outgoing call.
//
//        browser ──cookie──► Next.js server ──cookie (re-attached here)──► API
//
// WHY `import 'server-only'`
//   It makes the build FAIL if a client component ever imports this file. That
//   matters: next/headers cannot run in the browser, and without this guard the
//   mistake shows up as a confusing runtime error instead of a clear build one.
// ─────────────────────────────────────────────────────────────────────────────
export async function serverApi() {
  const store = await cookies()
  // toString() serialises the whole jar into a "a=1; b=2" Cookie header value.
  return makeApi(store.toString())
}
