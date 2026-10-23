import { app, shell } from 'electron'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DataInfo } from '../shared/contracts'
import type { DouyinEngine } from './douyin/engine'
import { AppError } from './errors'
import { metadataBytes } from './storage/usage'

export class DataMaintenance {
  constructor(private readonly engine: Pick<DouyinEngine, 'cacheSize'>) {}
  async info(accountId: string | null): Promise<DataInfo> {
    const folder = app.getPath('userData')
    const size = async (file: string) => {
      try {
        return (await stat(file)).size
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
        throw error
      }
    }
    try {
      let entries: string[] = []
      try {
        entries = await readdir(join(folder, 'backups'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const backups = entries.filter((file) => file.endsWith('.sqlite'))
      const [metadata, backupsSizes, cacheBytes] = await Promise.all([
        metadataBytes(folder),
        Promise.all(backups.map((file) => size(join(folder, 'backups', file)))),
        this.engine.cacheSize(accountId)
      ])
      return {
        folder,
        metadataBytes: metadata,
        backupsCount: backups.length,
        backupsBytes: backupsSizes.reduce((a, b) => a + b, 0),
        cacheBytes
      }
    } catch {
      throw new AppError('DATA_INFO_FAILED', '无法读取数据占用信息，请检查数据目录权限。')
    }
  }
  async open(target: 'data' | 'backups'): Promise<null> {
    const folder = target === 'data' ? app.getPath('userData') : join(app.getPath('userData'), 'backups')
    await mkdir(folder, { recursive: true })
    if (await shell.openPath(folder))
      throw new AppError('OPEN_FOLDER_FAILED', '无法打开数据目录，请稍后重试。')
    return null
  }
}
