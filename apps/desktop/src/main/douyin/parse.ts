import JSONbigFactory from 'json-bigint'
import type { Media, Work, FavoriteFolder } from '../../shared/contracts'
import { AppError } from '../errors'

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

export function parseResponse(body: string, status: number): Obj {
  if (body.length > 16 * 1024 * 1024) throw new AppError('INVALID_RESPONSE', '接口响应过大，已停止处理。')
  if (status === 401 || status === 403)
    throw new AppError('AUTH_REQUIRED', '登录或验证状态需要处理，请打开抖音窗口。')
  if (status === 429) throw new AppError('RATE_LIMITED', '接口暂时限流，请稍后再试。')
  if (status < 200 || status >= 300) throw new AppError('NETWORK_ERROR', '平台请求未成功，请稍后重试。')
  if (/<(?:html|!doctype)/i.test(body.slice(0, 500)))
    throw new AppError('VERIFICATION_REQUIRED', '接口返回网页，请打开抖音窗口检查登录或人工验证。')
  let data: Obj
  try {
    data = object(JSONbig.parse(body))
  } catch {
    throw new AppError('INVALID_RESPONSE', '接口没有返回有效 JSON，当前进度未推进。')
  }
  if (!Object.keys(data).length) throw new AppError('INVALID_RESPONSE', '接口返回空响应，请检查抖音窗口。')
  if (data.status_code != null && String(data.status_code) !== '0') {
    throw new AppError('API_REJECTED', '平台拒绝了这次请求，请检查登录、人工验证或稍后重试。')
  }
  return data
}

export function parseLikeState(data: Obj, workId: string): boolean {
  const detail = object(data.aweme_detail)
  if (numericId(detail.aweme_id) !== workId)
    throw new AppError('INVALID_RESPONSE', '核验详情与目标作品不一致。')
  if (detail.user_digged === 1 || detail.user_digged === '1') return true
  if (detail.user_digged === 0 || detail.user_digged === '0') return false
  throw new AppError('LIKE_STATE_UNKNOWN', '平台未返回明确的当前点赞状态，请在作品原页核对。')
}
export function parseUnlikeResult(data: Obj): void {
  if (String(data.status_code) !== '0') throw new AppError('WRITE_UNCONFIRMED', '平台未返回明确的成功确认。')
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
    isLive: images.some((image: Obj) => !!(image.video || image.live_image))
  }
}
export function parseLikedPage(data: Obj): { items: Work[]; cursor: string; hasMore: boolean } {
  if (!Array.isArray(data.aweme_list))
    throw new AppError('INVALID_RESPONSE', '喜欢列表缺少必要字段，进度未推进。')
  if (![0, 1, false, true, '0', '1'].includes(data.has_more))
    throw new AppError('INVALID_RESPONSE', '接口未提供可信的分页结束标记。')
  const hasMore = data.has_more === 1 || data.has_more === true || data.has_more === '1'
  if (!data.aweme_list.length && hasMore)
    throw new AppError('INVALID_RESPONSE', '接口返回空页但仍有更多内容，已保留断点。')
  return { items: data.aweme_list.map(parseWork), cursor: numericId(data.max_cursor ?? '0'), hasMore }
}
export function parseIdentity(data: Obj): { remoteId: string; nickname: string; avatarUrl: string | null } {
  const user = object(data.user)
  if (typeof user.sec_uid !== 'string' || !/^[A-Za-z0-9_-]{8,200}$/.test(user.sec_uid))
    throw new AppError('AUTH_REQUIRED', '尚未取得登录身份，请在抖音窗口完成登录后重新核验。')
  return {
    remoteId: user.sec_uid,
    nickname: text(user.nickname),
    avatarUrl: first(user.avatar_thumb?.url_list)
  }
}
export function parseFavoritesPage(data: Obj): { items: Work[]; cursor: string; hasMore: boolean } {
  return parseLikedPage({ ...data, max_cursor: data.cursor ?? data.max_cursor })
}
export function parseFavoriteFolders(data: Obj): {
  folders: Omit<FavoriteFolder, 'localCount'>[]
  cursor: string
  hasMore: boolean
} {
  if (!Array.isArray(data.collects_list) || ![0, 1, false, true, '0', '1'].includes(data.has_more))
    throw new AppError('INVALID_RESPONSE', '收藏夹接口缺少可信的列表或结束标记。')
  const hasMore = [1, true, '1'].includes(data.has_more)
  if (hasMore && !data.collects_list.length)
    throw new AppError('INVALID_RESPONSE', '收藏夹返回异常空页，断点未推进。')
  return {
    folders: data.collects_list.map((entry: Obj) => ({
      id: numericId(entry.collects_id),
      title: text(entry.collects_name ?? entry.name).slice(0, 500) || '未命名收藏夹',
      remoteCount: Math.max(0, Number(entry.aweme_count ?? entry.total_number ?? entry.total ?? 0) || 0)
    })),
    cursor: numericId(data.cursor ?? data.max_cursor ?? '0'),
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
