import JSONbigFactory from 'json-bigint'
import type { Media, Work, FavoriteFolder } from '../../shared/contracts'
import { AppError } from '../errors'
import {
  assertBusinessResponse,
  assertDetailResponse,
  contentRead,
  collectionRead,
  type ResponseContext
} from './response-policy'

const JSONbig = JSONbigFactory({ storeAsString: true, protoAction: 'error', constructorAction: 'error' })
type Obj = Record<string, any>

export function safeMediaUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 16_384) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
    const hosts = [
      'douyin.com',
      'douyinpic.com',
      'douyincdn.com',
      'douyinstatic.com',
      'douyinvod.com',
      'byteimg.com',
      'ibytedtos.com',
      'bytecdn.cn',
      'bytedance.com',
      'bytedance.net',
      'pstatp.com',
      'snssdk.com',
      'bytegoofy.com'
    ]
    return hosts.some((host) => url.hostname === host || url.hostname.endsWith('.' + host)) ? url.href : null
  } catch {
    return null
  }
}
function urls(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(safeMediaUrl).filter((u): u is string => !!u))]
}
function first(value: unknown): string | null {
  return urls(value)[0] ?? null
}
function pageCursor(value: unknown, hasMore: boolean, collection = false): string {
  let cursor: string
  try {
    cursor = numericId(value ?? (hasMore ? undefined : '0'))
  } catch (error) {
    if (!collection) throw error
    throw new AppError('UPSTREAM_CHANGED', '收藏接口缺少有效分页游标，已保留断点。')
  }
  if (hasMore && /^0+$/.test(cursor))
    throw new AppError(
      collection ? 'UPSTREAM_CHANGED' : 'INVALID_RESPONSE',
      '仍有更多内容但分页游标已归零，已保留断点。'
    )
  return cursor
}
function object(value: unknown): Obj {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {}
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
export function numericId(value: unknown): string {
  const id =
    typeof value === 'string'
      ? value
      : typeof value === 'number' && Number.isSafeInteger(value)
        ? String(value)
        : ''
  if (!/^\d{1,30}$/.test(id)) throw new AppError('INVALID_RESPONSE', '平台返回了无效的作品标识或分页游标。')
  return id
}

export function parseResponse(body: string, status: number, context: ResponseContext = {}): Obj {
  if (body.length > 16 * 1024 * 1024)
    throw new AppError('INVALID_RESPONSE', '接口响应过大，已停止处理。', 'body.oversized')
  if (status === 401 || status === 403)
    throw new AppError('AUTH_REQUIRED', '登录或验证状态需要处理，请打开抖音窗口。', 'http.auth')
  if (status === 429) throw new AppError('RATE_LIMITED', '接口暂时限流，请稍后再试。', 'http.rate_limit')
  if (status < 200 || status >= 300)
    throw new AppError('NETWORK_ERROR', '平台请求未成功，请稍后重试。', 'http.error')
  if (/<(?:html|!doctype)/i.test(body.slice(0, 500)))
    throw new AppError(
      'VERIFICATION_REQUIRED',
      '接口返回网页，请打开抖音窗口检查登录或人工验证。',
      'body.html'
    )
  if (!body.trim())
    throw new AppError(
      collectionRead(context.operation) || context.operation === 'detail'
        ? 'UPSTREAM_RISK_CONTROL'
        : 'EMPTY_RESPONSE',
      '平台返回空响应，未确认列表末尾，进度未推进。',
      'body.empty'
    )
  let decoded: unknown
  try {
    decoded = JSONbig.parse(body)
  } catch {
    throw new AppError('INVALID_RESPONSE', '接口没有返回有效 JSON，当前进度未推进。', 'body.invalid_json')
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded))
    throw new AppError(
      contentRead(context.operation) ? 'UPSTREAM_CHANGED' : 'INVALID_RESPONSE',
      '接口顶层没有返回有效对象，响应结构需要检查。',
      'payload.invalid_type'
    )
  const data = decoded as Obj
  if (!Object.keys(data).length)
    throw new AppError(
      collectionRead(context.operation) || context.operation === 'detail'
        ? 'UPSTREAM_RISK_CONTROL'
        : 'EMPTY_RESPONSE',
      '平台返回空响应，未确认列表末尾，进度未推进。',
      'payload.empty_object'
    )
  assertBusinessResponse(data, context)
  if (context.operation === 'detail' && context.workId) assertDetailResponse(data, context.workId)
  return data
}

export function parseLikeState(data: Obj, workId: string): boolean {
  assertDetailResponse(data, workId)
  const detail = object(data.aweme_detail)
  if (numericId(detail.aweme_id) !== workId)
    throw new AppError('INVALID_RESPONSE', '核验详情与目标作品不一致。')
  if (detail.user_digged === 1 || detail.user_digged === '1') return true
  if (detail.user_digged === 0 || detail.user_digged === '0') return false
  throw new AppError('LIKE_STATE_UNKNOWN', '平台未返回明确的当前点赞状态，请在作品原页核对。')
}
export function parseUnlikeResult(data: Obj): void {
  parseWriteResult(data)
}
export function parseWriteResult(data: Obj): void {
  if (String(data.status_code) !== '0') throw new AppError('WRITE_UNCONFIRMED', '平台未返回明确的成功确认。')
}
export function parseFavoriteState(
  data: Obj,
  workId: string
): { collected: boolean; work: Work; type: string } {
  assertDetailResponse(data, workId)
  const detail = object(data.aweme_detail)
  if (![0, 1, '0', '1'].includes(detail.collect_stat))
    throw new AppError(
      'UPSTREAM_CHANGED',
      '平台未返回明确的收藏状态 collect_stat，请重新读取或在原页核对。',
      'payload.favorite_state'
    )
  return {
    collected: String(detail.collect_stat) === '1',
    work: parseWork(detail),
    type: detail.aweme_type == null ? '0' : numericId(detail.aweme_type)
  }
}
export function parseFavoriteFolder(value: unknown): Omit<FavoriteFolder, 'localCount'> {
  const entry = object(value)
  return {
    id: numericId(entry.collects_id_str ?? entry.collects_id),
    title: text(entry.collects_name ?? entry.name).slice(0, 500) || '未命名收藏夹',
    remoteCount: Math.max(0, Number(entry.aweme_count ?? entry.total_number ?? entry.total ?? 0) || 0),
    ...(entry.status == null ? {} : { private: String(entry.status) === '0' }),
    ...(entry.collects_cover == null ? {} : { coverUrl: first(entry.collects_cover?.url_list) })
  }
}
export function parseWork(value: unknown): Work {
  const data = object(value),
    video = object(data.video),
    author = object(data.author)
  const images = Array.isArray(data.images) ? data.images : []
  return {
    id: numericId(data.aweme_id),
    title: text(data.desc).slice(0, 20_000),
    author: text(author.nickname).slice(0, 500),
    publishedAt: Number.isSafeInteger(data.create_time) ? data.create_time : 0,
    coverUrl:
      first(video.cover?.url_list) ?? first(video.origin_cover?.url_list) ?? first(images[0]?.url_list),
    mediaType: images.length ? 'gallery' : 'video',
    isLive: images.some((image: unknown) => !!(object(image).video || object(image).live_image))
  }
}
export function parseLikedPage(
  data: Obj,
  options: { allowEmpty?: boolean } = {}
): { items: Work[]; cursor: string; hasMore: boolean } {
  assertBusinessResponse(data, { operation: 'likes' })
  if (!Array.isArray(data.aweme_list))
    throw new AppError('INVALID_RESPONSE', '喜欢列表缺少必要字段，进度未推进。')
  if (![0, 1, false, true, '0', '1'].includes(data.has_more))
    throw new AppError('INVALID_RESPONSE', '接口未提供可信的分页结束标记。')
  const hasMore = data.has_more === 1 || data.has_more === true || data.has_more === '1'
  if (!data.aweme_list.length && hasMore) {
    if (!options.allowEmpty)
      throw new AppError('EMPTY_PAGE', '平台返回空列表但仍标记更多，未确认末尾，已保留断点。')
    if (data.max_cursor == null || /^0+$/.test(String(data.max_cursor)))
      throw new AppError('EMPTY_PAGE', '空页没有提供可继续的游标。')
  }
  const cursor = pageCursor(data.max_cursor, hasMore)
  return { items: data.aweme_list.map(parseWork), cursor, hasMore }
}
export function parseIdentity(data: Obj): { remoteId: string; nickname: string; avatarUrl: string | null } {
  const user = object(data.user)
  if (typeof user.sec_uid !== 'string' || !/^[A-Za-z0-9_-]{8,200}$/.test(user.sec_uid))
    throw new AppError(
      'AUTH_REQUIRED',
      '尚未取得登录身份，请在抖音窗口完成登录后重新核验。',
      'payload.identity'
    )
  return {
    remoteId: user.sec_uid,
    nickname: text(user.nickname),
    avatarUrl: first(user.avatar_thumb?.url_list)
  }
}
export interface CollectionPage {
  items: Work[]
  cursor: string
  hasMore: boolean
  skipped: { position: number; workId?: string }[]
  received: number
}
export function parseFavoritesPage(data: Obj, options: { allowEmpty?: boolean } = {}): CollectionPage {
  assertBusinessResponse(data, { operation: 'favorites' })
  const list = collectionList(data, 'aweme_list', '收藏作品')
  if (![0, 1, false, true, '0', '1'].includes(data.has_more))
    throw new AppError('UPSTREAM_CHANGED', '收藏接口缺少可信的分页结束标记。')
  const hasMore = [1, true, '1'].includes(data.has_more)
  const cursor = pageCursor(data.cursor ?? data.max_cursor, hasMore, true)
  if (hasMore && !list.length && !options.allowEmpty)
    throw new AppError('EMPTY_PAGE', '收藏返回空列表但仍标记更多，断点未推进。')
  const items: Work[] = [],
    skipped: CollectionPage['skipped'] = []
  for (const [position, value] of list.entries()) {
    try {
      items.push(parseWork(value))
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'INVALID_RESPONSE') throw error
      const id = object(value).aweme_id
      skipped.push({
        position: position + 1,
        ...(typeof id === 'string' && /^\d{1,30}$/.test(id) ? { workId: id } : {})
      })
    }
  }
  return { items, cursor, hasMore, skipped, received: list.length }
}
function collectionList(data: Obj, field: string, label: string): unknown[] {
  if (Array.isArray(data[field])) return data[field]
  // Empty collection endpoints can omit their array or return null. This is
  // only a candidate end when both business success and has_more=0 are explicit;
  // the collector still confirms it twice and the store protects nonempty folders.
  if (data[field] == null && String(data.status_code) === '0' && [0, false, '0'].includes(data.has_more))
    return []
  throw new AppError('UPSTREAM_CHANGED', `${label}列表缺少有效的作品或收藏夹数组，进度未推进。`)
}
export function parseFavoriteFolders(
  data: Obj,
  options: { allowEmpty?: boolean } = {}
): {
  folders: Omit<FavoriteFolder, 'localCount'>[]
  cursor: string
  hasMore: boolean
} {
  assertBusinessResponse(data, { operation: 'folders' })
  if (![0, 1, false, true, '0', '1'].includes(data.has_more))
    throw new AppError('UPSTREAM_CHANGED', '收藏夹接口缺少可信的列表或结束标记。')
  const list = collectionList(data, 'collects_list', '收藏夹')
  const hasMore = [1, true, '1'].includes(data.has_more)
  if (hasMore && !list.length && !options.allowEmpty)
    throw new AppError('EMPTY_PAGE', '收藏夹返回空列表但仍标记更多，断点未推进。')
  return {
    folders: list.map((value) => {
      try {
        return parseFavoriteFolder(value)
      } catch {
        throw new AppError('UPSTREAM_CHANGED', '收藏夹列表存在缺失或无效的收藏夹标识，原有分类保留。')
      }
    }),
    cursor: pageCursor(data.cursor ?? data.max_cursor, hasMore, true),
    hasMore
  }
}
export function parseMedia(data: Obj): Media {
  if (!data.aweme_detail)
    throw new AppError('WORK_UNAVAILABLE', '暂时无法取得作品详情，可能需要验证或作品已不可访问。')
  const value = object(data.aweme_detail),
    video = object(value.video),
    music = object(value.music)
  const videos = [
    ...new Set([
      ...urls(video.play_addr_h264?.url_list),
      ...(Array.isArray(video.bit_rate) ? video.bit_rate : [])
        .filter((rate: Obj) => !/bytevc1|h265|hevc/i.test(text(rate.gear_name)))
        .flatMap((rate: Obj) => urls(rate.play_addr?.url_list)),
      ...urls(video.play_addr?.url_list)
    ])
  ].slice(0, 12)
  const images = (Array.isArray(value.images) ? value.images : []).map((image: Obj) => {
    const url = first(image.url_list)
    if (!url) throw new AppError('INVALID_RESPONSE', '图集存在无法识别的图片地址，未打乱原图顺序。')
    return {
      url,
      liveUrl:
        first(image.video?.play_addr?.url_list) ??
        first(image.live_image?.url_list) ??
        first(image.video?.url_list) ??
        first(image.urls?.[0]?.url_list)
    }
  })
  return {
    work: parseWork(value),
    videos,
    images,
    music:
      first(music.play_url?.url_list) ??
      first(music.url_list) ??
      first(music.matched_pgc_sound?.play_url?.url_list)
  }
}
