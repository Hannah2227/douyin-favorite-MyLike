import { z } from 'zod'

export const responseRules = [
  'http.auth',
  'http.rate_limit',
  'http.error',
  'body.empty',
  'body.html',
  'body.invalid_json',
  'body.oversized',
  'envelope.verification',
  'envelope.risk_code',
  'envelope.business_code',
  'envelope.rejected',
  'payload.empty_object',
  'payload.bare_envelope',
  'payload.invalid_type',
  'payload.schema',
  'payload.target_mismatch',
  'payload.explained_absence',
  'payload.unexplained_absence',
  'payload.favorite_state',
  'payload.identity',
  'page.login',
  'page.challenge',
  'page.not_ready',
  'page.changed',
  'page.crashed',
  'transport.timeout',
  'transport.network',
  'request.mismatch'
] as const
export type ResponseRule = (typeof responseRules)[number]
export const responseRuleLabels: Record<ResponseRule, string> = {
  'http.auth': 'HTTP 要求登录或验证',
  'http.rate_limit': 'HTTP 明确限流',
  'http.error': 'HTTP 请求失败',
  'body.empty': '响应正文为空',
  'body.html': '接口返回验证网页',
  'body.invalid_json': '响应不是有效 JSON',
  'body.oversized': '响应超过大小限制',
  'envelope.verification': '平台明确要求人工验证',
  'envelope.risk_code': '平台返回受限状态码',
  'envelope.business_code': '平台明确返回作品不可访问',
  'envelope.rejected': '平台明确拒绝请求',
  'payload.empty_object': 'JSON 对象为空',
  'payload.bare_envelope': '只有状态信息，没有业务数据',
  'payload.invalid_type': '响应顶层类型错误',
  'payload.schema': '必要字段或分页结构变化',
  'payload.target_mismatch': '响应与目标作品不符',
  'payload.explained_absence': '平台说明作品不可访问',
  'payload.unexplained_absence': '作品详情为空且没有说明',
  'payload.favorite_state': '缺少明确收藏状态',
  'payload.identity': '未取得可信登录身份',
  'page.login': '页面需要登录',
  'page.challenge': '页面出现人工验证',
  'page.not_ready': '抖音页面未就绪',
  'page.changed': '请求途中页面已导航',
  'page.crashed': '抖音页面进程已退出',
  'transport.timeout': '请求超时',
  'transport.network': '网络请求未完成',
  'request.mismatch': '请求与返回关联不一致'
}

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
  count: z.number().int().nonnegative().optional(),
  shape: z.string().max(250).optional(),
  rule: z.enum(responseRules).optional(),
  platformCode: z
    .string()
    .regex(/^-?\d{1,12}$/)
    .optional()
})
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>
export type RuntimeEventInput = Omit<RuntimeEvent, 'id' | 'time'>
export function runtimeEventCategory(event: RuntimeEventInput): 'exception' | 'end' | null {
  if (
    [
      'CANCELLED',
      'LOGIN_PENDING',
      'EMPTY_PAGE_PROBE',
      'INVALID_ITEMS',
      'CONTENT_UNAVAILABLE',
      'ITEM_SKIPPED'
    ].includes(event.code ?? '') ||
    (event.kind !== 'task' && event.code === 'PAGE_CHANGED') ||
    (event.kind === 'auth' &&
      [
        'AUTH_REQUIRED',
        'VERIFICATION_REQUIRED',
        'RATE_LIMITED',
        'API_REJECTED',
        'UPSTREAM_RISK_CONTROL'
      ].includes(event.code ?? '')) ||
    (event.kind === 'request' && event.operation === 'self' && event.code === 'AUTH_REQUIRED') ||
    // Earlier versions stored retry notices as failures. They remain progress,
    // even when reading an existing v2.0.2 history.
    (event.kind === 'task' &&
      /^(喜欢采集暂缓 .+秒后重试同一断点|收藏页面尚未就绪，将恢复 SDK 页面后复查一次)/.test(event.message))
  )
    return null
  if (
    event.code === 'END_CONFIRMED' ||
    (event.kind === 'task' && event.message.includes('正常完成') && event.message.includes('末尾'))
  )
    return ['folders', 'folderItems'].includes(event.operation ?? '') ? null : 'end'
  if (event.code) return 'exception'
  return null
}
export const responseLabels: Record<string, string> = {
  'content-unavailable': '作品明确不可访问',
  'schema-changed': '接口结构变化',
  'risk-control': '接口暂时受限',
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
