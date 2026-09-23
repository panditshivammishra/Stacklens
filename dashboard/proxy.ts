import { NextResponse, type NextRequest } from 'next/server'

// ─────────────────────────────────────────────────────────────────────────────
// Route guard — runs BEFORE any page renders.
//
// FILE NAME NOTE: in Next.js 16 the `middleware.ts` convention was renamed to
// `proxy.ts` (the old name kept getting confused with Express middleware). Same
// mechanism, new name; the exported function must be named `proxy`.
//
// WHY HERE AND NOT IN EACH PAGE
//   Checking inside every page means every new page is one forgotten check away
//   from being public. This inverts it: routes are protected by default and the
//   exceptions live in one list you can actually audit.
//
// WHAT THIS IS *NOT*
//   A redirect for humans, NOT a security boundary. It only checks that a cookie
//   EXISTS — it does not verify the signature, and anyone can set a junk cookie
//   from devtools. That is fine, because the real enforcement is on the backend:
//   every API route validates the token itself and scopes its query by org.
//   Someone who fakes the cookie gets the dashboard shell and nothing but 401s
//   inside it.
//
//   Keeping the check cheap is deliberate — this runs on every request, so it
//   should not be doing crypto or database work.
// ─────────────────────────────────────────────────────────────────────────────

const PUBLIC_PATHS = ['/login']

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  const hasSession = req.cookies.has('stacklens_session')

  if (PUBLIC_PATHS.includes(pathname)) {
    // Already signed in? Skip the login screen.
    if (hasSession) return NextResponse.redirect(new URL('/', req.url))
    return NextResponse.next()
  }

  if (!hasSession) {
    const url = new URL('/login', req.url)
    // Remember where they were headed so we can return them there after login.
    if (pathname !== '/') url.searchParams.set('next', pathname)
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
}

export const config = {
  // Skip Next's own internals and static files — they need no guarding, and
  // running this on every image would just add latency.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
