'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Login / signup.
//
// CONCEPT: this form never touches the session token.
//   It POSTs the credentials and the SERVER replies with a Set-Cookie header.
//   The browser stores that cookie itself, and because it is httpOnly this page
//   cannot read it back even if it wanted to. There is no token in React state,
//   no localStorage, nothing for an injected script to steal.
//
//   That is also why success is just `router.push('/')` — by the time the fetch
//   resolves, the browser is already authenticated for every later request.
//
// CONCEPT: why router.refresh() as well as push().
//   The pages are server components whose data was fetched WITHOUT a cookie.
//   Next caches that render. refresh() throws the stale render away and re-runs
//   the server components, this time with the cookie attached.
//
// CONCEPT: returning to where the user was headed.
//   proxy.ts attaches ?next=/settings when it bounces an unauthenticated visit
//   to a protected page. useSearchParams() reads that back here so login lands
//   you back on /settings instead of always at the overview — otherwise that
//   query param proxy.ts builds is computed and thrown away for nothing.
//
// CONCEPT: the Suspense wrapper below.
//   This page has no per-request server data, so Next prerenders it statically.
//   useSearchParams() only works for a statically-rendered page inside a
//   Suspense boundary — without one, the production build fails. The actual
//   form lives in LoginForm; LoginPage just supplies that boundary.
// ─────────────────────────────────────────────────────────────────────────────

import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useState } from 'react'
import { api, BACKEND_URL } from '../../lib/api'
import { Logo } from '../../components/Logo'
import { button, fieldLabel, input } from '../../components/ui'

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [orgName, setOrgName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      if (mode === 'signup') {
        await api.signup(email, password, orgName)
      } else {
        await api.login(email, password)
      }
      // Only follow `next` if it's a same-app path: proxy.ts always sets a
      // plain pathname, but the query string is user-editable, so a crafted
      // ?next=https://evil.com or ?next=//evil.com must not be honoured —
      // that would turn a successful login into an open redirect.
      const next = searchParams.get('next')
      const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/'
      router.push(target)
      router.refresh()
    } catch {
      // The backend deliberately returns the same message for "no such user"
      // and "wrong password", so we cannot be more specific here — and should
      // not be: telling a stranger which emails exist is a real leak.
      setError(
        mode === 'signup'
          ? 'Could not create that account. Try a different email.'
          : 'Invalid email or password.',
      )
    } finally {
      setBusy(false)
    }
  }

  const signup = mode === 'signup'

  function switchMode() {
    setMode(signup ? 'login' : 'signup')
    setError(null)
  }

  return (
    <div className="flex min-h-screen flex-col px-6 py-8 sm:px-10">
      <Logo />

      {/* A plain column with left-aligned text — no card, no box, no tab
          switcher — sitting slightly above centre. The brand lives in the
          corner and the backend address in the footer, the way a tool's own
          front door reads, rather than a generic auth widget. */}
      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center pb-[12vh]">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">
          {signup ? 'Create an organisation' : 'Sign in'}
        </h1>
        <p className="mt-1.5 text-[13px] text-ink-faint">
          {signup
            ? 'You will be its owner. Services and API keys are added from Settings.'
            : 'Traces, service map and incidents for your organisation.'}
        </p>

        <form onSubmit={submit} className="mt-8 space-y-4">
          {signup && (
            <div>
              <label htmlFor="org" className={fieldLabel}>Organisation name</label>
              <input
                id="org"
                value={orgName}
                onChange={e => setOrgName(e.target.value)}
                required
                autoComplete="organization"
                placeholder="Acme Inc"
                className={input}
              />
            </div>
          )}

          <div>
            <label htmlFor="email" className={fieldLabel}>Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoComplete="email"
              placeholder="you@company.com"
              className={input}
            />
          </div>

          <div>
            <label htmlFor="password" className={fieldLabel}>Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              autoComplete={signup ? 'new-password' : 'current-password'}
              // Matches the backend's rule, so the user is told here instead of
              // getting a 422 back from the API.
              minLength={signup ? 8 : 1}
              placeholder={signup ? 'At least 8 characters' : ''}
              className={input}
            />
          </div>

          {error && (
            <p role="alert" className="text-[13px] text-err">
              {error}
            </p>
          )}

          <button type="submit" disabled={busy} className={`${button.primary} h-9 w-full`}>
            {busy
              ? signup ? 'Creating…' : 'Signing in…'
              : signup ? 'Create organisation' : 'Sign in'}
          </button>
        </form>

        <p className="mt-6 text-[13px] text-ink-faint">
          {signup ? 'Already have an account?' : 'New to Stacklens?'}{' '}
          <button type="button" onClick={switchMode} className="text-ink-muted underline decoration-line-strong underline-offset-4 transition-colors hover:text-ink hover:decoration-ink-faint">
            {signup ? 'Sign in' : 'Create an organisation'}
          </button>
        </p>
      </main>

      <footer className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-faint">
        <span>
          Backend <span className="font-mono">{BACKEND_URL}</span>
        </span>
        <span>
          First run? <code className="font-mono text-ink-muted">python bootstrap.py</code> creates a
          demo account.
        </span>
      </footer>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  )
}
