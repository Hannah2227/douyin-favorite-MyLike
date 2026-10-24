import { randomUUID } from 'node:crypto'
import type { Account, CollectionTask, Snapshot } from '../shared/contracts'
import type { Database } from './storage/client'
import type { DouyinEngine } from './douyin/engine'
import { parseLikedPage } from './douyin/parse'
import { AppError, publicError } from './errors'
import {
  retryableRead,
  rebuildReadPage,
  readRetryDelay,
  PageProgress,
  EndConfirmation
} from './read-recovery'
import { collectionPolicy as policy } from './collection-policy'
import type { RuntimeEventInput } from '../shared/runtime-events'

type Runner = <T>(
  accountId: string,
  operation: (check: () => void) => Promise<T>,
  background?: boolean
) => Promise<T>
type Policy = typeof policy

export class CollectionService {
  private controller: AbortController | null = null
  private loop: Promise<void> | null = null
  private current: CollectionTask | null = null
  activity: Snapshot['collectionActivity'] = null
  constructor(
    private readonly db: Pick<Database, 'call'>,
    private readonly engine: Pick<DouyinEngine, 'request' | 'cancel' | 'release' | 'snapshot'>,
    private readonly run: Runner,
    private readonly identity: (accountId: string, check: () => void) => Promise<Account>,
    private readonly changed: (committed?: boolean) => void,
    private readonly timing: Policy = policy,
    private readonly report: (accountId: string, event: RuntimeEventInput) => void = () => {}
  ) {}
  get running(): boolean {
    return !!this.loop
  }
  private launch(task: CollectionTask): void {
    this.current = task
    const controller = new AbortController()
    this.controller = controller
    this.loop = this.collect(task, controller.signal).finally(() => {
      this.activity = null
      this.loop = null
      this.controller = null
      this.changed()
    })
    this.changed()
  }
  async start(accountId: string, mode: CollectionTask['mode']): Promise<CollectionTask> {
    if (this.loop) throw new AppError('BUSY', '请先暂停或停止现有采集任务。')
    const previous = await this.db.call('collection', { accountId })
    if (mode === 'update' && previous && previous.status !== 'completed')
      return this.control(accountId, previous.id, 'resume')
    if (mode === 'incremental' && previous?.mode === 'incremental' && previous.status !== 'completed')
      return this.control(accountId, previous.id, 'resume')
    const task = await this.db.call('startCollection', { accountId, id: randomUUID(), mode })
    this.launch(task)
    return task
  }
  async control(
    accountId: string,
    taskId: string,
    action: 'pause' | 'resume' | 'stop'
  ): Promise<CollectionTask> {
    if (action === 'resume') {
      if (this.loop) throw new AppError('BUSY', '采集任务正在收口，请稍后继续。')
      const task = await this.db.call('updateCollection', {
        accountId,
        taskId,
        status: 'running',
        reason: null
      })
      this.launch(task)
      return task
    }
    const ownsLoop = this.current?.id === taskId && this.current.accountId === accountId
    if (ownsLoop) {
      this.controller?.abort()
      // A pause must not cancel a foreground media request which owns the lane.
      if (this.activity === 'requesting') this.engine.cancel()
    }
    const task = await this.db.call('updateCollection', {
      accountId,
      taskId,
      status: action === 'pause' ? 'paused' : 'stopped',
      reason: action === 'pause' ? '已暂停，可继续已保存进度。' : '已停止，不会自动重启；仍可手动继续。'
    })
    if (ownsLoop) await this.loop
    this.changed()
    return task
  }
  async pause(): Promise<void> {
    if (this.loop && this.current) await this.control(this.current.accountId, this.current.id, 'pause')
  }
  private async wait(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      signal.addEventListener('abort', done, { once: true })
    })
  }
  private async collect(initial: CollectionTask, signal: AbortSignal): Promise<void> {
    const progress = new PageProgress()
    const ending = new EndConfirmation()
    let task = initial,
      retries = 0,
      segmentPages = 0,
      segmentStart = Date.now()
    const noAvailableItems =
      '平台暂未返回可采集内容，可能是临时限制或内容不可访问，尚未确认末尾。断点已保留，请稍后继续。'
    const valid = () => {
      if (signal.aborted) throw new AppError('CANCELLED', '采集已停止。')
    }
    while (!signal.aborted && task.status === 'running') {
      try {
        const recycled =
          segmentPages >= this.timing.pagesPerSegment || Date.now() - segmentStart >= this.timing.segmentMs
        if (recycled) {
          this.activity = 'recycling'
          this.changed()
          await this.run(
            task.accountId,
            async (check) => {
              check()
              valid()
              if (this.engine.snapshot().status !== 'visible') this.engine.release()
            },
            true
          )
          await this.wait(this.timing.cooldown, signal)
          valid()
          segmentPages = 0
          segmentStart = Date.now()
        }
        this.activity = 'waiting'
        this.changed()
        const saved = await this.run(
          task.accountId,
          async (check) => {
            const guard = () => {
              check()
              valid()
            }
            guard()
            this.activity = 'requesting'
            this.changed()
            try {
              const account = await this.identity(task.accountId, guard)
              guard()
              const page = parseLikedPage(
                await this.engine.request(task.accountId, 'likes', {
                  sec_user_id: account.remoteId!,
                  max_cursor: task.cursor,
                  min_cursor: '0',
                  count: '18',
                  publish_video_strategy_type: '2',
                  pc_client_type: '1'
                }),
                { allowEmpty: true }
              )
              guard()
              const confirmed = ending.check(
                `${task.phase}:${task.cursor}`,
                page.items.map((item) => item.id),
                page.hasMore
              )
              if (page.hasMore && !page.items.length) {
                throw new AppError('EMPTY_PAGE', noAvailableItems)
              }
              if (!confirmed) {
                this.activity = 'confirming'
                this.report(task.accountId, {
                  kind: 'task',
                  message: '喜欢采集收到结束标记，稍后在同一断点再次确认。'
                })
                this.changed()
                return null
              }
              progress.check(
                task.phase,
                page.items.map((item) => item.id),
                page.hasMore
              )
              const saved = await this.db.call('saveCollectionPage', {
                accountId: task.accountId,
                taskId: task.id,
                remoteId: account.remoteId!,
                requestCursor: task.cursor,
                ...page
              })
              this.changed(true)
              return saved
            } finally {
              if (this.activity !== 'confirming') this.activity = 'waiting'
            }
          },
          true
        )
        if (saved) {
          task = saved
          retries = 0
        }
        this.current = task
        segmentPages++
        this.changed()
        if (task.status === 'running')
          await this.wait(saved ? this.timing.interval : this.timing.retry, signal)
      } catch (error) {
        if (signal.aborted) return
        const detail = publicError(error)
        ending.reset()
        if (retryableRead(detail.code) && retries < 2) {
          this.activity = ['EMPTY_PAGE', 'EMPTY_RESPONSE'].includes(detail.code) ? 'cooling' : 'waiting'
          this.changed()
          if (rebuildReadPage(detail.code, retries, this.engine.snapshot().status === 'visible')) {
            try {
              await this.run(
                task.accountId,
                async (check) => {
                  check()
                  valid()
                  this.engine.release()
                },
                true
              )
            } catch {
              if (signal.aborted) return
            }
          }
          const delay = readRetryDelay(detail.code, retries++, this.timing.retry)
          this.report(task.accountId, {
            kind: 'task',
            message: `喜欢采集暂缓 ${(delay / 1000).toFixed(0)} 秒后重试同一断点（${retries}/2）：${detail.message}`,
            code: detail.code
          })
          await this.wait(delay, signal)
          continue
        }
        try {
          await this.db.call('updateCollection', {
            accountId: task.accountId,
            taskId: task.id,
            status: 'paused',
            reason: ['EMPTY_PAGE', 'EMPTY_RESPONSE'].includes(detail.code)
              ? noAvailableItems
              : detail.message,
            errorCode: ['EMPTY_PAGE', 'EMPTY_RESPONSE'].includes(detail.code)
              ? 'NO_AVAILABLE_ITEMS'
              : detail.code
          })
        } catch {
          console.error('[MyLike] Collection paused; progress could not be updated.')
        }
        return
      }
    }
  }
}
