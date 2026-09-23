'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api } from '../lib/api'

// ─────────────────────────────────────────────────────────────────────────────
// CONCEPT: why logging out needs a server call at all.
//
// The session cookie is httpOnly, so JavaScript cannot delete it — that is the
// same protection that stops an injected script from stealing it. Only the
// server can clear it, by replying with an expired Set-Cookie header. That is
// exactly what POST /auth/logout does.
//
// router.refresh() afterwards throws away the cached server-rendered pages,
// which were rendered while the user was still signed in.
// ─────────────────────────────────────────────────────────────────────────────
export function LogoutButton() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function logout() {
    setBusy(true)
    try {
      await api.logout()
    } finally {
      router.push('/login')
      router.refresh()
    }
  }

  return (
    <button
      onClick={logout}
      disabled={busy}
      className="text-[12px] text-ink-muted transition-colors hover:text-ink disabled:opacity-50"
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  )
}
