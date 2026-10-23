import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep, join } from 'node:path'
import type { Filter, Work } from '../../shared/contracts'
import type { Inputs, Replies } from './protocol'
import { AppError } from '../errors'
import { encodeTransfer, readTransfer, type DecodedTransfer } from './transfer-format'

type Method = 'prepareExport' | 'finishExport' | 'prepareImport' | 'commitImport' | 'discardTransfer'
export class TransferStore {
  private exporting: { token: string; accountId: string; text: string; count: number } | null = null
  private importing: ({ token: string; accountId: string } & DecodedTransfer) | null = null
  forgetAccount(accountId: string): void {
    if (this.exporting?.accountId === accountId) this.exporting = null
    if (this.importing?.accountId === accountId) this.importing = null
  }
  constructor(
    private readonly db: DatabaseSync,
    private readonly file: string,
    private readonly filter: (filter: Filter) => { from: string; params: (string | number)[]; order: string },
    private readonly transaction: <T>(action: () => T) => T,
    private readonly backup: (reason: string) => void
  ) {}
  private account(accountId: string): { name: string; nickname: string | null } {
    const row = this.db.prepare('SELECT name,nickname FROM accounts WHERE id=?').get(accountId)
    if (!row) throw new AppError('ACCOUNT_NOT_FOUND', '目标账号不存在。')
    return row as { name: string; nickname: string | null }
  }
  call<K extends Method>(method: K, input: Inputs[K]): Replies[K] {
    return this.dispatch(method, input) as Replies[K]
  }
  private dispatch(method: Method, input: any): unknown {
    switch (method) {
      case 'discardTransfer':
        if (this.exporting?.token === input.token) this.exporting = null
        if (this.importing?.token === input.token) this.importing = null
        return null
      case 'prepareExport': {
        const account = this.account(input.accountId)
        let rows: Record<string, unknown>[]
        if (input.source.type === 'filter') {
          const { from, params, order } = this.filter({ ...input.source.filter, accountId: input.accountId })
          rows = this.db
            .prepare(`SELECT w.*,a.firstSeen AS collectedAt ${from} ${order} LIMIT 100001`)
            .all(...params)
        } else {
          const find = this.db.prepare(
            'SELECT w.*,a.firstSeen AS collectedAt FROM works w JOIN account_items a ON a.workId=w.id WHERE a.accountId=? AND w.id=?'
          )
          rows = [...new Set<string>(input.source.ids)].map((id) => {
            const row = find.get(input.accountId, id)
            if (!row) throw new AppError('WORK_NOT_FOUND', '部分条目已不在当前账号列表，请刷新选择。')
            return row
          })
          const field = input.source.sort === 'collected' ? 'collectedAt' : 'publishedAt'
          rows.sort((a, b) => Number(b[field]) - Number(a[field]) || (String(a.id) < String(b.id) ? 1 : -1))
        }
        if (rows.length > 100000)
          throw new AppError('EXPORT_TOO_LARGE', '一次最多导出 10 万条，请缩小筛选范围。')
        const items = rows.map((row) => ({ ...row, isLive: !!row.isLive })) as unknown as (Work & {
          collectedAt: number
        })[]
        const token = randomUUID(),
          text = encodeTransfer(items, account.name)
        this.exporting = { token, accountId: input.accountId, text, count: items.length }
        return { token, count: items.length }
      }
      case 'finishExport': {
        const staged = this.exporting
        if (!staged || staged.token !== input.token || staged.accountId !== input.accountId)
          throw new AppError('TRANSFER_EXPIRED', '导出内容已变化，请重新选择范围。')
        const target = resolve(input.file)
        let within: string
        try {
          within = relative(
            realpathSync(dirname(this.file)),
            join(realpathSync(dirname(target)), basename(target))
          )
        } catch {
          throw new AppError('EXPORT_LOCATION', '保存目录不可用，请选择已存在且可写的位置。')
        }
        if (
          !isAbsolute(input.file) ||
          (!isAbsolute(within) && within !== '..' && !within.startsWith('..' + sep))
        )
          throw new AppError('EXPORT_LOCATION', '请选择应用数据目录之外的位置，避免覆盖数据库或登录文件。')
        const temporary = join(dirname(target), `.mylike-export-${randomUUID()}.tmp`)
        let fd: number | undefined,
          created = false
        try {
          fd = openSync(temporary, 'wx', 0o600)
          created = true
          writeFileSync(fd, staged.text, 'utf8')
          fsyncSync(fd)
          closeSync(fd)
          fd = undefined
          renameSync(temporary, target)
          created = false
        } catch {
          throw new AppError(
            'EXPORT_WRITE_FAILED',
            '文件未能完整保存；原目标文件未替换，请检查文件权限和磁盘。'
          )
        } finally {
          if (fd !== undefined)
            try {
              closeSync(fd)
            } catch {
              /* preserve original error */
            }
          if (created)
            try {
              unlinkSync(temporary)
            } catch {
              /* cleanup may fail with disk permissions */
            }
        }
        this.exporting = null
        return { fileName: basename(target), count: staged.count }
      }
      case 'prepareImport': {
        const account = this.account(input.accountId)
        let parsed: DecodedTransfer
        try {
          parsed = readTransfer(input.file)
        } catch (error) {
          if (error instanceof AppError) throw error
          throw new AppError('IMPORT_READ_FAILED', '文件无法读取，请检查文件权限；本地数据未修改。')
        }
        if (!parsed.items.length) throw new AppError('IMPORT_EMPTY', '文件中没有可导入的条目。')
        const find = this.db.prepare('SELECT 1 FROM account_items WHERE accountId=? AND workId=?')
        let existingCount = 0
        for (const item of parsed.items) if (find.get(input.accountId, item.id)) existingCount++
        const token = randomUUID()
        this.importing = { ...parsed, token, accountId: input.accountId }
        return {
          token,
          accountId: input.accountId,
          accountName: account.name,
          fileName: basename(input.file),
          sourceLabel: parsed.sourceLabel,
          total: parsed.items.length,
          newCount: parsed.items.length - existingCount,
          existingCount,
          duplicates: parsed.duplicates
        }
      }
      case 'commitImport': {
        const staged = this.importing
        if (!staged || staged.token !== input.token || staged.accountId !== input.accountId)
          throw new AppError('TRANSFER_EXPIRED', '导入预览已失效，请重新选择文件。')
        this.account(input.accountId)
        this.backup('before-import')
        const result = this.transaction(() => {
          const work = this.db.prepare(
            'INSERT OR IGNORE INTO works(id,title,author,publishedAt,coverUrl,mediaType,isLive) VALUES(?,?,?,?,?,?,?)'
          )
          const member = this.db.prepare(
            'INSERT OR IGNORE INTO account_items(accountId,workId,firstSeen,platformSeen) VALUES(?,?,?,0)'
          )
          let added = 0
          for (const item of staged.items) {
            work.run(item.id, item.title, item.author, item.publishedAt, null, item.mediaType, +item.isLive)
            added += Number(member.run(input.accountId, item.id, item.collectedAt).changes)
          }
          return { received: staged.items.length, added, duplicates: staged.duplicates }
        })
        this.importing = null
        return result
      }
    }
  }
}
