import Link from 'next/link'
import { redirect } from 'next/navigation'
import { serverApi } from '../../lib/api-server'
import { LogoutButton } from '../../components/LogoutButton'
import { Logo } from '../../components/Logo'
import { NavLinks } from '../../components/NavLinks'

// ─────────────────────────────────────────────────────────────────────────────
// The signed-in shell: sidebar, nav, current user, logout.
//
// CONCEPT: this layout is the REAL auth gate for the UI.
//   proxy.ts already redirects anyone without a cookie, but it only checks that
//   a cookie exists — it never verifies the signature, because doing crypto on
//   every request (including images) would be wasteful.
//
//   Here we call /auth/me, which makes the BACKEND verify the token properly. A
//   forged or expired cookie fails that call and we send them to /login. So the
//   cheap check filters the common case and the real check happens once per page
//   render, in one place, for every route in this group.
//
// LAYOUT: a single top bar rather than a sidebar. There are only four pages,
// and the widest things this app draws — trace waterfalls and span tables —
// are exactly what a 220px sidebar would take width away from.
// ─────────────────────────────────────────────────────────────────────────────

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const api = await serverApi()
  const me = await api.me().catch(() => null)
  if (!me) redirect('/login')

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-canvas/90 backdrop-blur-sm">
        <div className="mx-auto flex h-11 max-w-[1440px] items-stretch gap-4 px-5 sm:gap-6">
          <Link href="/" className="flex shrink-0 items-center" aria-label="Stacklens overview">
            <Logo />
          </Link>

          <NavLinks />

          <div className="ml-auto flex shrink-0 items-center gap-4 text-[12px]">
            <span className="hidden truncate text-ink-faint sm:inline" title={me.email}>
              {me.email}
              <span className="ml-2 rounded-[3px] border border-line px-1.5 py-px text-[11px] text-ink-faint">
                {me.role}
              </span>
            </span>
            <LogoutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px] px-5 py-6">{children}</main>
    </div>
  )
}
