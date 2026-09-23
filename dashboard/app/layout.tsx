import type { Metadata } from 'next'
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google'
import './globals.css'

// One type family in two cuts: Plex Sans for the interface, Plex Mono for data
// (routes, durations, ids). Designed together, so the two sit comfortably side
// by side in the same table row. next/font downloads them at BUILD time and
// serves them from our own origin — no request to Google from the browser.
const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-sans',
})
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex-mono',
})

export const metadata: Metadata = {
  title: {
    default: 'Stacklens',
    template: '%s · Stacklens',
  },
  description: 'Self-hosted tracing for Node.js services',
}

// ─────────────────────────────────────────────────────────────────────────────
// The root layout is now deliberately bare: <html>, <body>, fonts. Nothing else.
//
// WHY IT SHRANK
//   It used to render the sidebar, which meant EVERY route got the signed-in
//   dashboard shell — including /login, where a nav bar for an app you cannot
//   reach yet makes no sense.
//
//   The sidebar moved into app/(app)/layout.tsx. The parentheses make (app) a
//   ROUTE GROUP: it groups files under a shared layout without appearing in any
//   URL — app/(app)/page.tsx is still "/". So authenticated pages get the shell,
//   and /login, living outside the group, renders on its own.
// ─────────────────────────────────────────────────────────────────────────────
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable}`}>
      <body className="min-h-screen" suppressHydrationWarning>
        {children}
      </body>
    </html>
  )
}
