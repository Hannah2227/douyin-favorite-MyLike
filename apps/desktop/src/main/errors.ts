import type { ResponseRule } from '../shared/runtime-events'

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly rule?: ResponseRule,
    public readonly retryAt?: number
  ) {
    super(message)
  }
}

export function publicError(error: unknown): { code: string; message: string; retryAt?: number } {
  if (error instanceof AppError)
    return {
      code: error.code,
      message: error.message,
      ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt })
    }
  // Do not expose platform URLs, signed requests, response bodies or native stacks to UI.
  console.error('[MyLike] Unexpected operation failure', error instanceof Error ? error.name : 'unknown')
  return { code: 'INTERNAL_ERROR', message: '操作未完成，请重试；本地数据不会因此重置。' }
}
