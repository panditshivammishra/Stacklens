import Link from 'next/link'

// Shown when a page inside the signed-in app calls notFound() — in practice a
// trace link whose trace does not exist, or belongs to another organisation.
// The backend answers both with the same 404 on purpose (so trace ids cannot
// be probed), which is why this page does not try to say which one it was.
export default function NotFound() {
  return (
    <div className="max-w-md py-16">
      <p className="font-mono text-[12px] text-ink-faint">404</p>
      <h1 className="mt-2 text-[17px] font-semibold tracking-tight text-ink">Nothing here</h1>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
        That trace either does not exist or is not visible to your organisation. Recent
        traces are linked from the live feed on the overview.
      </p>
      <Link href="/" className="mt-6 inline-block text-[13px] text-ink-muted underline decoration-line-strong underline-offset-4 hover:text-ink">
        Back to overview
      </Link>
    </div>
  )
}
