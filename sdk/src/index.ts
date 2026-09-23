import { init } from './tracer'
import { instrumentHttp } from './instrumentations/http'
import type { StacklensConfig } from '@stacklens/types'

export function stacklens(config: StacklensConfig): void {
  init(config)
  instrumentHttp()
}

export { startSpan, endSpan, runWithSpan, getCurrentContext, runInContext } from './tracer'
export { stacklensMiddleware } from './middleware'
export type { Span, SpanContext, StacklensConfig } from '@stacklens/types'
