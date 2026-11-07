import type { DatabaseSync } from 'node:sqlite'

/** Connection-only setting: the main database and its durable WAL remain on disk. */
export function configureTemporaryStorage(db: DatabaseSync): void {
  db.exec('PRAGMA temp_store=MEMORY;')
}

const failures: Record<number, { code: string; message: string }> = {
  5: { code: 'SQLITE_BUSY', message: '本地数据正被其他操作占用，请稍后重试。' },
  6: { code: 'SQLITE_LOCKED', message: '本地数据正被其他操作占用，请稍后重试。' },
  7: { code: 'SQLITE_NOMEM', message: '可用内存不足，请关闭部分程序后重试。已有数据会保留。' },
  8: {
    code: 'SQLITE_READONLY',
    message: '数据目录暂时无法写入，请检查文件权限和安全软件拦截。已有数据会保留。'
  },
  10: {
    code: 'SQLITE_IOERR',
    message: '本地文件读写失败，请检查磁盘空间、文件权限和安全软件拦截。已有数据会保留。'
  },
  11: { code: 'SQLITE_CORRUPT', message: '本地数据暂时无法正常读取，请保留数据目录并反馈问题。' },
  13: { code: 'SQLITE_FULL', message: '磁盘空间不足，请释放空间后重试。已有数据会保留。' },
  14: {
    code: 'SQLITE_CANTOPEN',
    message: '无法打开或创建所需的本地文件，请检查磁盘空间、文件权限和安全软件拦截。已有数据会保留。'
  },
  26: { code: 'SQLITE_NOTADB', message: '本地数据暂时无法正常读取，请保留数据目录并反馈问题。' }
}
export function sqliteFailure(error: unknown) {
  if (
    !error ||
    typeof error !== 'object' ||
    !('code' in error) ||
    error.code !== 'ERR_SQLITE_ERROR' ||
    !('errcode' in error)
  )
    return null
  const sqliteCode = error.errcode
  if (typeof sqliteCode !== 'number' || !Number.isSafeInteger(sqliteCode) || sqliteCode <= 0) return null
  const baseCode = sqliteCode & 255
  return {
    sqliteCode,
    baseCode,
    ...(failures[baseCode] ?? {
      code: 'SQLITE_ERROR',
      message: '数据库操作失败，原数据已保留，请检查磁盘与文件权限。'
    })
  }
}
export function recoverableYearFailure(error: unknown): boolean {
  const failure = sqliteFailure(error)
  return !!failure && [7, 10, 13, 14].includes(failure.baseCode)
}
