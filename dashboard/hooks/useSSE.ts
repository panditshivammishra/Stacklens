'use client'

// ─────────────────────────────────────────────────────────────────────────────
// CONCEPT: Server-Sent Events (SSE) in React
//
// EventSource is a browser API that keeps an HTTP connection open and fires
// events whenever the server writes "data: ...\n\n".
// Unlike WebSockets, SSE is one-way (server → client) and auto-reconnects.
//
// Why use a custom hook?
//   Encapsulates the EventSource lifecycle: open on mount, close on unmount.
//   The caller just gets a callback with each event — no connection management.
//
// INTERVIEW: "How does your dashboard get live data?"
//   SSE over /api/sse. Each time the span worker persists a batch, it calls
//   broadcast() which writes to all open SSE connections. The dashboard
//   React state updates trigger a re-render without any polling.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react'

const BASE = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:4001'

// The hook also reports the connection's state, so the UI can say "Live" only
// when it actually is. EventSource exposes this through three callbacks:
//   onopen  → the stream is up
//   onerror + readyState CONNECTING → dropped, the browser is already retrying
//   onerror + readyState CLOSED     → the browser has given up (e.g. the server
//                                      answered 401), and will not retry
export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'closed'

export function useSSE<T>(
  event: string,
  onMessage: (data: T) => void
): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>('connecting')

  useEffect(() => {
    // ─────────────────────────────────────────────────────────────────────────
    // AUTH ON A STREAM: withCredentials is the whole trick.
    //
    // EventSource cannot set headers — there is no way to attach
    // "Authorization: Bearer …" to it. That single limitation is why the entire
    // backend authenticates with a cookie instead of a header: the browser
    // attaches cookies on its own.
    //
    // But for a CROSS-ORIGIN stream (dashboard :3000 → API :4001) it only does
    // so when we opt in with withCredentials — and the server must answer with
    // a named origin plus allow_credentials. A wildcard "*" is rejected outright
    // by the browser here, which is exactly why main.py names DASHBOARD_ORIGIN.
    // ─────────────────────────────────────────────────────────────────────────
    const es = new EventSource(`${BASE}/api/sse`, { withCredentials: true })

    es.addEventListener(event, (e: MessageEvent) => {
      try {
        onMessage(JSON.parse(e.data) as T)
      } catch {
        // ignore malformed events
      }
    })

    es.onopen = () => setStatus('live')

    es.onerror = () => {
      // EventSource auto-reconnects after most errors — we only report it.
      setStatus(es.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting')
    }

    return () => es.close()
  }, [event, onMessage])

  return status
}
