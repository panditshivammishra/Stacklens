import type { ReactNode } from 'react'
import { serviceName } from '../lib/api'
import { serviceColor } from '../lib/format'

// ─────────────────────────────────────────────────────────────────────────────
// The small set of building blocks every page is made from.
//
// Keeping them here is what makes the app look like ONE product rather than a
// set of pages that each invented their own card, heading and button. If a
// table row needs to change height, it changes here and every table follows.
//
// Nothing in this file uses hooks, so it works in server components (most
// pages) and client components (settings, login, the live feed) alike.
// ─────────────────────────────────────────────────────────────────────────────

export function PageHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
      <h1 className="text-[17px] font-semibold tracking-tight text-ink">{title}</h1>
      {children && (
        <div className="flex items-center gap-4 text-[12px] text-ink-faint">{children}</div>
      )}
    </div>
  )
}

export function SectionHeader({
  title,
  count,
  children,
}: {
  title: ReactNode
  count?: number
  children?: ReactNode
}) {
  return (
    <div className="mb-2 flex min-h-6 items-center justify-between gap-4">
      <h2 className="text-[13px] font-medium whitespace-nowrap text-ink-muted">
        {title}
        {count != null && <span className="ml-2 font-mono text-ink-faint">{count}</span>}
      </h2>
      {children}
    </div>
  )
}

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded border border-line bg-panel ${className}`}>{children}</div>
}

/** A calm "nothing here yet" — says what is missing and what makes it appear. */
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-5 py-8">
      <p className="text-[13px] text-ink-muted">{title}</p>
      {children && <div className="mt-1 max-w-prose text-[13px] text-ink-faint">{children}</div>}
    </div>
  )
}

/** Service name with its colour mark. Takes the org-prefixed id or a bare name. */
export function ServiceTag({ id, className = '' }: { id: string; className?: string }) {
  const name = serviceName(id ?? '')
  return (
    <span className={`inline-flex min-w-0 items-center gap-2 ${className}`}>
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-xs"
        style={{ background: serviceColor(name) }}
      />
      <span className="truncate font-mono text-[12.5px] text-ink">{name}</span>
    </span>
  )
}

export function StatusMark({ status }: { status: 'ok' | 'error' | string }) {
  const failed = status === 'error'
  return (
    <span className={`inline-flex items-center gap-1.5 ${failed ? 'text-err' : 'text-ink-faint'}`}>
      <span aria-hidden className={`size-1.5 rounded-full ${failed ? 'bg-err' : 'bg-ok/70'}`} />
      {failed ? 'error' : 'ok'}
    </span>
  )
}

const TONE = {
  default: 'text-ink',
  ok: 'text-ok',
  warn: 'text-warn',
  err: 'text-err',
} as const

export type Tone = keyof typeof TONE

/** One number in the metric strip: small label, large mono value, optional unit. */
export function Metric({
  label,
  value,
  unit,
  sub,
  tone = 'default',
}: {
  label: string
  value: ReactNode
  unit?: string
  sub?: ReactNode
  tone?: Tone
}) {
  return (
    <div className="bg-panel px-4 py-3.5">
      <div className="text-[12px] text-ink-faint">{label}</div>
      <div className={`mt-1.5 flex items-baseline gap-1 font-mono text-[26px] leading-none tracking-tight ${TONE[tone]}`}>
        {value}
        {unit && <span className="text-[13px] tracking-normal text-ink-faint">{unit}</span>}
      </div>
      {sub && <div className="mt-2 text-[12px] text-ink-faint">{sub}</div>}
    </div>
  )
}

// Class strings for the pieces that are plain elements rather than components.
// Tailwind only generates classes it can find written out in full, which is
// why these are literal strings and not assembled from parts at runtime.
export const table = {
  root: 'w-full border-collapse text-[13px]',
  headRow: 'border-b border-line text-left text-[12px] text-ink-faint',
  th: 'px-3 py-2 font-medium first:pl-4 last:pr-4',
  row: 'border-b border-line last:border-0 transition-colors hover:bg-raised/60',
  td: 'px-3 py-2 first:pl-4 last:pr-4',
}

export const button = {
  primary:
    'inline-flex h-8 items-center justify-center gap-2 rounded-[3px] bg-ink px-3 text-[13px] font-medium text-canvas transition-colors hover:bg-ink/85 disabled:pointer-events-none disabled:opacity-50',
  secondary:
    'inline-flex h-8 items-center justify-center gap-2 rounded-[3px] border border-line-strong px-3 text-[13px] text-ink-muted transition-colors hover:border-ink-faint hover:text-ink disabled:pointer-events-none disabled:opacity-50',
  quiet:
    'text-[13px] text-ink-muted transition-colors hover:text-ink disabled:pointer-events-none disabled:opacity-50',
  danger:
    'text-[13px] text-err/85 transition-colors hover:text-err disabled:pointer-events-none disabled:opacity-50',
}

export const input =
  'h-9 w-full rounded-[3px] border border-line-strong bg-canvas px-3 text-[13px] text-ink transition-colors placeholder:text-ink-faint/70 hover:border-ink-faint/70 focus:border-ink-faint focus-visible:outline-offset-0'

export const fieldLabel = 'mb-1.5 block text-[12px] font-medium text-ink-muted'
