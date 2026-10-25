import { DatabaseSync } from 'node:sqlite'
import { existsSync, lstatSync, readdirSync, realpathSync, renameSync, unlinkSync } from 'node:fs'
import { join, relative, isAbsolute, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AppError } from '../errors'

/** Deletes ownership first; shared works remain while another account or queue references them. */
export function purgeAccountRows(db: DatabaseSync, accountId: string): void {
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => String(row.name))
  )
  for (const table of [
    'unlike_tasks',
    'saved_tasks',
    'collection_tasks',
    'checkpoints',
    'playback_queues',
    'saved_members',
    'saved_items',
    'saved_folders',
    'account_items'
  ]) {
    if (tables.has(table)) db.prepare(`DELETE FROM ${table} WHERE accountId=?`).run(accountId)
  }
  db.prepare('DELETE FROM accounts WHERE id=?').run(accountId)
  db.prepare('DELETE FROM settings WHERE key=?').run(`runtime:${accountId}`)
  db.prepare('DELETE FROM settings WHERE key=?').run(`collectionTail:${accountId}`)
  const references = ['account_items', 'saved_items', 'saved_members']
    .filter((table) => tables.has(table))
    .map((table) => `NOT EXISTS(SELECT 1 FROM ${table} a WHERE a.workId=works.id)`)
  if (tables.has('playback_items'))
    references.push('NOT EXISTS(SELECT 1 FROM playback_items q WHERE q.workId=works.id)')
  db.exec(`DELETE FROM works WHERE ${references.join(' AND ')}`)
  const active = db.prepare("SELECT value FROM settings WHERE key='activeAccount'").get()?.value
  if (active === accountId) {
    const next = db.prepare('SELECT id FROM accounts ORDER BY createdAt,id LIMIT 1').get()?.id
    if (next) db.prepare("UPDATE settings SET value=? WHERE key='activeAccount'").run(next)
    else db.prepare("DELETE FROM settings WHERE key='activeAccount'").run()
  }
}

/** Stage all redactions before replacing any backup; never create a pre-deletion backup. */
export function purgeAccountBackups(root: string, accountId: string): void {
  const folder = join(root, 'backups')
  if (!existsSync(folder)) return
  const path = relative(realpathSync(root), realpathSync(folder))
  if (isAbsolute(path) || path.startsWith('..' + sep) || path === '..')
    throw new AppError('ACCOUNT_PURGE_FAILED', '备份目录指向应用目录之外，无法安全清理账号数据。')
  const staged: { original: string; temporary: string }[] = []
  try {
    for (const name of readdirSync(folder).filter((file) => file.endsWith('.sqlite'))) {
      const original = join(folder, name)
      if (!lstatSync(original).isFile() || lstatSync(original).isSymbolicLink())
        throw new Error('Backup is not a regular file')
      if (existsSync(original + '-wal') || existsSync(original + '-shm')) throw new Error('Backup is in use')
      const source = new DatabaseSync(original, { readOnly: true })
      const temporary = join(folder, `.account-purge-${randomUUID()}.tmp`)
      try {
        if (source.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
          throw new Error('Invalid backup')
        const version = Number(source.prepare('PRAGMA user_version').get()?.user_version)
        if (version < 1 || version > 7) throw new Error('Unsupported backup version')
        if (!source.prepare('SELECT 1 FROM accounts WHERE id=?').get(accountId)) continue
        staged.push({ original, temporary })
        source.prepare('VACUUM INTO ?').run(temporary)
      } finally {
        source.close()
      }
      const redacted = new DatabaseSync(temporary)
      try {
        redacted.exec('PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; BEGIN IMMEDIATE;')
        purgeAccountRows(redacted, accountId)
        if (redacted.prepare('PRAGMA foreign_key_check').all().length)
          throw new Error('Invalid backup references')
        redacted.exec('COMMIT; VACUUM;')
      } finally {
        redacted.close()
      }
    }
    for (const file of staged) renameSync(file.temporary, file.original)
  } catch {
    throw new AppError(
      'ACCOUNT_PURGE_FAILED',
      '账号删除未完成：无法清理历史备份，请关闭备份文件或检查数据目录权限后重试。当前账号记录仍保留。'
    )
  } finally {
    for (const file of staged) {
      try {
        unlinkSync(file.temporary)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          console.error('[MyLike] Redacted backup staging file could not be removed.')
      }
    }
  }
}
