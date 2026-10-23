export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) return { code: error.code, message: error.message }
  // Do not expose platform URLs, signed requests, response bodies or native stacks to UI.
  console.error('[MyLike] Unexpected operation failure', error instanceof Error ? error.name : 'unknown')
  return { code: 'INTERNAL_ERROR', message: '操作未完成，请重试；本地数据不会因此重置。' }
}
