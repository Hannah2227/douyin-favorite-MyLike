import { AppError } from '../errors'

export const MAX_MOBILE_EXPORT_ITEMS = 100_000
const MAX_MOBILE_EXPORT_BYTES = 64 * 1024 * 1024
const coverDomains = [
  'douyinpic.com',
  'douyincdn.com',
  'douyinstatic.com',
  'byteimg.com',
  'ibytedtos.com',
  'bytecdn.cn',
  'pstatp.com'
]

export type MobileExportRow = {
  id: string
  title: string
  author: string
  publishedAt: number
  mediaType: 'video' | 'gallery'
  isLive: number
  coverUrl: string | null
}

function cover(value: string | null): string | undefined {
  if (!value || value.length > 16_384) return
  try {
    const url = new URL(value)
    if (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      coverDomains.some((domain) => url.hostname === domain || url.hostname.endsWith('.' + domain))
    )
      return value
  } catch {
    // A stale or malformed cover is optional metadata.
  }
}

export function encodeMobileLibrary(rows: MobileExportRow[], label: string, now = new Date()): string {
  if (!rows.length) throw new AppError('EXPORT_EMPTY', '当前账号没有可导出的喜欢作品。')
  if (rows.length > MAX_MOBILE_EXPORT_ITEMS)
    throw new AppError('EXPORT_TOO_LARGE', '手机清单最多支持 10 万条作品。')
  const items = rows.map((row) => {
    if (
      typeof row.id !== 'string' ||
      !/^\d{1,30}$/.test(row.id) ||
      typeof row.title !== 'string' ||
      typeof row.author !== 'string' ||
      !['video', 'gallery'].includes(row.mediaType)
    )
      throw new AppError('EXPORT_INVALID', '本地作品元数据有误，未导出。')
    return {
      id: row.id,
      title: row.title,
      author: row.author,
      publishedAt:
        Number.isSafeInteger(row.publishedAt) && row.publishedAt > 0 && row.publishedAt < 253402300800
          ? new Date(row.publishedAt * 1000).toISOString()
          : null,
      kind: row.mediaType === 'video' ? 'video' : row.isLive ? 'live-gallery' : 'gallery',
      coverUrl: cover(row.coverUrl)
    }
  })
  const text =
    JSON.stringify({
      format: 'mylike.library',
      version: 2,
      exportedAt: now.toISOString(),
      source: { kind: 'douyin.likes', label },
      order: 'desktop-liked',
      items
    }) + '\n'
  if (Buffer.byteLength(text, 'utf8') > MAX_MOBILE_EXPORT_BYTES)
    throw new AppError('EXPORT_TOO_LARGE', '手机清单超过 64 MiB，未导出文件。')
  return text
}
