import { randomUUID } from 'node:crypto'
import type { Account, UnlikeTask } from '../shared/contracts'
import type { Database } from './storage/client'
import type { DouyinEngine } from './douyin/engine'
import { parseFavoriteState, parseLikeState, parseUnlikeResult } from './douyin/parse'
import { AppError } from './errors'

type Run = <T>(
  accountId: string,
  action: (check: () => void) => Promise<T>,
  background?: boolean
) => Promise<T>
// One durable task, one request at a time. A stop waits for the current bounded write;
// it never cancels a write and then automatically retries it.
export class UnlikeService {
  private loop: Promise<void> | null = null
  private stopped = false
  private wake: (() => void) | null = null
  constructor(
    private readonly db: Database,
    private readonly engine: Pick<DouyinEngine, 'request'>,
    private readonly run: Run,
    private readonly identity: (accountId: string, check: () => void) => Promise<Account>,
    private readonly changed: (committed?: boolean) => void,
    private readonly interval = 2000
  ) {}
  get running(): boolean {
    return this.loop !== null
  }
  async start(
    accountId: string,
    workIds: string[],
    mode: 'single' | 'batch',
    source: UnlikeTask['source'] = 'likes'
  ): Promise<UnlikeTask> {
    if (this.running) throw new AppError('BUSY', '请先停止当前取消点赞或收藏任务。')
    const task = await this.db.call('unlikeCreate', { accountId, workIds, mode, source, id: randomUUID() })
    this.launch(task)
    return task
  }
  async resume(accountId: string, taskId: string): Promise<UnlikeTask> {
    if (this.running) throw new AppError('BUSY', '请先停止当前取消点赞或收藏任务。')
    const task = await this.db.call('unlikeUpdate', { accountId, taskId, status: 'running', reason: null })
    this.launch(task)
    return task
  }
  async stop(): Promise<void> {
    this.stopped = true
    this.wake?.()
    await this.loop
  }
  private launch(task: UnlikeTask): void {
    this.stopped = false
    this.loop = this.process(task).finally(() => {
      this.loop = null
      this.changed()
    })
    // The task error is persisted in process; a failing database must still reach
    // the caller of stop(), without creating an unhandled rejection meanwhile.
    void this.loop.catch(() => {})
    this.changed()
  }
  private async process(task: UnlikeTask): Promise<void> {
    const scope = { accountId: task.accountId, taskId: task.id }
    const favorite = task.source === 'favorites'
    try {
      while (!this.stopped) {
        const item = await this.db.call('unlikeNext', scope)
        if (!item) {
          const current = await this.db.call('unlikeTask', scope)
          await this.db.call('unlikeUpdate', {
            ...scope,
            status: 'completed',
            reason: current?.unknown
              ? '未发送项已处理；结果未知项需单独核验。'
              : '本轮已处理完成，请查看逐条结果。'
          })
          return
        }
        let reserved = false,
          sent = false
        try {
          await this.run(
            task.accountId,
            async (check) => {
              if (this.stopped) return
              const account = await this.identity(task.accountId, check)
              check()
              if (account.remoteId !== task.remoteId)
                throw new AppError('IDENTITY_MISMATCH', '当前登录身份与任务不符，未发送请求。')
              if (this.stopped) return
              let awemeType = '0'
              if (favorite) {
                const detail = await this.engine.request(task.accountId, 'detail', { aweme_id: item.workId })
                check()
                if (this.stopped) return
                const state = parseFavoriteState(detail, item.workId)
                awemeType = state.type
                if (!state.collected) {
                  await this.db.call('unlikeReserve', { ...scope, workId: item.workId })
                  reserved = true
                  await this.db.call('unlikeFinish', {
                    ...scope,
                    workId: item.workId,
                    status: 'success',
                    errorCode: null,
                    reason: '已核验当前未收藏，已同步本地记录，未重复发送取消请求。'
                  })
                  reserved = false
                  this.changed(true)
                  return
                }
              }
              if (!favorite && !item.platformSeen) {
                const detail = await this.engine.request(task.accountId, 'detail', { aweme_id: item.workId })
                check()
                if (this.stopped) return
                if (!parseLikeState(detail, item.workId)) {
                  await this.db.call('unlikeReserve', { ...scope, workId: item.workId })
                  reserved = true
                  await this.db.call('unlikeFinish', {
                    ...scope,
                    workId: item.workId,
                    status: 'failed',
                    errorCode: 'NOT_LIKED',
                    reason: '已核验当前账号未点赞，未发送取消请求；导入的本地记录保留。'
                  })
                  reserved = false
                  this.changed()
                  return
                }
              }
              await this.db.call('unlikeReserve', { ...scope, workId: item.workId })
              reserved = true
              // No await between reservation and issuing the write. From here onward,
              // any unconfirmed result is unknown, including a page navigation.
              sent = true
              const result = await this.engine.request(
                task.accountId,
                favorite ? 'favoriteRemove' : 'unlike',
                { aweme_id: item.workId, ...(favorite ? { aweme_type: awemeType } : {}) }
              )
              parseUnlikeResult(result)
              await this.db.call('unlikeFinish', {
                ...scope,
                workId: item.workId,
                status: 'success',
                errorCode: null,
                reason: favorite ? '平台已确认取消收藏。' : '平台已确认取消点赞。'
              })
              reserved = false
              this.changed(true)
            },
            true
          )
        } catch (error) {
          const code = error instanceof AppError ? error.code : 'STORAGE_ERROR'
          const rejected = sent && code === 'API_REJECTED'
          if (reserved)
            await this.db.call('unlikeFinish', {
              ...scope,
              workId: item.workId,
              status: sent && !rejected ? 'unknown' : 'failed',
              errorCode: code,
              reason: rejected
                ? '平台已明确拒绝，本地条目保留，未自动重发。'
                : sent
                  ? '请求已发出但结果未明确确认，本地条目保留，未自动重发。'
                  : '请求未发送，请查看任务原因。'
            })
          await this.db.call('unlikeUpdate', {
            ...scope,
            status: 'paused',
            errorCode: code,
            reason: rejected
              ? '平台拒绝了请求，后续条目已暂停，请检查账号或作品状态。'
              : sent
                ? '请求结果未知，后续条目已暂停；请重新核验。'
                : error instanceof AppError
                  ? error.message
                  : '保存或读取失败，任务已暂停。'
          })
          this.changed()
          return
        }
        if (!this.stopped)
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer)
              this.wake = null
              resolve()
            }
            const timer = setTimeout(finish, this.interval)
            this.wake = finish
          })
      }
      await this.db.call('unlikeUpdate', {
        ...scope,
        status: 'stopped',
        reason: '已停止后续未发送项；已发出请求的结果已单独保存。'
      })
    } catch (error) {
      await this.db.call('unlikeUpdate', {
        ...scope,
        status: 'paused',
        errorCode: 'STORAGE_ERROR',
        reason: '任务状态未能完整保存，已停止后续请求；重启后核对逐条结果。'
      })
      throw error
    } finally {
      this.changed()
    }
  }
  async verify(accountId: string, taskId: string, workId: string): Promise<UnlikeTask> {
    if (this.running) throw new AppError('BUSY', '请先停止正在运行的取消点赞或收藏任务。')
    const task = await this.db.call('unlikeTask', { accountId, taskId })
    if (!task) throw new AppError('TASK_CHANGED', '任务不存在。')
    return this.run(accountId, async (check) => {
      const account = await this.identity(accountId, check)
      if (account.remoteId !== task.remoteId)
        throw new AppError('IDENTITY_MISMATCH', '当前登录身份与任务不符。')
      const detail = await this.engine.request(accountId, 'detail', { aweme_id: workId })
      check()
      const result = await this.db.call('unlikeResolve', {
        accountId,
        taskId,
        workId,
        liked:
          task.source === 'favorites'
            ? parseFavoriteState(detail, workId).collected
            : parseLikeState(detail, workId)
      })
      this.changed(true)
      return result
    })
  }
}
