import type { Operation } from './page-request'
import { AppError } from '../errors'
import type { ResponseRule } from '../../shared/runtime-events'

// Adapted from the response semantics of Evil0ctal/Douyin_TikTok_Download_API
// v5 (b5505e3). Only public field names and outcomes cross this boundary.
type Payload = Record<string, unknown>
export type ResponseContext = { operation?: Operation; workId?: string }
const riskCodes = new Set(['8', '2154', '2156', '10000', '10001'])
const envelopeKeys = new Set(['status_code', 'status_msg', 'message', 'extra', 'log_pb', 'logid', 'log_id'])
export const contentRead = (operation?: Operation) =>
  operation === 'likes' || operation === 'detail' || collectionRead(operation)
export function bareEnvelope(data: Payload, operation?: Operation): boolean {
  const keys = Object.keys(data)
  return contentRead(operation) && keys.length > 0 && keys.every((key) => envelopeKeys.has(key))
}
export const collectionRead = (operation?: Operation) =>
  operation === 'favorites' || operation === 'folders' || operation === 'folderItems'
const record = (value: unknown): Payload | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Payload) : null
const nonempty = (value: unknown) =>
  typeof value === 'string'
    ? !!value.trim()
    : typeof value === 'object' && value !== null
      ? Object.keys(value).length > 0
      : !!value
const id = (value: unknown): string | null =>
  typeof value === 'string' && /^\d{1,30}$/.test(value)
    ? value
    : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : null

export function assertBusinessResponse(data: Payload, context: ResponseContext = {}): void {
  const code = data.status_code == null ? null : String(data.status_code)
  if (
    ['captcha', 'verify_page', 'verify_center_decision_conf'].some((key) => nonempty(data[key])) ||
    (code !== null &&
      code !== '0' &&
      /滑块|安全验证|验证码|captcha|verification required/i.test(
        String(data.status_msg ?? data.message ?? '')
      ))
  )
    throw new AppError(
      'VERIFICATION_REQUIRED',
      '平台要求人工验证，请在抖音窗口完成后继续。',
      'envelope.verification'
    )
  // An explicit business rejection of a write is known, unlike a missing reply.
  if (code === '2053' && context.workId && ['detail', 'favoriteRemove'].includes(context.operation ?? ''))
    throw new AppError('CONTENT_UNAVAILABLE', '平台明确返回此作品当前不可访问。', 'envelope.business_code')
  if (riskCodes.has(code ?? '') && context.operation !== 'self')
    throw new AppError(
      'UPSTREAM_RISK_CONTROL',
      '平台暂时限制了当前接口的读取，已暂停；请稍候或检查抖音窗口。',
      'envelope.risk_code'
    )
  if (code !== null && code !== '0')
    throw new AppError(
      'API_REJECTED',
      '平台拒绝了这次请求，请检查登录、人工验证或稍后重试。',
      'envelope.rejected'
    )
  // A status-only read is withheld data, never a confirmed end. Writes may
  // legitimately acknowledge success with status_code=0 and no other fields.
  if (bareEnvelope(data, context.operation))
    throw new AppError(
      'UPSTREAM_RISK_CONTROL',
      '平台只返回状态信息，没有提供列表或详情；已保留进度，未确认采集末尾。',
      'payload.bare_envelope'
    )
}

export function assertDetailResponse(data: Payload, workId: string): void {
  assertBusinessResponse(data, { operation: 'detail', workId })
  const detail = record(data.aweme_detail)
  if (detail && Object.keys(detail).length) {
    if (id(detail.aweme_id) !== workId)
      throw new AppError(
        'UPSTREAM_CHANGED',
        '作品详情的 aweme_id 缺失或与目标作品不一致。',
        'payload.target_mismatch'
      )
    return
  }
  if (!Object.hasOwn(data, 'aweme_detail') || (data.aweme_detail != null && !detail))
    throw new AppError(
      'UPSTREAM_CHANGED',
      '接口缺少有效的 aweme_detail，响应结构需要检查。',
      'payload.schema'
    )
  // A reason about another post says nothing about this post. Never skip it.
  const filter = record(data.filter_detail)
  const named = filter?.aweme_id
  if (named != null && id(named) !== workId)
    throw new AppError(
      'UPSTREAM_CHANGED',
      'filter_detail.aweme_id 与请求目标不一致。',
      'payload.target_mismatch'
    )
  if (filter && (nonempty(filter.filter_reason) || nonempty(filter.detail_msg) || id(named) === workId)) {
    const reason = filter.filter_reason
    throw new AppError(
      'CONTENT_UNAVAILABLE',
      reason === 'status_self_see'
        ? '平台明确返回此作品仅作者可见，当前无法读取。'
        : '平台已在 filter_detail 中明确说明此作品当前不可访问。',
      'payload.explained_absence'
    )
  }
  throw new AppError(
    'UPSTREAM_RISK_CONTROL',
    '作品详情为空且没有平台给出的作品级原因，可能为临时限制，已暂停并保留本地记录。',
    'payload.unexplained_absence'
  )
}

export function failureRule(error: unknown): ResponseRule | undefined {
  if (!(error instanceof AppError)) return undefined
  if (error.rule) return error.rule
  return (
    {
      AUTH_REQUIRED: 'page.login',
      VERIFICATION_REQUIRED: 'page.challenge',
      RATE_LIMITED: 'http.rate_limit',
      NETWORK_ERROR: 'transport.network',
      TIMEOUT: 'transport.timeout',
      BROWSER_NOT_READY: 'page.not_ready',
      BROWSER_CRASHED: 'page.crashed',
      PAGE_CHANGED: 'page.changed',
      UPSTREAM_CHANGED: 'payload.schema',
      UPSTREAM_RISK_CONTROL: 'envelope.risk_code',
      CONTENT_UNAVAILABLE: 'payload.explained_absence',
      EMPTY_RESPONSE: 'body.empty',
      INVALID_RESPONSE: 'payload.schema'
    } as Partial<Record<string, ResponseRule>>
  )[error.code]
}

export function failureResponseType(code?: string): string | undefined {
  return (
    {
      CONTENT_UNAVAILABLE: 'content-unavailable',
      UPSTREAM_CHANGED: 'schema-changed',
      UPSTREAM_RISK_CONTROL: 'risk-control'
    } as Record<string, string>
  )[code ?? '']
}
