import { z } from 'zod'

export const runtimeEventSchema = z.object({
  id: z.string().uuid(),
  time: z.number().int().nonnegative(),
  kind: z.enum(['request', 'task', 'auth', 'engine']),
  message: z.string().max(600),
  operation: z.string().max(40).optional(),
  responseType: z.string().max(40).optional(),
  status: z.number().int().optional(),
  code: z.string().max(60).optional(),
  durationMs: z.number().int().nonnegative().optional(),
  count: z.number().int().nonnegative().optional()
})
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>
export type RuntimeEventInput = Omit<RuntimeEvent, 'id' | 'time'>
export function runtimeEventCategory(event: RuntimeEventInput): 'exception' | 'end' | null {
  if (
    event.code === 'END_CONFIRMED' ||
    (event.kind === 'task' && event.message.includes('正常完成') && event.message.includes('末尾'))
  )
    return 'end'
  if (['CANCELLED', 'LOGIN_PENDING'].includes(event.code ?? '')) return null
  if (
    event.code ||
    ['empty-body', 'invalid-json', 'html', 'http-error', 'api-error', 'empty-list', 'oversized'].includes(
      event.responseType ?? ''
    )
  )
    return 'exception'
  return null
}
export const responseLabels: Record<string, string> = {
  'no-response': '未取得响应',
  'empty-body': '空响应',
  'invalid-json': '无效 JSON',
  html: 'HTML 页面',
  'http-error': 'HTTP 拒绝',
  'api-error': '业务拒绝',
  'empty-list': '空列表但仍有下一页',
  'terminal-list': '列表结束标记',
  list: '作品列表',
  identity: '身份 JSON',
  json: 'JSON',
  oversized: '响应过大'
}

export const operationLabels: Record<string, string> = {
  self: '身份核验',
  likes: '喜欢列表',
  favorites: '收藏作品',
  folders: '收藏夹列表',
  folderItems: '收藏夹作品',
  detail: '作品详情',
  unlike: '取消点赞',
  favoriteRemove: '取消收藏',
  favoriteAdd: '收藏作品',
  favoriteFolderAdd: '加入收藏夹',
  favoriteFolderCreate: '新建收藏夹'
}
