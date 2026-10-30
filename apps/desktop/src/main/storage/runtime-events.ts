import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  runtimeEventCategory,
  runtimeEventSchema,
  type RuntimeEvent,
  type RuntimeEventInput
} from '../../shared/runtime-events'
import { AppError } from '../errors'

const repeatWindow = 5 * 60_000
const priority = { request: 0, auth: 1, engine: 2, task: 3 }
function compact(events: RuntimeEvent[]): RuntimeEvent[] {
  const result: RuntimeEvent[] = []
  for (const input of events) {
    const category = runtimeEventCategory(input)
    if (!category) continue
    // Counts and timings describe individual requests, not the task outcome.
    const { durationMs: _duration, count: _count, ...event } = input
    const duplicate =
      category === 'exception'
        ? result.findLastIndex(
            (previous) =>
              runtimeEventCategory(previous) === 'exception' &&
              event.time >= previous.time &&
              event.time - previous.time < repeatWindow &&
              previous.code === event.code &&
              (event.code?.startsWith('BROWSER_') || previous.operation === event.operation) &&
              (!event.code?.startsWith('BROWSER_') ||
                previous.message.includes(event.message) ||
                event.message.includes(previous.message)) &&
              (!previous.rule || !event.rule || previous.rule === event.rule) &&
              (!previous.platformCode ||
                !event.platformCode ||
                previous.platformCode === event.platformCode) &&
              (previous.status === undefined ||
                event.status === undefined ||
                previous.status === event.status) &&
              // Different deferred folders must stay independently identifiable.
              (!['FOLDER_DEFERRED', 'INTERRUPTED', 'PARTIAL_SYNC'].includes(event.code ?? '') ||
                previous.message === event.message)
          )
        : -1
    if (duplicate < 0) result.push(event)
    else {
      const previous = result[duplicate]!
      const preferred = priority[event.kind] >= priority[previous.kind] ? event : previous
      const other = preferred === event ? previous : event
      result[duplicate] = { ...other, ...preferred, id: previous.id, time: previous.time }
    }
  }
  // Request failures cannot displace committed task outcomes.
  return [
    ...result.filter((e) => e.kind === 'request').slice(-150),
    ...result.filter((e) => e.kind !== 'request').slice(-150)
  ].sort((a, b) => a.time - b.time)
}

export class RuntimeEventsStore {
  constructor(private readonly db: DatabaseSync) {}
  read(accountId: string): RuntimeEvent[] {
    if (!this.db.prepare('SELECT 1 FROM accounts WHERE id=?').get(accountId))
      throw new AppError('ACCOUNT_NOT_FOUND', '账号不存在。')
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(`runtime:${accountId}`)
    if (!row) return []
    try {
      return compact(
        z
          .array(runtimeEventSchema)
          .max(300)
          .parse(JSON.parse(String(row.value)))
      )
    } catch {
      throw new AppError('LOG_READ_FAILED', '运行记录读取失败，请重试。')
    }
  }
  append(accountId: string, input: RuntimeEventInput): null {
    const events = this.read(accountId)
    const event = runtimeEventSchema.parse({ ...input, id: randomUUID(), time: Date.now() })
    if (!runtimeEventCategory(event)) return null
    const retained = compact([...events, event])
    if (JSON.stringify(retained) === JSON.stringify(events)) return null
    this.db
      .prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(`runtime:${accountId}`, JSON.stringify(retained))
    return null
  }
}
