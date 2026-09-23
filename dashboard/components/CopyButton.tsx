'use client'

import { useEffect, useState } from 'react'

// Copy a value to the clipboard and say so for a moment.
//
// navigator.clipboard only exists in a "secure context" — https, or localhost.
// On plain http from another machine it is undefined, so we check and say
// "Copy failed" rather than throwing; the value is still on screen to select.
export function CopyButton({
  value,
  label = 'Copy',
  className = '',
}: {
  value: string
  label?: string
  className?: string
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    if (state === 'idle') return
    const t = setTimeout(() => setState('idle'), 1600)
    return () => clearTimeout(t)
  }, [state])

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setState('copied')
    } catch {
      setState('failed')
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label}
      className={`rounded-[3px] px-1.5 py-0.5 font-sans text-[12px] transition-colors ${
        state === 'copied' ? 'text-ok' : state === 'failed' ? 'text-err' : 'text-ink-muted hover:bg-raised hover:text-ink'
      } ${className}`}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
    </button>
  )
}
