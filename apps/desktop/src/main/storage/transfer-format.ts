import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { z } from 'zod'
import type { Work } from '../../shared/contracts'
import { AppError } from '../errors'

export const MAX_TRANSFER_BYTES = 64 * 1024 * 1024
const entrySchema = z
  .strictObject({
    id: z.string().regex(/^\d{1,30}$/),
    title: z.string().max(20000),
    author: z.string().max(1024),
    publishedAt: z.number().int().min(0).max(8640000000000),
    mediaType: z.enum(['video', 'gallery']),
    isLive: z.boolean(),
    collectedAt: z.number().int().min(0).max(8640000000000000)
  })
  .refine((entry) => !entry.isLive || entry.mediaType === 'gallery')
const fileSchema = z.strictObject({
  format: z.literal('mylike.library'),
  version: z.literal(1),
  exportedAt: z.iso.datetime(),
  source: z.strictObject({ label: z.string().max(160) }),
  items: z.array(entrySchema).max(100000)
})
export type TransferEntry = z.infer<typeof entrySchema>
export interface DecodedTransfer {
  sourceLabel: string
  items: TransferEntry[]
  duplicates: number
}
export function decodeTransfer(text: string): DecodedTransfer {
  if (Buffer.byteLength(text, 'utf8') > MAX_TRANSFER_BYTES)
    throw new AppError('IMPORT_TOO_LARGE', '导入文件不能超过 64 MiB。')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new AppError('IMPORT_INVALID', '文件不是有效的 JSON，未修改本地数据。')
  }
  if (
    value &&
    typeof value === 'object' &&
    'format' in value &&
    value.format === 'mylike.library' &&
    'version' in value &&
    value.version !== 1
  )
    throw new AppError('IMPORT_VERSION', '暂不支持这个数据版本，未修改本地数据。')
  const parsed = fileSchema.safeParse(value)
  if (!parsed.success)
    throw new AppError('IMPORT_INVALID', '文件字段不符合 MyLike 元数据格式，未修改本地数据。')
  const unique = new Map<string, TransferEntry>()
  for (const item of parsed.data.items) if (!unique.has(item.id)) unique.set(item.id, item)
  return {
    sourceLabel: parsed.data.source.label,
    items: [...unique.values()],
    duplicates: parsed.data.items.length - unique.size
  }
}
export function readTransfer(file: string): DecodedTransfer {
  const fd = openSync(file, 'r')
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new AppError('IMPORT_INVALID', '请选择普通的元数据文件。')
    if (stat.size > MAX_TRANSFER_BYTES) throw new AppError('IMPORT_TOO_LARGE', '导入文件不能超过 64 MiB。')
    const chunks: Buffer[] = []
    let total = 0
    while (total <= MAX_TRANSFER_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, MAX_TRANSFER_BYTES + 1 - total)),
        read = readSync(fd, chunk, 0, chunk.length, null)
      if (!read) break
      chunks.push(chunk.subarray(0, read))
      total += read
    }
    if (total > MAX_TRANSFER_BYTES) throw new AppError('IMPORT_TOO_LARGE', '导入文件不能超过 64 MiB。')
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total))
    } catch {
      throw new AppError('IMPORT_INVALID', '文件需要使用有效的 UTF-8 编码。')
    }
    return decodeTransfer(text)
  } finally {
    closeSync(fd)
  }
}
export function encodeTransfer(
  entries: (Work & { collectedAt: number })[],
  label: string,
  exportedAt = new Date().toISOString()
): string {
  // Explicit field projection: auth, covers and temporary media URLs never enter the file.
  const value = {
    format: 'mylike.library' as const,
    version: 1 as const,
    exportedAt,
    source: { label },
    items: entries.map((item) => ({
      id: item.id,
      title: item.title,
      author: item.author,
      publishedAt: item.publishedAt,
      mediaType: item.mediaType,
      isLive: item.isLive,
      collectedAt: item.collectedAt
    }))
  }
  if (!fileSchema.safeParse(value).success)
    throw new AppError('EXPORT_INVALID', '部分本地记录无法导出，请检查数据；原记录已保留。')
  const text = JSON.stringify(value, null, 2) + '\n'
  if (Buffer.byteLength(text, 'utf8') > MAX_TRANSFER_BYTES)
    throw new AppError('EXPORT_TOO_LARGE', '导出文件超过 64 MiB，请缩小筛选范围或分批导出。')
  return text
}
