'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

// ─────────────────────────────────────────────────────────────────────────────
// Why this is a separate client component.
//
// Highlighting the current page needs the current URL, and usePathname() is a
// client-side hook. The layout around it is a SERVER component (it checks the
// session before rendering anything), and server components cannot use hooks.
// So only this one small piece crosses to the client; the rest of the shell
// stays server-rendered and ships no JavaScript.
// ─────────────────────────────────────────────────────────────────────────────

const nav = [
  { href: '/', label: 'Overview' },
  { href: '/service-map', label: 'Service map' },
  { href: '/incidents', label: 'Incidents' },
  { href: '/settings', label: 'Settings' },
]

export function NavLinks() {
  const pathname = usePathname()

  // A trace page is reached from the overview's live feed, so it keeps
  // "Overview" lit — the user has drilled down, not gone somewhere new.
  const isActive = (href: string) =>
    href === '/' ? pathname === '/' || pathname.startsWith('/trace/') : pathname.startsWith(href)

  return (
    <nav className="-mx-1 flex h-full min-w-0 items-stretch gap-1 overflow-x-auto px-1 [scrollbar-width:none]">
      {nav.map(({ href, label }) => {
        const active = isActive(href)
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={`relative flex shrink-0 items-center px-2.5 text-[13px] whitespace-nowrap transition-colors ${
              active ? 'text-ink' : 'text-ink-faint hover:text-ink-muted'
            }`}
          >
            {label}
            {active && (
              <span aria-hidden className="absolute inset-x-2.5 bottom-0 h-px bg-signal" />
            )}
          </Link>
        )
      })}
    </nav>
  )
}
