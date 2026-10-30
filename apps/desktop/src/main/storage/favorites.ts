import type { DatabaseSync } from 'node:sqlite'
import type { FavoritesTask, FavoriteFolder, Work } from '../../shared/contracts'
import { AppError } from '../errors'
import { randomUUID } from 'node:crypto'
import { FavoriteState } from './favorite-state'

export const favoritesMigration = `
ALTER TABLE playback_queues ADD COLUMN source TEXT NOT NULL DEFAULT 'likes';
CREATE TABLE saved_items(accountId TEXT NOT NULL REFERENCES accounts(id),workId TEXT NOT NULL REFERENCES works(id),firstSeen INTEGER NOT NULL,PRIMARY KEY(accountId,workId));
CREATE INDEX saved_items_work ON saved_items(workId);
CREATE TABLE saved_folders(accountId TEXT NOT NULL REFERENCES accounts(id),id TEXT NOT NULL,title TEXT NOT NULL,remoteCount INTEGER NOT NULL,seenRun TEXT NOT NULL,PRIMARY KEY(accountId,id));
CREATE TABLE saved_members(accountId TEXT NOT NULL,folderId TEXT NOT NULL,workId TEXT NOT NULL,seenRun TEXT NOT NULL,PRIMARY KEY(accountId,folderId,workId),FOREIGN KEY(accountId,folderId) REFERENCES saved_folders(accountId,id) ON DELETE CASCADE,FOREIGN KEY(accountId,workId) REFERENCES saved_items(accountId,workId) ON DELETE CASCADE);
CREATE INDEX saved_members_work ON saved_members(workId);
CREATE TABLE saved_tasks(accountId TEXT PRIMARY KEY REFERENCES accounts(id),id TEXT NOT NULL UNIQUE,stage TEXT NOT NULL,folderId TEXT,cursor TEXT NOT NULL,status TEXT NOT NULL,pages INTEGER NOT NULL DEFAULT 0,received INTEGER NOT NULL DEFAULT 0,added INTEGER NOT NULL DEFAULT 0,reason TEXT,errorCode TEXT,updatedAt INTEGER NOT NULL);
CREATE TABLE saved_jobs(taskId TEXT NOT NULL REFERENCES saved_tasks(id) ON DELETE CASCADE,folderId TEXT NOT NULL,position INTEGER NOT NULL,cursor TEXT NOT NULL DEFAULT '0',completed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(taskId,folderId));
CREATE TABLE saved_cursors(taskId TEXT NOT NULL REFERENCES saved_tasks(id) ON DELETE CASCADE,scope TEXT NOT NULL,cursor TEXT NOT NULL,PRIMARY KEY(taskId,scope,cursor));
PRAGMA user_version=6;
`
export type FavoritesPage = {
  accountId: string
  taskId: string
  remoteId: string
  stage: FavoritesTask['stage']
  folderId: string | null
  requestCursor: string
  cursor: string
  hasMore: boolean
  items?: Work[]
  folders?: Omit<FavoriteFolder, 'localCount'>[]
  mode?: 'sync' | 'update'
  skipped?: { position: number; workId?: string }[]
  received?: number
  incomplete?: boolean
  checkpointCursor?: string
  traversedCursors?: string[]
}
export class FavoritesStore {
  private readonly state: FavoriteState
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: <T>(action: () => T) => T
  ) {
    this.state = new FavoriteState(db)
  }
  task(accountId: string, mode: 'sync' | 'update' = 'sync'): FavoritesTask | null {
    if (mode === 'update') {
      const row = this.db.prepare('SELECT * FROM saved_updates WHERE accountId=?').get(accountId)
      return row
        ? ({
            ...row,
            mode,
            stage: 'all',
            folderId: null,
            foldersTotal: 0,
            foldersDone: 0,
            foldersDeferred: 0
          } as unknown as FavoritesTask)
        : null
    }
    const row = this.db.prepare('SELECT * FROM saved_tasks WHERE accountId=?').get(accountId)
    if (!row) return null
    const meta = this.state.ensure(String(row.id))
    const counts = this.db
      .prepare(
        'SELECT count(*) AS foldersTotal,coalesce(sum(j.completed),0) AS foldersDone,coalesce(sum(m.deferred),0) AS foldersDeferred FROM saved_jobs j JOIN saved_job_meta m USING(taskId,folderId) WHERE taskId=?'
      )
      .get(row.id!)!
    const issues = this.db
      .prepare(
        'SELECT j.folderId,coalesce(f.title,j.folderId) AS title,m.reason,m.errorCode FROM saved_jobs j JOIN saved_job_meta m USING(taskId,folderId) LEFT JOIN saved_folders f ON f.accountId=? AND f.id=j.folderId WHERE j.taskId=? AND m.deferred=1 ORDER BY j.position'
      )
      .all(accountId, row.id!)
    return {
      ...row,
      ...counts,
      incomplete: meta.incomplete,
      skipped: meta.skipped,
      status: meta.partial ? 'partial' : row.status,
      mode,
      issues
    } as unknown as FavoritesTask
  }
  private memberRun(accountId: string, folderId: string): string {
    return String(
      this.db
        .prepare(
          "SELECT coalesce(nullif(j.scanId,''),t.id) AS marker FROM saved_tasks t LEFT JOIN saved_job_meta j ON j.taskId=t.id AND j.folderId=? WHERE t.accountId=?"
        )
        .get(folderId, accountId)?.marker ?? 'manual'
    )
  }
  folders(accountId: string): FavoriteFolder[] {
    return this.db
      .prepare(
        `SELECT f.id,f.title,f.remoteCount,(SELECT count(*) FROM saved_members m WHERE m.accountId=f.accountId AND m.folderId=f.id) AS localCount FROM saved_folders f WHERE f.accountId=? ORDER BY f.title,f.id`
      )
      .all(accountId) as unknown as FavoriteFolder[]
  }
  status(accountId: string, workId: string): { collected: boolean } {
    return {
      collected: !!this.db
        .prepare('SELECT 1 FROM saved_items WHERE accountId=? AND workId=?')
        .get(accountId, workId)
    }
  }
  private verifyIdentity(accountId: string, remoteId: string): void {
    if (this.db.prepare('SELECT remoteId FROM accounts WHERE id=?').get(accountId)?.remoteId !== remoteId)
      throw new AppError('IDENTITY_MISMATCH', '账号身份已变化，收藏结果未写入其他账号。')
  }
  private remember(accountId: string, folder: FavoriteFolder): void {
    // A paused sync may finish later. Preserve this explicitly confirmed change
    // when that older scan prunes entries it did not encounter.
    const run = this.task(accountId)?.id ?? 'manual'
    this.db
      .prepare(
        `INSERT INTO saved_folders VALUES(?,?,?,?,?)
      ON CONFLICT(accountId,id) DO UPDATE SET title=excluded.title,remoteCount=max(saved_folders.remoteCount,excluded.remoteCount),seenRun=excluded.seenRun`
      )
      .run(accountId, folder.id, folder.title, folder.remoteCount, run)
  }
  rememberFolder(accountId: string, remoteId: string, folder: FavoriteFolder): FavoriteFolder {
    return this.transaction(() => {
      this.verifyIdentity(accountId, remoteId)
      this.remember(accountId, folder)
      return {
        ...folder,
        localCount: this.folders(accountId).find((entry) => entry.id === folder.id)!.localCount
      }
    })
  }
  confirm(input: { accountId: string; remoteId: string; work: Work; folder?: FavoriteFolder }): null {
    return this.transaction(() => {
      this.verifyIdentity(input.accountId, input.remoteId)
      const work = input.work
      this.db
        .prepare(
          `INSERT INTO works VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,author=excluded.author,publishedAt=excluded.publishedAt,coverUrl=excluded.coverUrl,mediaType=excluded.mediaType,isLive=excluded.isLive`
        )
        .run(work.id, work.title, work.author, work.publishedAt, work.coverUrl, work.mediaType, +work.isLive)
      this.db
        .prepare('INSERT OR IGNORE INTO saved_items VALUES(?,?,?)')
        .run(input.accountId, work.id, Date.now())
      if (input.folder) {
        this.remember(input.accountId, input.folder)
        const task = this.task(input.accountId)
        this.db
          .prepare(
            `INSERT INTO saved_members VALUES(?,?,?,?) ON CONFLICT(accountId,folderId,workId) DO UPDATE SET seenRun=excluded.seenRun`
          )
          .run(input.accountId, input.folder.id, work.id, task?.id ?? 'manual')
        if (task) this.state.seen(task.id, input.accountId, input.folder.id, work.id, '', true)
      }
      return null
    })
  }
  start(accountId: string, id: string, mode: 'sync' | 'update' = 'sync'): FavoritesTask {
    const previous = this.task(accountId, mode)
    if (previous && previous.status !== 'completed')
      return this.update(accountId, previous.id, 'running', null, null, mode)
    if (mode === 'update') {
      this.db.prepare('DELETE FROM saved_updates WHERE accountId=?').run(accountId)
      this.db
        .prepare(
          "INSERT INTO saved_updates(accountId,id,cursor,status,updatedAt) VALUES(?,?,'0','running',?)"
        )
        .run(accountId, id, Date.now())
      return this.task(accountId, mode)!
    }
    this.db.prepare('DELETE FROM saved_tasks WHERE accountId=?').run(accountId)
    this.db
      .prepare(
        "INSERT INTO saved_tasks(accountId,id,stage,cursor,status,updatedAt) VALUES(?,?,'all','0','running',?)"
      )
      .run(accountId, id, Date.now())
    this.state.touch(id)
    return this.task(accountId)!
  }
  update(
    accountId: string,
    taskId: string,
    status: FavoritesTask['status'],
    reason: string | null,
    errorCode: string | null = null,
    mode: 'sync' | 'update' = 'sync'
  ): FavoritesTask {
    const task = this.task(accountId, mode)
    if (!task || task.id !== taskId) throw new AppError('TASK_CHANGED', '收藏同步任务已变化，请重新读取。')
    if (task.status === 'completed' && status === 'running')
      throw new AppError('NO_MORE', '本轮同步已完成，请重新同步。')
    if (task.status === 'partial' && status !== 'running') return task
    if (task.status === 'partial' && status === 'running') {
      return this.transaction(() => {
        if (mode === 'update') {
          this.db.prepare("UPDATE saved_updates SET cursor='0',incomplete=0,skipped=0 WHERE id=?").run(taskId)
          this.db.prepare('DELETE FROM saved_update_cursors WHERE taskId=?').run(taskId)
        } else {
          const jobs = this.db
            .prepare('SELECT folderId FROM saved_job_meta WHERE taskId=? AND deferred=1')
            .all(taskId)
          for (const job of jobs) {
            this.state.importManual(taskId)
            this.db
              .prepare(
                'UPDATE saved_job_meta SET deferred=0,incomplete=0,scanId=?,reason=NULL,errorCode=NULL WHERE taskId=? AND folderId=?'
              )
              .run(randomUUID(), taskId, job.folderId!)
            this.db
              .prepare("UPDATE saved_jobs SET cursor='0',completed=0 WHERE taskId=? AND folderId=?")
              .run(taskId, job.folderId!)
            this.db
              .prepare("UPDATE saved_scan_members SET scanId='' WHERE taskId=? AND folderId=? AND manual=0")
              .run(taskId, job.folderId!)
            this.db
              .prepare('DELETE FROM saved_cursors WHERE taskId=? AND scope=?')
              .run(taskId, `folder:${job.folderId}`)
          }
          if (task.incomplete) {
            this.db
              .prepare("DELETE FROM saved_cursors WHERE taskId=? AND scope IN ('all:','folders:')")
              .run(taskId)
            this.db
              .prepare("UPDATE saved_tasks SET stage='all',folderId=NULL,cursor='0' WHERE id=?")
              .run(taskId)
            this.db.prepare('UPDATE saved_task_meta SET incomplete=0,skipped=0 WHERE taskId=?').run(taskId)
          } else this.advance(taskId)
          this.state.partial(taskId, false)
        }
        this.db
          .prepare(
            `UPDATE ${mode === 'update' ? 'saved_updates' : 'saved_tasks'} SET status='running',reason=NULL,errorCode=NULL,updatedAt=? WHERE id=?`
          )
          .run(Date.now(), taskId)
        if (mode !== 'update') this.state.touch(taskId)
        return this.task(accountId, mode)!
      })
    }
    if (task.status !== 'completed')
      this.db
        .prepare(
          `UPDATE ${mode === 'update' ? 'saved_updates' : 'saved_tasks'} SET status=?,reason=?,errorCode=?,updatedAt=? WHERE id=?`
        )
        .run(
          mode !== 'update' && status === 'partial' ? 'paused' : status,
          reason,
          errorCode,
          Date.now(),
          taskId
        )
    if (mode !== 'update') {
      this.state.partial(taskId, status === 'partial')
      this.state.touch(taskId)
    }
    return this.task(accountId, mode)!
  }
  private advance(taskId: string): void {
    const next = this.db
      .prepare(
        'SELECT j.folderId,j.cursor FROM saved_jobs j JOIN saved_job_meta m USING(taskId,folderId) WHERE taskId=? AND j.completed=0 AND m.deferred=0 ORDER BY j.position LIMIT 1'
      )
      .get(taskId)
    const warning = !!this.db
      .prepare(
        'SELECT 1 FROM saved_task_meta WHERE taskId=? AND incomplete<>0 UNION ALL SELECT 1 FROM saved_job_meta WHERE taskId=? AND deferred=1 LIMIT 1'
      )
      .get(taskId, taskId)
    const checkpoint = !next && warning ? this.state.legacyCheckpoint(taskId) : null
    this.db
      .prepare(
        'UPDATE saved_tasks SET stage=?,folderId=?,cursor=?,status=?,reason=?,errorCode=?,updatedAt=? WHERE id=?'
      )
      .run(
        checkpoint?.stage ?? 'folder',
        checkpoint?.folderId ?? next?.folderId ?? null,
        checkpoint?.cursor ?? next?.cursor ?? '0',
        next ? 'running' : warning ? 'paused' : 'completed',
        next
          ? null
          : warning
            ? '可处理的收藏夹已同步；部分条目或收藏夹待复查，原有分类已保留。'
            : '收藏作品和收藏夹均已同步到平台返回末尾。',
        !next && warning ? 'PARTIAL_SYNC' : null,
        Date.now(),
        taskId
      )
    this.state.partial(taskId, !next && warning)
    this.state.touch(taskId)
  }
  defer(input: {
    accountId: string
    taskId: string
    folderId: string
    requestCursor: string
    reason: string
    errorCode: string
  }): FavoritesTask {
    return this.transaction(() => {
      const task = this.task(input.accountId)
      if (
        !task ||
        task.id !== input.taskId ||
        task.status !== 'running' ||
        task.stage !== 'folder' ||
        task.folderId !== input.folderId ||
        task.cursor !== input.requestCursor
      )
        throw new AppError('TASK_CHANGED', '收藏夹任务已变化，旧结果未提交。')
      this.db
        .prepare(
          'UPDATE saved_job_meta SET deferred=1,incomplete=1,reason=?,errorCode=? WHERE taskId=? AND folderId=?'
        )
        .run(input.reason, input.errorCode, task.id, task.folderId)
      this.state.protect(task.id, input.accountId, task.folderId!)
      this.advance(task.id)
      return this.task(input.accountId)!
    })
  }
  private writeWork(accountId: string, work: Work): number {
    this.db
      .prepare(
        'INSERT INTO works VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,author=excluded.author,publishedAt=excluded.publishedAt,coverUrl=excluded.coverUrl,mediaType=excluded.mediaType,isLive=excluded.isLive'
      )
      .run(work.id, work.title, work.author, work.publishedAt, work.coverUrl, work.mediaType, +work.isLive)
    return Number(
      this.db.prepare('INSERT OR IGNORE INTO saved_items VALUES(?,?,?)').run(accountId, work.id, Date.now())
        .changes
    )
  }
  private saveUpdate(input: FavoritesPage): FavoritesTask {
    return this.transaction(() => {
      const task = this.task(input.accountId, 'update')
      if (
        !task ||
        task.id !== input.taskId ||
        task.status !== 'running' ||
        task.cursor !== (input.checkpointCursor ?? input.requestCursor)
      )
        throw new AppError('TASK_CHANGED', '收藏更新断点已变化，本页未保存。')
      this.verifyIdentity(input.accountId, input.remoteId)
      const known =
        !!input.items?.length &&
        !input.skipped?.length &&
        input.items.every(
          (item) =>
            !!this.db
              .prepare('SELECT 1 FROM saved_items WHERE accountId=? AND workId=?')
              .get(input.accountId, item.id)
        )
      const traversed = input.traversedCursors ?? [input.requestCursor]
      if (
        !traversed.length ||
        traversed.length > 6 ||
        traversed[0] !== task.cursor ||
        traversed.at(-1) !== input.requestCursor ||
        new Set(traversed).size !== traversed.length ||
        (input.hasMore &&
          (traversed.includes(input.cursor) ||
            this.db
              .prepare('SELECT 1 FROM saved_update_cursors WHERE taskId=? AND cursor=?')
              .get(task.id, input.cursor)))
      )
        throw new AppError('CURSOR_STALLED', '收藏更新游标重复或探查范围无效。')
      if (input.hasMore && !input.items?.length && !input.skipped?.length)
        throw new AppError('EMPTY_PAGE', '收藏更新返回异常空页，断点未推进。')
      for (const cursor of traversed)
        this.db.prepare('INSERT OR IGNORE INTO saved_update_cursors VALUES(?,?)').run(task.id, cursor)
      let added = 0
      for (const item of input.items ?? []) added += this.writeWork(input.accountId, item)
      const incomplete = task.incomplete || input.skipped?.length || input.incomplete ? 1 : 0
      const done = !input.hasMore || known
      this.db
        .prepare(
          'UPDATE saved_updates SET cursor=?,status=?,pages=pages+1,received=received+?,added=added+?,incomplete=?,skipped=skipped+?,reason=?,errorCode=?,updatedAt=? WHERE id=?'
        )
        .run(
          input.cursor,
          done ? (incomplete ? 'partial' : 'completed') : 'running',
          input.received ?? input.items?.length ?? 0,
          added,
          incomplete,
          input.skipped?.length ?? 0,
          done
            ? incomplete
              ? '收藏新增已更新，部分异常条目待复查。'
              : '收藏新增已更新，历史同步断点保留。'
            : null,
          done && incomplete ? 'PARTIAL_SYNC' : null,
          Date.now(),
          task.id
        )
      return this.task(input.accountId, 'update')!
    })
  }
  save(input: FavoritesPage): FavoritesTask {
    if (input.mode === 'update') return this.saveUpdate(input)
    return this.transaction(() => {
      const task = this.task(input.accountId)
      if (
        !task ||
        task.id !== input.taskId ||
        task.status !== 'running' ||
        task.stage !== input.stage ||
        task.folderId !== input.folderId ||
        task.cursor !== (input.checkpointCursor ?? input.requestCursor)
      )
        throw new AppError('TASK_CHANGED', '收藏同步范围或断点已变化，本页未保存。')
      if (
        this.db.prepare('SELECT remoteId FROM accounts WHERE id=?').get(input.accountId)?.remoteId !==
        input.remoteId
      )
        throw new AppError('IDENTITY_MISMATCH', '账号身份已变化，本页未保存。')
      const scope = task.stage + ':' + (task.folderId ?? '')
      const traversed = input.traversedCursors ?? [input.requestCursor]
      if (
        !traversed.length ||
        traversed.length > 6 ||
        traversed[0] !== task.cursor ||
        traversed.at(-1) !== input.requestCursor ||
        new Set(traversed).size !== traversed.length
      )
        throw new AppError('CURSOR_STALLED', '收藏空页探查范围无效，原断点保留。')
      if (
        input.hasMore &&
        (traversed.includes(input.cursor) ||
          this.db
            .prepare('SELECT 1 FROM saved_cursors WHERE taskId=? AND scope=? AND cursor=?')
            .get(task.id, scope, input.cursor))
      )
        throw new AppError('CURSOR_STALLED', '收藏分页游标重复，已保留断点。')
      if (input.hasMore && !(input.items?.length || input.folders?.length || input.skipped?.length))
        throw new AppError('INVALID_RESPONSE', '收藏接口返回异常空页，进度未推进。')
      for (const cursor of traversed)
        this.db.prepare('INSERT OR IGNORE INTO saved_cursors VALUES(?,?,?)').run(task.id, scope, cursor)
      const incomplete = !!input.skipped?.length || !!input.incomplete
      if (incomplete) {
        if (task.stage === 'folder')
          this.db
            .prepare('UPDATE saved_job_meta SET incomplete=1 WHERE taskId=? AND folderId=?')
            .run(task.id, task.folderId)
        else
          this.db
            .prepare('UPDATE saved_task_meta SET incomplete=incomplete|? WHERE taskId=?')
            .run(task.stage === 'all' ? 1 : 2, task.id)
        if (task.stage === 'folder') this.state.protect(task.id, input.accountId, task.folderId!)
        if (task.stage === 'folders')
          this.db
            .prepare('UPDATE saved_folders SET seenRun=? WHERE accountId=?')
            .run(task.id, input.accountId)
      }
      let added = 0
      const memberRun = task.stage === 'folder' ? this.memberRun(input.accountId, task.folderId!) : ''
      for (const work of input.items ?? []) {
        added += this.writeWork(input.accountId, work)
        if (task.stage === 'folder')
          this.db
            .prepare(
              'INSERT INTO saved_members VALUES(?,?,?,?) ON CONFLICT(accountId,folderId,workId) DO UPDATE SET seenRun=excluded.seenRun'
            )
            .run(input.accountId, task.folderId, work.id, task.id)
        if (task.stage === 'folder')
          this.state.seen(task.id, input.accountId, task.folderId!, work.id, memberRun)
      }
      for (const folder of input.folders ?? []) {
        this.db
          .prepare(
            'INSERT INTO saved_folders VALUES(?,?,?,?,?) ON CONFLICT(accountId,id) DO UPDATE SET title=excluded.title,remoteCount=excluded.remoteCount,seenRun=excluded.seenRun'
          )
          .run(input.accountId, folder.id, folder.title, folder.remoteCount, task.id)
        this.db
          .prepare(
            'INSERT OR IGNORE INTO saved_jobs(taskId,folderId,position) VALUES(?,?,(SELECT count(*) FROM saved_jobs WHERE taskId=?))'
          )
          .run(task.id, folder.id, task.id)
        this.db
          .prepare('INSERT OR IGNORE INTO saved_job_meta(taskId,folderId,scanId) VALUES(?,?,?)')
          .run(task.id, folder.id, randomUUID())
      }
      this.db
        .prepare(
          'UPDATE saved_tasks SET cursor=?,pages=pages+1,received=received+?,added=added+?,reason=NULL,errorCode=NULL,updatedAt=? WHERE id=?'
        )
        .run(input.cursor, input.received ?? input.items?.length ?? 0, added, Date.now(), task.id)
      this.db
        .prepare('UPDATE saved_task_meta SET skipped=skipped+? WHERE taskId=?')
        .run(input.skipped?.length ?? 0, task.id)
      if (!input.hasMore) {
        if (task.stage === 'all') {
          this.db.prepare("UPDATE saved_tasks SET stage='folders',cursor='0' WHERE id=?").run(task.id)
        } else {
          if (task.stage === 'folders') {
            if (!(this.state.read(task.id).incomplete & 2))
              this.db
                .prepare('DELETE FROM saved_folders WHERE accountId=? AND seenRun<>?')
                .run(input.accountId, task.id)
            this.db
              .prepare(
                'DELETE FROM saved_jobs WHERE taskId=? AND NOT EXISTS(SELECT 1 FROM saved_folders WHERE accountId=? AND id=saved_jobs.folderId)'
              )
              .run(task.id, input.accountId)
          } else {
            const oldMembers = Number(
              this.db
                .prepare('SELECT count(*) AS total FROM saved_members WHERE accountId=? AND folderId=?')
                .get(input.accountId, task.folderId)?.total ?? 0
            )
            if (
              task.cursor === '0' &&
              !input.items?.length &&
              !input.skipped?.length &&
              !input.incomplete &&
              oldMembers > 0
            )
              this.db
                .prepare('UPDATE saved_job_meta SET incomplete=1 WHERE taskId=? AND folderId=?')
                .run(task.id, task.folderId)
            const dirty = !!this.db
              .prepare('SELECT incomplete FROM saved_job_meta WHERE taskId=? AND folderId=?')
              .get(task.id, task.folderId)?.incomplete
            if (dirty) this.state.protect(task.id, input.accountId, task.folderId!)
            if (!dirty) {
              this.state.importManual(task.id)
              this.db
                .prepare(
                  'DELETE FROM saved_members WHERE accountId=? AND folderId=? AND NOT EXISTS(SELECT 1 FROM saved_scan_members s WHERE s.taskId=? AND s.accountId=saved_members.accountId AND s.folderId=saved_members.folderId AND s.workId=saved_members.workId AND (s.scanId=? OR s.manual=1))'
                )
                .run(input.accountId, task.folderId, task.id, memberRun)
            }
            this.db
              .prepare(
                'UPDATE saved_job_meta SET deferred=?,reason=?,errorCode=? WHERE taskId=? AND folderId=?'
              )
              .run(
                dirty ? 1 : 0,
                dirty ? '本轮存在异常条目或空页，旧分类保留，等待复查。' : null,
                dirty ? 'INCOMPLETE_FOLDER' : null,
                task.id,
                task.folderId
              )
            this.db
              .prepare('UPDATE saved_jobs SET completed=?,cursor=? WHERE taskId=? AND folderId=?')
              .run(dirty ? 0 : 1, input.cursor, task.id, task.folderId)
          }
          this.advance(task.id)
        }
      } else if (task.stage === 'folder')
        this.db
          .prepare('UPDATE saved_jobs SET cursor=? WHERE taskId=? AND folderId=?')
          .run(input.cursor, task.id, task.folderId)
      this.state.touch(task.id)
      return this.task(input.accountId)!
    })
  }
}
