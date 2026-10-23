import { app, dialog, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { Account, ImportPreview, ImportResult, ExportResult, QueueCreate } from '../shared/contracts'
import type { Database } from './storage/client'
import { AppError } from './errors'

export class FileTransfers {
  private busy = false
  private preview: ImportPreview | null = null
  constructor(
    private readonly db: Pick<Database, 'call'>,
    private readonly parent: () => BrowserWindow | null,
    private readonly exclusive: <T>(action: () => Promise<T>) => Promise<T>,
    private readonly active: (accountId: string) => Promise<Account>,
    private readonly committed: () => void
  ) {}
  private begin(): void {
    if (this.busy || this.preview) throw new AppError('TRANSFER_BUSY', '请先完成或取消当前文件操作。')
    this.busy = true
  }
  private owner(): BrowserWindow {
    const win = this.parent()
    if (!win || win.isDestroyed()) throw new AppError('CLOSING', '应用窗口已关闭。')
    return win
  }
  async export(accountId: string, source: QueueCreate['source']): Promise<ExportResult | null> {
    this.begin()
    let token: string | undefined
    try {
      const prepared = await this.exclusive(async () => {
        const account = await this.active(accountId)
        const result = await this.db.call('prepareExport', { accountId, source })
        return { ...result, name: account.name }
      })
      token = prepared.token
      const name = prepared.name
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .replace(/[ .]+$/, '')
        .slice(0, 40)
      const selected = await dialog.showSaveDialog(this.owner(), {
        title: `导出 ${prepared.count} 条本地元数据`,
        defaultPath: join(
          app.getPath('documents'),
          `MyLike-${name}-${new Date().toISOString().slice(0, 10)}.mylike.json`
        ),
        filters: [{ name: 'MyLike 元数据', extensions: ['json'] }]
      })
      if (selected.canceled || !selected.filePath) return null
      return await this.exclusive(async () => {
        await this.active(accountId)
        return this.db.call('finishExport', { accountId, token: prepared.token, file: selected.filePath! })
      })
    } finally {
      if (token) await this.db.call('discardTransfer', { token }).catch(() => {})
      this.busy = false
    }
  }
  async prepareImport(accountId: string): Promise<ImportPreview | null> {
    this.begin()
    try {
      await this.active(accountId)
      const selected = await dialog.showOpenDialog(this.owner(), {
        title: '选择 MyLike 元数据文件',
        properties: ['openFile'],
        filters: [{ name: 'MyLike 元数据', extensions: ['json'] }]
      })
      if (selected.canceled || !selected.filePaths[0]) return null
      const preview = await this.exclusive(async () => {
        await this.active(accountId)
        return this.db.call('prepareImport', { accountId, file: selected.filePaths[0]! })
      })
      this.preview = preview
      return preview
    } finally {
      this.busy = false
    }
  }
  async commit(accountId: string, token: string): Promise<ImportResult> {
    if (this.busy) throw new AppError('TRANSFER_BUSY', '文件操作正在保存，请稍候。')
    if (this.preview?.token !== token || this.preview.accountId !== accountId)
      throw new AppError('TRANSFER_EXPIRED', '导入预览已失效，请重新选择文件。')
    this.busy = true
    try {
      const result = await this.exclusive(async () => {
        await this.active(accountId)
        return this.db.call('commitImport', { accountId, token })
      })
      this.preview = null
      this.committed()
      return result
    } finally {
      this.busy = false
    }
  }
  async cancel(token: string): Promise<null> {
    if (this.busy) throw new AppError('TRANSFER_BUSY', '正在完整保存，暂时不能取消。')
    await this.db.call('discardTransfer', { token })
    if (this.preview?.token === token) this.preview = null
    return null
  }
}
