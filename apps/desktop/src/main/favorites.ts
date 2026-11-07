import { randomUUID } from 'node:crypto'
import type { Account, FavoritesTask, Snapshot } from '../shared/contracts'
import type { HealthEntry } from '../shared/health'
import type { Database } from './storage/client'
import type { DouyinEngine } from './douyin/engine'
import { parseFavoriteFolders, parseFavoritesPage } from './douyin/parse'
import { AppError, publicError } from './errors'
import { PageProgress, EndConfirmation, EmptyPageTraversal } from './read-recovery'
import { collectionPolicy as policy } from './collection-policy'
import { readRecovery } from './recovery'
import type { RuntimeEventInput } from '../shared/runtime-events'

const definiteCheckpointErrors = new Set([
  'AUTH_REQUIRED',
  'LOGIN_PENDING',
  'IDENTITY_MISMATCH',
  'DUPLICATE_ACCOUNT',
  'VERIFICATION_REQUIRED',
  'RATE_LIMITED',
  'API_REJECTED'
])
const uncertainCheckpointErrors = new Set([
  'FAVORITE_EMPTY_PAGE',
  'UPSTREAM_CHANGED',
  'UPSTREAM_RISK_CONTROL',
  'INVALID_RESPONSE',
  'EMPTY_RESPONSE',
  'EMPTY_PAGE',
  'EMPTY_PAGE_LIMIT',
  'CURSOR_STALLED',
  'END_UNCONFIRMED',
  'NETWORK_ERROR',
  'TIMEOUT',
  'BROWSER_NOT_READY',
  'BROWSER_CRASHED',
  'PAGE_CHANGED'
])
export function blockedFavoriteTask(...tasks: (FavoritesTask | null)[]) {
  return (
    tasks.find(
      (task) =>
        task?.status === 'paused' &&
        task.errorCode &&
        (definiteCheckpointErrors.has(task.errorCode) || uncertainCheckpointErrors.has(task.errorCode))
    ) ?? null
  )
}
export function favoriteOperation(task: FavoritesTask): 'favorites' | 'folders' | 'folderItems' {
  return task.stage === 'all' ? 'favorites' : task.stage === 'folders' ? 'folders' : 'folderItems'
}

type Runner = <T>(
  accountId: string,
  operation: (check: () => void) => Promise<T>,
  background?: boolean
) => Promise<T>
export class FavoritesService {
  private loop: Promise<void> | null = null
  private controller: AbortController | null = null
  private current: FavoritesTask | null = null
  private readonly checkpointChecks = new Map<string, { target: string; entry: HealthEntry }>()
  activity: Snapshot['favoritesActivity'] = null
  constructor(
    private readonly db: Pick<Database, 'call'>,
    private readonly engine: Pick<DouyinEngine, 'request' | 'cancel' | 'release' | 'snapshot'> &
      Partial<Pick<DouyinEngine, 'assertAvailable'>>,
    private readonly run: Runner,
    private readonly identity: (accountId: string, check: () => void) => Promise<Account>,
    private readonly changed: (committed?: boolean) => void,
    private readonly timing = policy,
    private readonly report: (accountId: string, event: RuntimeEventInput) => void = () => {}
  ) {}
  get running() {
    return !!this.loop
  }
  async start(accountId: string, mode: 'sync' | 'update' = 'sync'): Promise<FavoritesTask> {
    if (this.loop) throw new AppError('BUSY', '请先暂停现有收藏同步任务。')
    const previous = await this.db.call('favoritesTask', { accountId, mode })
    this.engine.assertAvailable?.(accountId, this.readOperation(previous, mode))
    const task = await this.db.call('favoritesStart', { accountId, id: randomUUID(), mode })
    this.launch(task)
    return task
  }
  async control(
    accountId: string,
    taskId: string,
    action: 'pause' | 'resume' | 'stop',
    mode: 'sync' | 'update' = 'sync'
  ): Promise<FavoritesTask> {
    if (action === 'resume' && this.loop) throw new AppError('BUSY', '收藏同步正在收口，请稍后继续。')
    if (action === 'resume') {
      const previous = await this.db.call('favoritesTask', { accountId, mode })
      if (previous?.id === taskId)
        this.engine.assertAvailable?.(accountId, this.readOperation(previous, mode))
    }
    const owns = this.current?.id === taskId && this.current.accountId === accountId
    if (owns && action !== 'resume') {
      this.controller?.abort()
      if (this.activity === 'requesting') this.engine.cancel()
    }
    if (owns && this.current?.status === 'paused' && action === 'pause') {
      await this.loop
      const paused = await this.db.call('favoritesTask', { accountId, mode })
      if (paused?.id === taskId && paused.status !== 'running') return paused
    }
    const task = await this.db.call('favoritesUpdate', {
      accountId,
      taskId,
      mode,
      status: action === 'resume' ? 'running' : action === 'pause' ? 'paused' : 'stopped',
      reason: action === 'resume' ? null : '收藏同步已暂停，可继续已保存的分页和收藏夹进度。'
    })
    if (action === 'resume') this.launch(task)
    else if (owns) await this.loop
    this.changed()
    return task
  }
  async pause() {
    if (this.loop && this.current)
      await this.control(this.current.accountId, this.current.id, 'pause', this.current.mode)
  }
  async probe(accountId: string) {
    if (this.running) throw new AppError('BUSY', '请先暂停收藏任务，再检查当前收藏断点。')
    const task = await this.db.call('favoritesTask', { accountId })
    const scope = task && task.status !== 'completed' && task.status !== 'partial' ? task.stage : 'all'
    this.engine.assertAvailable?.(
      accountId,
      scope === 'all' ? 'favorites' : scope === 'folders' ? 'folders' : 'folderItems'
    )
    return this.run(accountId, async (check) => {
      await this.identity(accountId, check)
      check()
      const stage = task && task.status !== 'completed' && task.status !== 'partial' ? task.stage : 'all'
      const operation = stage === 'all' ? 'favorites' : stage === 'folders' ? 'folders' : 'folderItems'
      const result = await this.engine.request(
        accountId,
        operation,
        this.parameters(task?.cursor ?? '0', task?.folderId ?? null)
      )
      check()
      const page =
        stage === 'folders'
          ? parseFavoriteFolders(result, { allowEmpty: true })
          : parseFavoritesPage(result, { allowEmpty: true })
      const skipped = 'skipped' in page ? page.skipped.length : 0
      if (skipped || (page.hasMore && !('folders' in page ? page.folders.length : page.received)))
        this.report(accountId, {
          kind: 'task',
          operation,
          code: skipped ? 'INVALID_ITEMS' : 'EMPTY_PAGE',
          message: `收藏只读检查：${skipped ? `发现 ${skipped} 条异常作品` : '空列表仍有下一页'}；未保存内容或推进断点。`
        })
      return {
        stage,
        count: 'folders' in page ? page.folders.length : page.items.length,
        skipped,
        hasMore: page.hasMore
      }
    })
  }
  private readOperation(
    task: FavoritesTask | null,
    mode: 'sync' | 'update'
  ): 'favorites' | 'folders' | 'folderItems' {
    if (mode === 'update' || !task || task.status === 'completed') return 'favorites'
    if (task.status === 'partial')
      return task.incomplete ? 'favorites' : task.foldersDeferred ? 'folderItems' : 'favorites'
    return task.stage === 'folder' ? 'folderItems' : task.stage === 'folders' ? 'folders' : 'favorites'
  }
  private parameters(cursor: string, folderId: string | null) {
    return {
      cursor,
      count: '20',
      ...(folderId ? { collects_id: folderId } : {})
    }
  }
  private checkKey(task: FavoritesTask) {
    return JSON.stringify([task.accountId, task.mode])
  }
  private checkTarget(task: FavoritesTask) {
    return JSON.stringify([task.id, task.stage, task.folderId, task.cursor])
  }
  checkpointHealth(task: FavoritesTask, evidence?: HealthEntry): HealthEntry {
    const last = this.checkpointChecks.get(this.checkKey(task))
    if (last?.target === this.checkTarget(task)) return last.entry
    const code = task.errorCode
    const rule = evidence?.code === code ? evidence.rule : undefined
    return {
      operation: favoriteOperation(task),
      status:
        definiteCheckpointErrors.has(code ?? '') || rule === 'envelope.risk_code' ? 'abnormal' : 'uncertain',
      code,
      rule,
      at: task.updatedAt,
      failures: 0,
      favoriteCheckpoint: true
    }
  }
  verifyCheckpoint(
    task: FavoritesTask,
    verifyIdentity: (check: () => void) => Promise<Account>,
    onVerified: () => void
  ): Promise<FavoritesTask> {
    if (this.loop) throw new AppError('BUSY', '收藏同步正在进行，请稍后再核验。')
    return this.launch(task, { verifyIdentity, onVerified })
  }
  private async readCheckpoint(
    task: FavoritesTask,
    signal: AbortSignal,
    verifyIdentity: (check: () => void) => Promise<Account>
  ) {
    const { accountId, cursor } = task
    const operation = favoriteOperation(task)
    let attempted = false
    const guard = () => {
      if (signal.aborted) throw new AppError('CANCELLED', '收藏核验已停止。')
    }
    const read = (position: string) => {
      attempted = false
      return this.run(
        accountId,
        async (check) => {
          const valid = () => {
            check()
            guard()
          }
          valid()
          this.engine.assertAvailable?.(accountId, operation)
          this.activity = 'requesting'
          try {
            const account = await verifyIdentity(valid)
            valid()
            attempted = true
            const response = await this.engine.request(
              accountId,
              operation,
              this.parameters(position, task.folderId),
              {
                recovery: true,
                allowNullFavoritePage: true
              }
            )
            valid()
            const options = { allowEmpty: true, allowNullPage: true }
            const page =
              operation === 'folders'
                ? parseFavoriteFolders(response, options)
                : parseFavoritesPage(response, options)
            return { page, remoteId: account.remoteId! }
          } finally {
            this.activity = 'waiting'
          }
        },
        true
      )
    }
    const ids = (page: Awaited<ReturnType<typeof read>>['page']) =>
      'folders' in page ? page.folders.map((folder) => folder.id) : page.items.map((item) => item.id)
    const empty = (page: Awaited<ReturnType<typeof read>>['page']) =>
      'folders' in page ? page.folders.length === 0 : page.received === 0
    const unavailable = () => new AppError('FAVORITE_EMPTY_PAGE', '抖音暂未返回这一页内容，已保留进度。')
    try {
      let position = cursor
      let result = await read(cursor)
      if (result.page.hasMore && empty(result.page)) {
        const next = result.page.cursor
        if (next === cursor) throw unavailable()
        await this.wait(this.timing.retry, signal)
        result = await read(cursor)
        if (result.page.hasMore && empty(result.page)) {
          if (result.page.cursor !== next) throw unavailable()
          position = next
          await this.wait(this.timing.interval, signal)
          result = await read(position)
          if (!ids(result.page).length) throw unavailable()
        }
      }
      if (!result.page.hasMore) {
        const ending = new EndConfirmation()
        ending.check(position, ids(result.page), false)
        await this.wait(this.timing.retry, signal)
        result = await read(position)
        if ((result.page.hasMore || position !== cursor) && !ids(result.page).length) throw unavailable()
        if (!ending.check(position, ids(result.page), result.page.hasMore))
          throw new AppError('END_UNCONFIRMED', '收藏末页尚未确认，已保留进度。')
      }
      const skipped = position !== cursor
      const saved = await this.run(
        accountId,
        async (check) => {
          check()
          guard()
          return this.db.call('favoritesSave', {
            ...result.page,
            accountId,
            remoteId: result.remoteId,
            taskId: task.id,
            mode: task.mode,
            stage: task.stage,
            folderId: task.folderId,
            requestCursor: position,
            checkpointCursor: cursor,
            traversedCursors: skipped ? [cursor, position] : [cursor],
            incomplete: skipped && task.stage !== 'all',
            resumePausedAt: task.updatedAt
          })
        },
        true
      )
      this.checkpointChecks.delete(this.checkKey(task))
      if (skipped)
        this.report(accountId, {
          kind: 'task',
          operation,
          code: 'FAVORITE_PAGE_SKIPPED',
          message: '原页持续为空，已确认下一页可读，跳过一页并继续收藏采集。'
        })
      this.changed(true)
      return saved
    } catch (error) {
      guard()
      if (
        !(error instanceof AppError) ||
        (!definiteCheckpointErrors.has(error.code) && !uncertainCheckpointErrors.has(error.code))
      )
        throw error
      if (!attempted && error.retryAt !== undefined) throw error
      const prior = this.checkpointHealth(task)
      const rule = error.rule ?? (error.code === prior.code ? prior.rule : undefined)
      const definite = definiteCheckpointErrors.has(error.code) || rule === 'envelope.risk_code'
      const beforeRequest = ['BROWSER_NOT_READY', 'BROWSER_CRASHED', 'PAGE_CHANGED'].includes(error.code)
      const failures = prior.failures + Number(attempted && !definite && !beforeRequest)
      this.checkpointChecks.set(this.checkKey(task), {
        target: this.checkTarget(task),
        entry: {
          operation,
          code: error.code,
          rule,
          retryAt: error.retryAt,
          at: Date.now(),
          failures,
          status: definite || failures >= 5 ? 'abnormal' : 'uncertain',
          favoriteCheckpoint: true
        }
      })
      throw error
    }
  }
  private launch(
    task: FavoritesTask,
    verification?: {
      verifyIdentity: (check: () => void) => Promise<Account>
      onVerified: () => void
    }
  ) {
    this.current = task
    const controller = new AbortController()
    this.controller = controller
    const ready = verification
      ? this.readCheckpoint(task, controller.signal, verification.verifyIdentity)
      : Promise.resolve(task)
    this.loop = ready
      .then(
        async (saved) => {
          this.current = saved
          if (controller.signal.aborted) return
          verification?.onVerified()
          if (saved.status === 'running') {
            if (verification) await this.wait(this.timing.interval, controller.signal)
            await this.collect(saved, controller.signal)
          }
        },
        () => {}
      )
      .finally(() => {
        this.loop = null
        this.controller = null
        this.activity = null
        this.changed()
      })
    void this.loop.catch(() => console.error('[MyLike] Favorites task could not persist its state.'))
    this.changed()
    return ready
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
    let traversal = new EmptyPageTraversal(initial.cursor)
    let folderFailures = 0
    let task = initial,
      retries = 0,
      pages = 0,
      started = Date.now()
    const valid = () => {
      if (signal.aborted) throw new AppError('CANCELLED', '收藏同步已停止。')
    }
    while (!signal.aborted && task.status === 'running') {
      try {
        this.engine.assertAvailable?.(
          task.accountId,
          task.stage === 'all' ? 'favorites' : task.stage === 'folders' ? 'folders' : 'folderItems'
        )
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
                this.parameters(traversal.cursor, task.folderId)
              )
              guard()
              const page =
                task.stage === 'folders'
                  ? parseFavoriteFolders(result, { allowEmpty: true })
                  : parseFavoritesPage(result, { allowEmpty: true })
              const received = 'folders' in page ? page.folders.length : page.received
              if (page.hasMore && !received) {
                traversal.check(page.cursor)
                this.activity = 'probing'
                this.changed()
                return null
              }
              const ids =
                'folders' in page
                  ? page.folders.map((folder) => folder.id)
                  : page.items.map((item) => item.id)
              if (
                !ending.check(`${task.stage}:${task.folderId ?? ''}:${traversal.cursor}`, ids, page.hasMore)
              ) {
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
                mode: task.mode,
                remoteId: account.remoteId!,
                stage: task.stage,
                folderId: task.folderId,
                requestCursor: traversal.cursor,
                checkpointCursor: task.cursor,
                traversedCursors: traversal.requests,
                ...page,
                incomplete: traversal.requests.length > 1
              })
              this.changed(true)
              return saved
            } finally {
              if (this.activity !== 'confirming' && this.activity !== 'probing') this.activity = 'waiting'
            }
          },
          true
        )
        if (saved) {
          if (
            task.stage === 'folder' &&
            saved.folderId !== task.folderId &&
            !saved.issues?.some((i) => i.folderId === task.folderId)
          )
            folderFailures = 0
          this.checkpointChecks.delete(this.checkKey(task))
          task = saved
          retries = 0
          traversal = new EmptyPageTraversal(task.cursor)
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
        const recovery = readRecovery({
          source: 'favorites',
          code: detail.code,
          retries,
          baseDelay: this.timing.retry,
          visible: this.engine.snapshot().status === 'visible'
        })
        if (recovery) {
          this.activity = recovery.activity
          this.changed()
          if (recovery.rebuild) {
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
          retries++
          await this.wait(recovery.delay, signal)
          continue
        }
        if (
          task.mode !== 'update' &&
          task.stage === 'folder' &&
          task.folderId &&
          [
            'INVALID_RESPONSE',
            'UPSTREAM_CHANGED',
            'EMPTY_PAGE',
            'EMPTY_RESPONSE',
            'EMPTY_PAGE_LIMIT',
            'CURSOR_STALLED',
            'END_UNCONFIRMED'
          ].includes(detail.code) &&
          ++folderFailures < 3
        ) {
          const folderId = task.folderId
          try {
            task = await this.db.call('favoritesDefer', {
              accountId: task.accountId,
              taskId: task.id,
              folderId,
              requestCursor: task.cursor,
              reason: detail.message,
              errorCode: detail.code
            })
          } catch {
            await this.db.call('favoritesUpdate', {
              accountId: task.accountId,
              taskId: task.id,
              status: 'paused',
              reason: '收藏夹异常状态未能保存，已停止后续请求并保留原断点。',
              errorCode: 'STORAGE_ERROR'
            })
            return
          }
          this.report(task.accountId, {
            kind: 'task',
            operation: 'folderItems',
            code: 'FOLDER_DEFERRED',
            message: `收藏夹 ${folderId} 暂缓同步：${detail.message} 已保留原有分类并继续其他收藏夹。`
          })
          this.current = task
          retries = 0
          traversal = new EmptyPageTraversal(task.cursor)
          this.changed(true)
          continue
        }
        try {
          await this.db.call('favoritesUpdate', {
            accountId: task.accountId,
            taskId: task.id,
            mode: task.mode,
            status: 'paused',
            reason:
              folderFailures >= 3
                ? '连续多个收藏夹异常，可能为平台整体故障，已暂停并保留各夹断点。'
                : detail.message,
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
