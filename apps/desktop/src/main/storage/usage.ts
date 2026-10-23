import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError } from '../errors'

/** Actual shared metadata files, including committed WAL data and SQLite's shared-memory file. */
export async function metadataBytes(folder: string): Promise<number> {
  try {
    if (!(await stat(folder)).isDirectory()) throw new Error('Metadata directory is unavailable')
    const sizes = await Promise.all(
      ['mylike.sqlite', 'mylike.sqlite-wal', 'mylike.sqlite-shm'].map(async (file) => {
        try {
          return (await stat(join(folder, file))).size
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
          throw error
        }
      })
    )
    return sizes.reduce((sum, size) => sum + size, 0)
  } catch {
    throw new AppError('DATA_INFO_FAILED', '无法读取数据占用信息，请检查数据目录权限。')
  }
}
