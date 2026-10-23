import type { EngineStatus } from '../../shared/contracts'

export type Tab = 'dashboard' | 'library' | 'favorites' | 'tasks' | 'settings' | 'faq' | 'guide'
export type Perform = (label: string, action: () => Promise<unknown>) => Promise<void>
export const statusLabels: Record<EngineStatus, string> = {
  stopped: '未启动',
  starting: '正在加载',
  ready: '后台就绪',
  visible: '窗口已打开',
  failed: '需要检查'
}
export class CommandError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
  }
}
export async function call<T>(
  promise: Promise<{ ok: true; data: T } | { ok: false; error: { code?: string; message: string } }>
): Promise<T> {
  const result = await promise
  if (!result.ok) throw new CommandError(result.error.code ?? 'INTERNAL_ERROR', result.error.message)
  return result.data
}
