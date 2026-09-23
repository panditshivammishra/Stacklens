'use client' // Error boundaries must be Client Components

import { useEffect } from 'react'
import { button } from '../../components/ui'

// Catches anything that throws while rendering a page inside the app shell, so
// the nav bar stays usable and the user gets a way to retry instead of a blank
// screen. In development the Next.js error overlay still appears on top of this
// with the full stack trace — this is what a user sees in production.
//
// Next.js 16.2 passes `unstable_retry`, which re-fetches the page's data and
// renders it again. (The older `reset` only re-renders with the same data, which
// cannot fix a failed fetch.)
export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string }
  unstable_retry: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div className="max-w-md py-16">
      <p className="font-mono text-[12px] text-err">error</p>
      <h1 className="mt-2 text-[17px] font-semibold tracking-tight text-ink">This page failed to load</h1>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
        Usually the backend is unreachable or restarting. Your data is not affected.
      </p>
      {error.digest && (
        <p className="mt-3 font-mono text-[12px] text-ink-faint">ref {error.digest}</p>
      )}
      <button onClick={() => unstable_retry()} className={`${button.secondary} mt-6`}>
        Try again
      </button>
    </div>
  )
}
