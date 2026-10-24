import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { runtimeEventSchema, type RuntimeEvent, type RuntimeEventInput } from '../../shared/runtime-events'
import { AppError } from '../errors'

export class RuntimeEventsStore {
  constructor(private readonly db: DatabaseSync) {}
  read(accountId: string): RuntimeEvent[] {
    if (!this.db.prepare('SELECT 1 FROM accounts WHERE id=?').get(accountId))
      throw new AppError('ACCOUNT_NOT_FOUND', '账号不存在。')
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(`runtime:${accountId}`)
    if (!row) return []
    try {
      return z
        .array(runtimeEventSchema)
        .max(300)
        .parse(JSON.parse(String(row.value)))
    } catch {
      throw new AppError('LOG_READ_FAILED', '运行记录读取失败，请重试。')
    }
  }
  append(accountId: string, input: RuntimeEventInput): null {
    const events = this.read(accountId)
    events.push(runtimeEventSchema.parse({ ...input, id: randomUUID(), time: Date.now() }))
    // Keep task/auth history even during thousands of successful page reads.
    const requests = events.filter((e) => e.kind === 'request').slice(-150)
    const transitions = events.filter((e) => e.kind !== 'request').slice(-150)
    const retained = [...requests, ...transitions].sort((a, b) => a.time - b.time)
    this.db
      .prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(`runtime:${accountId}`, JSON.stringify(retained))
    return null
  }
}
