import { randomUUID } from 'node:crypto'
import type { Account, FavoritesTask, Snapshot } from '../shared/contracts'
import type { Database } from './storage/client'
import type { DouyinEngine } from './douyin/engine'
import { parseFavoriteFolders, parseFavoritesPage } from './douyin/parse'
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
export class FavoritesService {
  private loop: Promise<void> | null = null
  private controller: AbortController | null = null
  private current: FavoritesTask | null = null
  activity: Snapshot['favoritesActivity'] = null
  constructor(
    private readonly db: Pick<Database, 'call'>,
    private readonly engine: Pick<DouyinEngine, 'request' | 'cancel' | 'release' | 'snapshot'>,
    private readonly run: Runner,
    private readonly identity: (accountId: string, check: () => void) => Promise<Account>,
    private readonly changed: (committed?: boolean) => void,
    private readonly timing = policy,
    private readonly report: (accountId: string, event: RuntimeEventInput) => void = () => {}
  ) {}
  get running() {
    return !!this.loop
  }
  async start(accountId: string): Promise<FavoritesTask> {
    if (this.loop) throw new AppError('BUSY', '请先暂停现有收藏同步任务。')
    const task = await this.db.call('favoritesStart', { accountId, id: randomUUID() })
    this.launch(task)
    return task
  }
  async control(
    accountId: string,
    taskId: string,
    action: 'pause' | 'resume' | 'stop'
  ): Promise<FavoritesTask> {
    if (action === 'resume' && this.loop) throw new AppError('BUSY', '收藏同步正在收口，请稍后继续。')
    const owns = this.current?.id === taskId && this.current.accountId === accountId
    if (owns && action !== 'resume') {
      this.controller?.abort()
      if (this.activity === 'requesting') this.engine.cancel()
    }
    const task = await this.db.call('favoritesUpdate', {
      accountId,
      taskId,
      status: action === 'resume' ? 'running' : action === 'pause' ? 'paused' : 'stopped',
      reason: action === 'resume' ? null : '收藏同步已暂停，可继续已保存的分页和收藏夹进度。'
    })
    if (action === 'resume') this.launch(task)
    else if (owns) await this.loop
    this.changed()
    return task
  }
  async pause() {
    if (this.loop && this.current) await this.control(this.current.accountId, this.current.id, 'pause')
  }
  private launch(task: FavoritesTask) {
    this.current = task
    const controller = new AbortController()
    this.controller = controller
    this.loop = this.collect(task, controller.signal).finally(() => {
      this.loop = null
      this.controller = null
      this.activity = null
      this.changed()
    })
    this.changed()
  }
  private async wait(ms: number, signal: AbortSignal) {
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
  private async collect(initial: FavoritesTask, signal: AbortSignal) {
    const progress = new PageProgress()
    const ending = new EndConfirmation()
    let task = initial,
      retries = 0,
      pages = 0,
      started = Date.now()
    const valid = () => {
      if (signal.aborted) throw new AppError('CANCELLED', '收藏同步已停止。')
    }
    while (!signal.aborted && task.status === 'running') {
      try {
        if (pages >= this.timing.pagesPerSegment || Date.now() - started >= this.timing.segmentMs) {
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
          pages = 0
          started = Date.now()
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
              const result = await this.engine.request(
                task.accountId,
                task.stage === 'all' ? 'favorites' : task.stage === 'folders' ? 'folders' : 'folderItems',
                {
                  cursor: task.cursor,
                  count: '18',
                  ...(task.folderId ? { collects_id: task.folderId } : {}),
                  ...(task.stage !== 'all' ? { version_code: '170400', version_name: '17.4.0' } : {})
                }
              )
              guard()
              const page =
                task.stage === 'folders' ? parseFavoriteFolders(result) : parseFavoritesPage(result)
              const ids =
                'folders' in page
                  ? page.folders.map((folder) => folder.id)
                  : page.items.map((item) => item.id)
              if (!ending.check(`${task.stage}:${task.folderId ?? ''}:${task.cursor}`, ids, page.hasMore)) {
                this.activity = 'confirming'
                this.report(task.accountId, {
                  kind: 'task',
                  message: '收藏同步收到结束标记，稍后在同一断点再次确认。'
                })
                this.changed()
                return null
              }
              progress.check(`${task.stage}:${task.folderId ?? ''}`, ids, page.hasMore)
              const saved = await this.db.call('favoritesSave', {
                accountId: task.accountId,
                taskId: task.id,
                remoteId: account.remoteId!,
                stage: task.stage,
                folderId: task.folderId,
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
        pages++
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
            message: `收藏同步暂缓 ${(delay / 1000).toFixed(0)} 秒后重试同一断点（${retries}/2）：${detail.message}`,
            code: detail.code
          })
          await this.wait(delay, signal)
          continue
        }
        try {
          await this.db.call('favoritesUpdate', {
            accountId: task.accountId,
            taskId: task.id,
            status: 'paused',
            reason: detail.message,
            errorCode: detail.code
          })
        } catch {
          console.error('[MyLike] Favorites progress could not be updated.')
        }
        return
      }
    }
  }
}
