import Link from 'next/link'
import { Logo } from '../components/Logo'

// Any URL that matches no route at all. It renders outside the signed-in shell
// (the visitor may not be signed in), so it carries its own logo.
export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col px-6 py-8 sm:px-10">
      <Logo />
      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center pb-[12vh]">
        <p className="font-mono text-[12px] text-ink-faint">404</p>
        <h1 className="mt-2 text-[22px] font-semibold tracking-tight text-ink">Page not found</h1>
        <p className="mt-2 text-[13px] text-ink-muted">There is no page at this address.</p>
        <Link href="/" className="mt-6 text-[13px] text-ink-muted underline decoration-line-strong underline-offset-4 hover:text-ink">
          Go to Stacklens
        </Link>
      </main>
    </div>
  )
}
