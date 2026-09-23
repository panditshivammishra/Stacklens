// The mark is a trace waterfall in miniature — a root span, a child that starts
// later and finishes sooner, and a grandchild inside that — which is the one
// picture this whole product exists to draw. Same drawing as app/icon.svg
// (the browser-tab icon), minus the dark tile behind it.
export function Logo({ size = 18, wordmark = true }: { size?: number; wordmark?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <svg width={size} height={size} viewBox="6 8 20 16" aria-hidden className="shrink-0">
        <rect x="6" y="8" width="20" height="4" rx="2" fill="var(--ink)" />
        <rect x="10" y="14" width="13" height="4" rx="2" fill="var(--signal)" />
        <rect x="14" y="20" width="6" height="4" rx="2" fill="var(--signal)" fillOpacity=".55" />
      </svg>
      {wordmark && (
        <span className="text-[15px] font-semibold tracking-tight text-ink">stacklens</span>
      )}
    </span>
  )
}
