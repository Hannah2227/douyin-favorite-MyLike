import type { DatabaseSync } from 'node:sqlite'
import type { FavoritesTask, FavoriteFolder, Work } from '../../shared/contracts'
import { AppError } from '../errors'

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
}
export class FavoritesStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: <T>(action: () => T) => T
  ) {}
  task(accountId: string): FavoritesTask | null {
    const row = this.db.prepare('SELECT * FROM saved_tasks WHERE accountId=?').get(accountId)
    if (!row) return null
    const counts = this.db
      .prepare(
        'SELECT count(*) AS foldersTotal,coalesce(sum(completed),0) AS foldersDone FROM saved_jobs WHERE taskId=?'
      )
      .get(row.id!)!
    return { ...row, ...counts } as unknown as FavoritesTask
  }
  folders(accountId: string): FavoriteFolder[] {
    return this.db
      .prepare(
        `SELECT f.id,f.title,f.remoteCount,(SELECT count(*) FROM saved_members m WHERE m.accountId=f.accountId AND m.folderId=f.id) AS localCount FROM saved_folders f WHERE f.accountId=? ORDER BY f.title,f.id`
      )
      .all(accountId) as unknown as FavoriteFolder[]
  }
  start(accountId: string, id: string): FavoritesTask {
    const previous = this.task(accountId)
    if (previous && previous.status !== 'completed')
      return this.update(accountId, previous.id, 'running', null)
    this.db.prepare('DELETE FROM saved_tasks WHERE accountId=?').run(accountId)
    this.db
      .prepare(
        "INSERT INTO saved_tasks(accountId,id,stage,cursor,status,updatedAt) VALUES(?,?,'all','0','running',?)"
      )
      .run(accountId, id, Date.now())
    return this.task(accountId)!
  }
  update(
    accountId: string,
    taskId: string,
    status: FavoritesTask['status'],
    reason: string | null,
    errorCode: string | null = null
  ): FavoritesTask {
    const task = this.task(accountId)
    if (!task || task.id !== taskId) throw new AppError('TASK_CHANGED', '收藏同步任务已变化，请重新读取。')
    if (task.status === 'completed' && status === 'running')
      throw new AppError('NO_MORE', '本轮同步已完成，请重新同步。')
    if (task.status !== 'completed')
      this.db
        .prepare('UPDATE saved_tasks SET status=?,reason=?,errorCode=?,updatedAt=? WHERE id=?')
        .run(status, reason, errorCode, Date.now(), taskId)
    return this.task(accountId)!
  }
  save(input: FavoritesPage): FavoritesTask {
    return this.transaction(() => {
      const task = this.task(input.accountId)
      if (
        !task ||
        task.id !== input.taskId ||
        task.status !== 'running' ||
        task.stage !== input.stage ||
        task.folderId !== input.folderId ||
        task.cursor !== input.requestCursor
      )
        throw new AppError('TASK_CHANGED', '收藏同步范围或断点已变化，本页未保存。')
      if (
        this.db.prepare('SELECT remoteId FROM accounts WHERE id=?').get(input.accountId)?.remoteId !==
        input.remoteId
      )
        throw new AppError('IDENTITY_MISMATCH', '账号身份已变化，本页未保存。')
      const scope = task.stage + ':' + (task.folderId ?? '')
      if (
        input.hasMore &&
        (input.cursor === task.cursor ||
          this.db
            .prepare('SELECT 1 FROM saved_cursors WHERE taskId=? AND scope=? AND cursor=?')
            .get(task.id, scope, input.cursor))
      )
        throw new AppError('CURSOR_STALLED', '收藏分页游标重复，已保留断点。')
      if (input.hasMore && !(input.items?.length || input.folders?.length))
        throw new AppError('INVALID_RESPONSE', '收藏接口返回异常空页，进度未推进。')
      this.db.prepare('INSERT OR IGNORE INTO saved_cursors VALUES(?,?,?)').run(task.id, scope, task.cursor)
      let added = 0
      for (const work of input.items ?? []) {
        this.db
          .prepare(
            'INSERT INTO works VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,author=excluded.author,publishedAt=excluded.publishedAt,coverUrl=excluded.coverUrl,mediaType=excluded.mediaType,isLive=excluded.isLive'
          )
          .run(
            work.id,
            work.title,
            work.author,
            work.publishedAt,
            work.coverUrl,
            work.mediaType,
            +work.isLive
          )
        added += Number(
          this.db
            .prepare('INSERT OR IGNORE INTO saved_items VALUES(?,?,?)')
            .run(input.accountId, work.id, Date.now()).changes
        )
        if (task.stage === 'folder')
          this.db
            .prepare(
              'INSERT INTO saved_members VALUES(?,?,?,?) ON CONFLICT(accountId,folderId,workId) DO UPDATE SET seenRun=excluded.seenRun'
            )
            .run(input.accountId, task.folderId, work.id, task.id)
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
      }
      let stage = task.stage,
        folderId = task.folderId,
        cursor = input.cursor,
        status: FavoritesTask['status'] = 'running'
      if (!input.hasMore) {
        if (task.stage === 'all') {
          stage = 'folders'
          cursor = '0'
        } else {
          if (task.stage === 'folders')
            this.db
              .prepare('DELETE FROM saved_folders WHERE accountId=? AND seenRun<>?')
              .run(input.accountId, task.id)
          else {
            const remoteCount = Number(
              this.db
                .prepare('SELECT remoteCount FROM saved_folders WHERE accountId=? AND id=?')
                .get(input.accountId, task.folderId)?.remoteCount ?? 0
            )
            if (task.cursor === '0' && !input.items?.length && remoteCount > 0)
              throw new AppError('INVALID_RESPONSE', '收藏夹返回空页但仍标有作品，已保留原有分类和断点。')
            this.db
              .prepare('DELETE FROM saved_members WHERE accountId=? AND folderId=? AND seenRun<>?')
              .run(input.accountId, task.folderId, task.id)
            this.db
              .prepare('UPDATE saved_jobs SET completed=1,cursor=? WHERE taskId=? AND folderId=?')
              .run(input.cursor, task.id, task.folderId)
          }
          const next = this.db
            .prepare(
              'SELECT folderId,cursor FROM saved_jobs WHERE taskId=? AND completed=0 ORDER BY position LIMIT 1'
            )
            .get(task.id)
          if (next) {
            stage = 'folder'
            folderId = String(next.folderId)
            cursor = String(next.cursor)
          } else {
            status = 'completed'
            folderId = null
            cursor = '0'
          }
        }
      } else if (task.stage === 'folder')
        this.db
          .prepare('UPDATE saved_jobs SET cursor=? WHERE taskId=? AND folderId=?')
          .run(input.cursor, task.id, task.folderId)
      this.db
        .prepare(
          'UPDATE saved_tasks SET stage=?,folderId=?,cursor=?,status=?,pages=pages+1,received=received+?,added=added+?,reason=?,errorCode=NULL,updatedAt=? WHERE id=?'
        )
        .run(
          stage,
          folderId,
          cursor,
          status,
          input.items?.length ?? 0,
          added,
          status === 'completed' ? '收藏作品和收藏夹均已同步到平台返回末尾。' : null,
          Date.now(),
          task.id
        )
      return this.task(input.accountId)!
    })
  }
}
