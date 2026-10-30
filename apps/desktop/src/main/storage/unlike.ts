import type { DatabaseSync } from 'node:sqlite'
import { MAX_BATCH_SIZE, type UnlikeTask, type UnlikeItem } from '../../shared/contracts'
import type { Inputs, Replies } from './protocol'
import { AppError } from '../errors'

type Method =
  | 'favoriteWriteGuard'
  | 'unlikeTask'
  | 'unlikeHistory'
  | 'unlikeItems'
  | 'unlikeCreate'
  | 'unlikeUpdate'
  | 'unlikeNext'
  | 'unlikeReserve'
  | 'unlikeFinish'
  | 'unlikeSkip'
  | 'unlikeResolve'
export class UnlikeStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: <T>(action: () => T) => T
  ) {}
  private task(accountId: string, taskId?: string): UnlikeTask | null {
    const row = this.db
      .prepare(
        `SELECT * FROM unlike_tasks WHERE accountId=? ${taskId ? 'AND id=?' : ''} ORDER BY createdAt DESC,rowid DESC LIMIT 1`
      )
      .get(...(taskId ? [accountId, taskId] : [accountId]))
    if (!row) {
      if (taskId) throw new AppError('TASK_CHANGED', '任务不存在或账号已变化。')
      return null
    }
    const counts = this.db
      .prepare('SELECT status,count(*) AS n FROM unlike_items WHERE taskId=? GROUP BY status')
      .all(String(row.id))
    const task = {
      ...row,
      total: 0,
      pending: 0,
      inflight: 0,
      success: 0,
      failed: 0,
      unknown: 0
    } as unknown as UnlikeTask
    for (const count of counts) {
      task[count.status as UnlikeItem['status']] = Number(count.n)
      task.total += Number(count.n)
    }
    return task
  }
  private remove(accountId: string, workId: string, source: UnlikeTask['source']): void {
    if (source === 'favorites') {
      this.db
        .prepare(
          `UPDATE saved_folders SET remoteCount=max(0,remoteCount-1) WHERE accountId=? AND id IN (SELECT folderId FROM saved_members WHERE accountId=? AND workId=?)`
        )
        .run(accountId, accountId, workId)
    }
    const table = source === 'favorites' ? 'saved_items' : 'account_items'
    this.db.prepare(`DELETE FROM ${table} WHERE accountId=? AND workId=?`).run(accountId, workId)
    this.db
      .prepare(
        'DELETE FROM works WHERE id=? AND NOT EXISTS(SELECT 1 FROM account_items WHERE workId=?) AND NOT EXISTS(SELECT 1 FROM playback_items WHERE workId=?) AND NOT EXISTS(SELECT 1 FROM saved_items WHERE workId=?)'
      )
      .run(workId, workId, workId, workId)
  }
  private item(accountId: string, taskId: string, workId: string): UnlikeItem {
    this.task(accountId, taskId)
    const row = this.db.prepare('SELECT * FROM unlike_items WHERE taskId=? AND workId=?').get(taskId, workId)
    if (!row) throw new AppError('WORK_NOT_FOUND', '作品不属于这个任务。')
    return row as unknown as UnlikeItem
  }
  call<K extends Method>(method: K, input: Inputs[K]): Replies[K] {
    return this.dispatch(method, input) as Replies[K]
  }
  private dispatch(method: Method, input: any): unknown {
    switch (method) {
      case 'favoriteWriteGuard':
        if (
          this.db
            .prepare(
              "SELECT 1 FROM unlike_items i JOIN unlike_tasks t ON t.id=i.taskId WHERE t.accountId=? AND t.source='favorites' AND i.workId=? AND i.status IN ('unknown','inflight')"
            )
            .get(input.accountId, input.workId)
        )
          throw new AppError(
            'UNRESOLVED_WRITE',
            '此作品有结果未知的取消收藏请求，请先到连接与任务重新核验，再操作收藏。'
          )
        return null
      case 'unlikeTask':
        return this.task(input.accountId, input.taskId)
      case 'unlikeHistory':
        return this.db
          .prepare(
            'SELECT id FROM unlike_tasks WHERE accountId=? ORDER BY createdAt DESC,rowid DESC LIMIT 50'
          )
          .all(input.accountId)
          .map((row) => this.task(input.accountId, String(row.id)))
      case 'unlikeItems': {
        const task = this.task(input.accountId, input.taskId)!
        return {
          items: this.db
            .prepare(
              `SELECT position,workId,title,status,reason,errorCode FROM unlike_items WHERE taskId=? ${input.issuesOnly ? "AND status IN ('failed','unknown')" : ''} ORDER BY position LIMIT ? OFFSET ?`
            )
            .all(task.id, input.limit, input.offset),
          total: input.issuesOnly
            ? Number(
                this.db
                  .prepare(
                    "SELECT count(*) AS n FROM unlike_items WHERE taskId=? AND status IN ('failed','unknown')"
                  )
                  .get(task.id)!.n
              )
            : task.total
        }
      }
      case 'unlikeSkip':
        return this.transaction(() => {
          const task = this.task(input.accountId, input.taskId)!,
            item = this.item(input.accountId, input.taskId, input.workId)
          if (task.source !== 'favorites' || task.status !== 'running' || item.status !== 'pending')
            throw new AppError('TASK_CHANGED', '条目已变化，不能覆盖已发送的请求。')
          this.db
            .prepare(
              "UPDATE unlike_items SET status='failed',errorCode='ITEM_SKIPPED',reason=?,updatedAt=? WHERE taskId=? AND workId=?"
            )
            .run(input.reason, Date.now(), task.id, input.workId)
          return this.task(input.accountId, task.id)
        })
      case 'unlikeCreate':
        return this.transaction(() => {
          const source: UnlikeTask['source'] = input.source ?? 'likes'
          if (!['likes', 'favorites'].includes(source))
            throw new AppError('INVALID_TARGETS', '不支持的操作来源。')
          const table = source === 'favorites' ? 'saved_items' : 'account_items'
          const account = this.db.prepare('SELECT remoteId FROM accounts WHERE id=?').get(input.accountId)
          if (!account?.remoteId) throw new AppError('AUTH_REQUIRED', '请先登录并核验当前账号身份。')
          if (
            this.db
              .prepare("SELECT 1 FROM unlike_tasks WHERE accountId=? AND status='running'")
              .get(input.accountId)
          )
            throw new AppError('BUSY', '已有取消点赞或收藏任务正在运行。')
          const ids = [...new Set<string>(input.workIds)]
          if (!ids.length || ids.length > MAX_BATCH_SIZE || (input.mode === 'single' && ids.length !== 1))
            throw new AppError('INVALID_TARGETS', '单条操作只能选择一条；批量操作一次最多 1000 条。')
          const rows = ids.map((id) => {
            if (
              this.db
                .prepare(
                  "SELECT 1 FROM unlike_items i JOIN unlike_tasks t ON t.id=i.taskId WHERE t.accountId=? AND i.workId=? AND t.source=? AND i.status IN ('unknown','inflight')"
                )
                .get(input.accountId, id, source)
            )
              throw new AppError(
                'UNRESOLVED_WRITE',
                '所选作品存在结果未知的历史请求，请先到任务详情重新核验。'
              )
            const row = this.db
              .prepare(
                `SELECT w.title FROM works w JOIN ${table} a ON a.workId=w.id WHERE a.accountId=? AND w.id=?`
              )
              .get(input.accountId, id)
            if (!row) throw new AppError('WORK_NOT_FOUND', '部分作品已不在当前本地列表，请刷新选择。')
            return { id, title: String(row.title) }
          })
          const now = Date.now()
          this.db
            .prepare(
              "INSERT INTO unlike_tasks(id,accountId,mode,remoteId,status,reason,errorCode,createdAt,updatedAt,source) VALUES(?,?,?,?,'running',NULL,NULL,?,?,?)"
            )
            .run(input.id, input.accountId, input.mode, account.remoteId, now, now, source)
          const insert = this.db.prepare("INSERT INTO unlike_items VALUES(?,?,?,?,'pending',NULL,NULL,?)")
          rows.forEach((row, index) => insert.run(input.id, index, row.id, row.title, now))
          return this.task(input.accountId, input.id)
        })
      case 'unlikeUpdate': {
        const task = this.task(input.accountId, input.taskId)!
        if (input.status === 'running') {
          const remote = this.db
            .prepare('SELECT remoteId FROM accounts WHERE id=?')
            .get(input.accountId)?.remoteId
          if (remote !== task.remoteId)
            throw new AppError('IDENTITY_MISMATCH', '任务账号身份发生变化，不能继续。')
          if (!task.pending) throw new AppError('NO_PENDING', '没有未发送项；结果未知项需要单独核验。')
          if (
            this.db
              .prepare("SELECT 1 FROM unlike_tasks WHERE accountId=? AND id<>? AND status='running'")
              .get(input.accountId, task.id)
          )
            throw new AppError('BUSY', '请先停止当前任务。')
        }
        this.db
          .prepare('UPDATE unlike_tasks SET status=?,reason=?,errorCode=?,updatedAt=? WHERE id=?')
          .run(input.status, input.reason, input.errorCode ?? null, Date.now(), task.id)
        return this.task(input.accountId, task.id)
      }
      case 'unlikeNext': {
        const task = this.task(input.accountId, input.taskId)!
        if (task.status !== 'running') return null
        const table = task.source === 'favorites' ? 'saved_items' : 'account_items'
        const platformSeen = task.source === 'favorites' ? '0 AS platformSeen' : 'a.platformSeen'
        const row = this.db
          .prepare(
            `SELECT i.*,${platformSeen} FROM unlike_items i LEFT JOIN ${table} a ON a.accountId=? AND a.workId=i.workId WHERE i.taskId=? AND i.status='pending' ORDER BY i.position LIMIT 1`
          )
          .get(input.accountId, task.id)
        return row ? { ...row, platformSeen: row.platformSeen === 1 } : null
      }
      case 'unlikeReserve':
        return this.transaction(() => {
          const task = this.task(input.accountId, input.taskId)!,
            item = this.item(input.accountId, input.taskId, input.workId)
          const table = task.source === 'favorites' ? 'saved_items' : 'account_items'
          if (task.status !== 'running' || item.status !== 'pending')
            throw new AppError('TASK_CHANGED', '任务或目标状态已变化，未发送请求。')
          if (
            this.db.prepare('SELECT remoteId FROM accounts WHERE id=?').get(input.accountId)?.remoteId !==
            task.remoteId
          )
            throw new AppError('IDENTITY_MISMATCH', '操作账号身份已变化。')
          if (
            !this.db
              .prepare(`SELECT 1 FROM ${table} WHERE accountId=? AND workId=?`)
              .get(input.accountId, input.workId)
          )
            throw new AppError('WORK_NOT_FOUND', '作品已从本地列表移除，未发送请求。')
          if (
            this.db
              .prepare(
                "SELECT 1 FROM unlike_items i JOIN unlike_tasks t ON t.id=i.taskId WHERE t.accountId=? AND i.workId=? AND t.source=? AND i.status IN ('unknown','inflight')"
              )
              .get(input.accountId, input.workId, task.source)
          )
            throw new AppError('UNRESOLVED_WRITE', '历史请求结果未知，未重复发送。')
          this.db
            .prepare(
              "UPDATE unlike_items SET status='inflight',reason=NULL,errorCode=NULL,updatedAt=? WHERE taskId=? AND workId=?"
            )
            .run(Date.now(), task.id, input.workId)
          return null
        })
      case 'unlikeFinish':
        return this.transaction(() => {
          const item = this.item(input.accountId, input.taskId, input.workId)
          if (item.status !== 'inflight') throw new AppError('TASK_CHANGED', '此请求结果已保存，不能覆盖。')
          this.db
            .prepare(
              'UPDATE unlike_items SET status=?,reason=?,errorCode=?,updatedAt=? WHERE taskId=? AND workId=?'
            )
            .run(input.status, input.reason, input.errorCode, Date.now(), input.taskId, input.workId)
          if (input.status === 'success')
            this.remove(input.accountId, input.workId, this.task(input.accountId, input.taskId)!.source)
          return this.task(input.accountId, input.taskId)
        })
      case 'unlikeResolve':
        return this.transaction(() => {
          const task = this.task(input.accountId, input.taskId)!
          const label = task.source === 'favorites' ? '收藏' : '点赞'
          const item = this.item(input.accountId, input.taskId, input.workId)
          if (item.status !== 'unknown') throw new AppError('TASK_CHANGED', '此条目已不处于结果未知状态。')
          this.db
            .prepare(
              'UPDATE unlike_items SET status=?,reason=?,errorCode=?,updatedAt=? WHERE taskId=? AND workId=?'
            )
            .run(
              input.liked ? 'failed' : 'success',
              input.liked
                ? `已核验仍为${label}；如需再次操作，请重新选择并确认。`
                : `已核验当前未${label}，已同步移除本地条目。`,
              input.liked ? (task.source === 'favorites' ? 'VERIFIED_COLLECTED' : 'VERIFIED_LIKED') : null,
              Date.now(),
              input.taskId,
              input.workId
            )
          if (!input.liked) this.remove(input.accountId, input.workId, task.source)
          const resolved = this.task(input.accountId, input.taskId)!
          if (!resolved.unknown && !resolved.inflight) {
            // A read-only confirmation finishes uncertainty; it never resumes
            // pending writes or turns a user's explicit stop into a running job.
            this.db
              .prepare(
                'UPDATE unlike_tasks SET status=?,errorCode=NULL,reason=?,updatedAt=? WHERE id=? AND accountId=?'
              )
              .run(
                resolved.pending ? (task.status === 'stopped' ? 'stopped' : 'paused') : 'completed',
                resolved.pending
                  ? '检查已完成，可以继续处理剩余内容。'
                  : resolved.failed
                    ? '检查已完成，部分操作未完成；如需再次操作，请重新选择并确认。'
                    : '检查已完成，操作结果已保存。',
                Date.now(),
                input.taskId,
                input.accountId
              )
          }
          return this.task(input.accountId, input.taskId)
        })
    }
  }
}
