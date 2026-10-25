import type { DatabaseSync } from 'node:sqlite'
import { randomInt, randomUUID } from 'node:crypto'
import { playbackPreferencesSchema, type Filter, type QueueState, type Work } from '../../shared/contracts'
import { readPlaybackPreferences } from '../../shared/preferences'
import type { Inputs, Replies } from './protocol'
import { AppError } from '../errors'

type Method =
  | 'queueState'
  | 'queueCreate'
  | 'queueResume'
  | 'queueMove'
  | 'queueProgress'
  | 'queueEnd'
  | 'queueReplay'
  | 'queueDismiss'
  | 'queueItems'
  | 'playbackPreferences'
type Row = {
  id: string
  accountId: string
  source: QueueState['source']
  mode: QueueState['mode']
  currentIndex: number
  total: number
  revision: number
  seconds: number
  slide: number
  musicSeconds: number
  completed: number
  progressSequence: number
}
export class PlaybackStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly filter: (filter: Filter) => { from: string; params: (string | number)[]; order: string },
    private readonly transaction: <T>(action: () => T) => T
  ) {}
  private row(accountId: string, queueId?: string, revision?: number): Row {
    const row = this.db
      .prepare('SELECT * FROM playback_queues WHERE accountId=?')
      .get(accountId) as unknown as Row | undefined
    if (!row || (queueId && row.id !== queueId) || (revision !== undefined && row.revision !== revision))
      throw new AppError('QUEUE_CHANGED', '播放队列已变化，旧操作已忽略。')
    return row
  }
  private work(queueId: string, index: number): Work | null {
    const row = this.db
      .prepare(
        'SELECT w.* FROM playback_items q JOIN works w ON w.id=q.workId WHERE q.queueId=? AND q.position=?'
      )
      .get(queueId, index)
    return row ? ({ ...row, isLive: !!row.isLive } as unknown as Work) : null
  }
  private state(row: Row): QueueState {
    const work = this.work(row.id, row.currentIndex)
    if (!work) throw new AppError('STORAGE_ERROR', '队列内容无法读取，原数据已保留。')
    return {
      queueId: row.id,
      accountId: row.accountId,
      revision: row.revision,
      mode: row.mode,
      source: row.source,
      index: row.currentIndex,
      total: row.total,
      completed: !!row.completed,
      position: { seconds: row.seconds, slide: row.slide, musicSeconds: row.musicSeconds },
      work,
      next: this.work(row.id, row.currentIndex + 1)
    }
  }
  call<K extends Method>(method: K, input: Inputs[K]): Replies[K] {
    return this.dispatch(method, input) as Replies[K]
  }
  private dispatch(method: Method, input: any): unknown {
    if (method === 'playbackPreferences') {
      if (input.preferences) {
        const value = playbackPreferencesSchema.parse(input.preferences)
        this.db
          .prepare(
            "INSERT INTO settings(key,value) VALUES('playback',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
          )
          .run(JSON.stringify(value))
        return value
      }
      const row = this.db.prepare("SELECT value FROM settings WHERE key='playback'").get()
      try {
        return readPlaybackPreferences(row ? JSON.parse(String(row.value)) : {})
      } catch {
        throw new AppError('SETTINGS_ERROR', '播放设置无法读取，原设置已保留。')
      }
    }
    if (method === 'queueState') {
      const row = this.db
        .prepare('SELECT * FROM playback_queues WHERE accountId=?')
        .get(input.accountId) as unknown as Row | undefined
      return row ? this.state(row) : null
    }
    if (method === 'queueCreate')
      return this.transaction(() => {
        let ids: string[]
        if (input.source.type === 'filter') {
          const { from, params, order } = this.filter({ ...input.source.filter, accountId: input.accountId })
          ids = this.db
            .prepare(`SELECT w.id ${from} ${order} LIMIT 100001`)
            .all(...params)
            .map((row) => String(row.id))
        } else {
          const table = input.source.source === 'favorites' ? 'saved_items' : 'account_items'
          const find = this.db.prepare(
            `SELECT w.id,w.publishedAt,a.firstSeen FROM works w JOIN ${table} a ON a.workId=w.id WHERE a.accountId=? AND w.id=?`
          )
          const rows = [...new Set<string>(input.source.ids)].map((id) => {
            const row = find.get(input.accountId, id)
            if (!row) throw new AppError('WORK_NOT_FOUND', '部分条目已不在当前账号列表，请刷新选择。')
            return row as { id: string; publishedAt: number; firstSeen: number }
          })
          rows.sort(
            (a, b) =>
              (input.source.sort === 'collected'
                ? b.firstSeen - a.firstSeen
                : b.publishedAt - a.publishedAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
          )
          ids = rows.map((row) => row.id)
        }
        if (!ids.length) throw new AppError('EMPTY_QUEUE', '当前范围没有可播放的条目。')
        if (ids.length > 100000)
          throw new AppError('QUEUE_TOO_LARGE', '一次最多播放 10 万条，请缩小筛选范围。')
        if (input.startWorkId && !ids.includes(input.startWorkId))
          throw new AppError('WORK_NOT_FOUND', '点播作品已不在当前筛选范围，请刷新后重试。')
        if (input.mode === 'shuffle') {
          for (let i = ids.length - 1; i > 0; i--) {
            const j = randomInt(i + 1)
            ;[ids[i], ids[j]] = [ids[j]!, ids[i]!]
          }
          if (input.startWorkId) {
            ids.splice(ids.indexOf(input.startWorkId), 1)
            ids.unshift(input.startWorkId)
          }
        }
        const id = randomUUID(),
          index = input.startWorkId ? ids.indexOf(input.startWorkId) : 0
        this.db.prepare('DELETE FROM playback_queues WHERE accountId=?').run(input.accountId)
        this.db
          .prepare(
            'INSERT INTO playback_queues(id,accountId,mode,currentIndex,total,updatedAt,source) VALUES(?,?,?,?,?,?,?)'
          )
          .run(
            id,
            input.accountId,
            input.mode,
            index,
            ids.length,
            Date.now(),
            input.source.type === 'filter'
              ? (input.source.filter.source ?? 'likes')
              : (input.source.source ?? 'likes')
          )
        const insert = this.db.prepare('INSERT INTO playback_items VALUES(?,?,?)')
        ids.forEach((workId, index) => insert.run(id, index, workId))
        this.db.exec(
          'DELETE FROM works WHERE NOT EXISTS(SELECT 1 FROM account_items a WHERE a.workId=works.id) AND NOT EXISTS(SELECT 1 FROM playback_items q WHERE q.workId=works.id) AND NOT EXISTS(SELECT 1 FROM saved_items s WHERE s.workId=works.id)'
        )
        return this.state(this.row(input.accountId, id))
      })
    if (method === 'queueItems') {
      const row = this.row(input.accountId, input.queueId)
      const items = this.db
        .prepare(
          'SELECT q.position,w.* FROM playback_items q JOIN works w ON w.id=q.workId WHERE q.queueId=? ORDER BY q.position LIMIT ? OFFSET ?'
        )
        .all(row.id, input.limit, input.offset)
        .map(({ position, ...work }) => ({
          index: Number(position),
          work: { ...work, isLive: !!work.isLive }
        }))
      return { items, total: row.total }
    }
    return this.transaction(() => {
      const row = this.row(
        input.accountId,
        input.queueId,
        ['queueResume', 'queueMove'].includes(method) ? undefined : input.revision
      )
      let index = row.currentIndex,
        seconds = row.seconds,
        slide = row.slide,
        musicSeconds = row.musicSeconds,
        completed = row.completed,
        revision = row.revision,
        sequence = row.progressSequence
      if (method === 'queueProgress') {
        if (input.sequence <= sequence || completed) return this.state(row)
        ;({ seconds, slide, musicSeconds } = input.position)
        sequence = input.sequence
      } else if (method === 'queueResume') {
        if (completed) throw new AppError('QUEUE_FINISHED', '本轮已播放完毕，可以重新创建队列。')
        revision++
        sequence = 0
      } else if (method === 'queueMove') {
        index = input.target === 'next' ? index + 1 : input.target === 'previous' ? index - 1 : input.target
        if (index < 0 || index >= row.total) throw new AppError('QUEUE_BOUNDARY', '已经到达队列边界。')
        seconds = slide = musicSeconds = sequence = completed = 0
        revision++
      } else if (method === 'queueReplay') {
        seconds = slide = musicSeconds = sequence = completed = 0
        revision++
      } else if (method === 'queueDismiss') {
        completed = 1
        revision++
      } else if (method === 'queueEnd') {
        if (input.advance && index + 1 < row.total) {
          index++
          seconds = slide = musicSeconds = completed = 0
        } else {
          completed = 1
          ;({ seconds, slide, musicSeconds } = input.position)
        }
        revision++
        sequence = 0
      }
      this.db
        .prepare(
          'UPDATE playback_queues SET currentIndex=?,seconds=?,slide=?,musicSeconds=?,completed=?,revision=?,progressSequence=?,updatedAt=? WHERE id=? AND accountId=?'
        )
        .run(
          index,
          seconds,
          slide,
          musicSeconds,
          completed,
          revision,
          sequence,
          Date.now(),
          row.id,
          row.accountId
        )
      return this.state(this.row(row.accountId, row.id))
    })
  }
}
