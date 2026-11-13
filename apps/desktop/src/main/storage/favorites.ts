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
    const columns = new Set(
      (db.prepare('PRAGMA table_info(favorite_folder_links)').all() as { name: string }[]).map(
        (column) => column.name
      )
    )
    if (!columns.has('managedLocally'))
      db.exec('ALTER TABLE favorite_folder_links ADD COLUMN managedLocally INTEGER NOT NULL DEFAULT 0')
    if (!columns.has('localTitle')) db.exec('ALTER TABLE favorite_folder_links ADD COLUMN localTitle TEXT')
    if (!columns.has('hiddenLocally'))
      db.exec('ALTER TABLE favorite_folder_links ADD COLUMN hiddenLocally INTEGER NOT NULL DEFAULT 0')
    const folderOverrideColumns = new Set(
      (db.prepare('PRAGMA table_info(favorite_folder_overrides)').all() as { name: string }[]).map(
        (column) => column.name
      )
    )
    if (!folderOverrideColumns.has('synced'))
      db.exec('ALTER TABLE favorite_folder_overrides ADD COLUMN synced INTEGER NOT NULL DEFAULT 0')
    const memberOverrideColumns = new Set(
      (db.prepare('PRAGMA table_info(favorite_member_overrides)').all() as { name: string }[]).map(
        (column) => column.name
      )
    )
    if (!memberOverrideColumns.has('synced'))
      db.exec('ALTER TABLE favorite_member_overrides ADD COLUMN synced INTEGER NOT NULL DEFAULT 0')
    if (!memberOverrideColumns.has('updatedAt'))
      db.exec('ALTER TABLE favorite_member_overrides ADD COLUMN updatedAt INTEGER NOT NULL DEFAULT 0')
    const folderColumns = new Set(
      (db.prepare('PRAGMA table_info(saved_folders)').all() as { name: string }[]).map(
        (column) => column.name
      )
    )
    // Timestamps let a sync merge local intent with cloud changes instead of
    // simply overwriting one side with the other.
    if (!folderColumns.has('syncedAt'))
      db.exec('ALTER TABLE saved_folders ADD COLUMN syncedAt INTEGER NOT NULL DEFAULT 0')
    db.prepare(
      "UPDATE favorite_folder_links SET managedLocally=1 WHERE managedLocally=0 AND (localOnly=1 OR localId LIKE 'local-%')"
    ).run()
    db.prepare(
      'INSERT OR IGNORE INTO favorite_folder_links(accountId,localId,remoteId,localOnly) SELECT accountId,id,id,0 FROM saved_folders'
    ).run()
    // A resumed task could previously persist `stage='folder'` without a folder
    // id. Requesting folder items without `collects_id` is rejected by the
    // platform (status_code 4), so restore such tasks to the folder-list stage.
    db.prepare(
      "UPDATE saved_tasks SET stage='folders',folderId=NULL,cursor='0',status='paused',reason='收藏夹任务阶段无效，已重置为重新同步收藏夹列表。',errorCode='STAGE_INVALID',updatedAt=? WHERE stage='folder' AND folderId IS NULL AND status<>'completed'"
    ).run(Date.now())
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
            folderTitle: null,
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
    const folderTitle = row.folderId
      ? String(
          this.db
            .prepare(
              `SELECT coalesce(f.title,l.localTitle,l.remoteId) AS title
              FROM favorite_folder_links l
              LEFT JOIN saved_folders f ON f.accountId=l.accountId AND f.id=l.localId
              WHERE l.accountId=? AND l.remoteId=?`
            )
            .get(accountId, row.folderId)?.title ?? row.folderId
        )
      : null
    return {
      ...row,
      ...counts,
      folderTitle,
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
    const folders = this.db
      .prepare(
        `SELECT f.id,l.remoteId,l.localOnly,l.managedLocally,
        coalesce(l.localTitle,f.title) AS title,f.remoteCount,l.isPrivate AS isPrivate,
        (SELECT count(*) FROM saved_members m WHERE m.accountId=f.accountId AND m.folderId=f.id) AS localCount,
        (SELECT count(*) FROM favorite_write_ops w
          WHERE w.accountId=f.accountId AND w.folderId=f.id) +
        (SELECT count(*) FROM favorite_member_overrides o
          WHERE o.accountId=f.accountId AND o.folderId=f.id AND o.desired=1 AND o.synced=0)
          AS pendingWrites
        FROM saved_folders f LEFT JOIN favorite_folder_links l ON l.accountId=f.accountId AND l.localId=f.id
        WHERE f.accountId=? AND coalesce(l.hiddenLocally,0)=0 ORDER BY title,f.id`
      )
      .all(accountId) as unknown as {
      id: string
      remoteId: string | null
      localOnly: number | null
      managedLocally: number | null
      isPrivate: number | null
      title: string
      remoteCount: number
      localCount: number
      pendingWrites: number
      private?: boolean
      coverUrl?: string | null
    }[]
    return folders.map((folder) => ({
      ...folder,
      remoteId: folder.remoteId ?? null,
      localOnly: !!folder.localOnly,
      managedLocally: !!folder.managedLocally,
      pendingWrites: folder.pendingWrites,
      private: !!folder.isPrivate
    }))
  }
  hiddenRemoteFolderIds(accountId: string): string[] {
    return (
      this.db
        .prepare(
          'SELECT remoteId FROM favorite_folder_links WHERE accountId=? AND hiddenLocally=1 AND remoteId IS NOT NULL'
        )
        .all(accountId) as { remoteId: string }[]
    ).map(({ remoteId }) => remoteId)
  }
  localFolderCreate(input: {
    accountId: string
    remoteId: string
    id: string
    title: string
    private: boolean
    queueWrite: boolean
  }): FavoriteFolder {
    return this.transaction(() => {
      if (input.remoteId) this.verifyIdentity(input.accountId, input.remoteId)
      if (this.folders(input.accountId).some((folder) => folder.title === input.title))
        throw new AppError('FOLDER_EXISTS', '已有同名收藏夹，请直接选择。')
      const run = this.task(input.accountId)?.id ?? 'manual'
      this.db
        .prepare('INSERT INTO saved_folders(accountId,id,title,remoteCount,seenRun) VALUES(?,?,?,0,?)')
        .run(input.accountId, input.id, input.title, run)
      this.db
        .prepare(
          'INSERT INTO favorite_folder_links(accountId,localId,remoteId,localOnly,isPrivate,managedLocally) VALUES(?,?,NULL,1,?,1)'
        )
        .run(input.accountId, input.id, +input.private)
      if (input.queueWrite)
        this.queue(input.accountId, 'folder-create', input.id, '', input.title, input.private)
      return {
        id: input.id,
        remoteId: null,
        localOnly: true,
        managedLocally: true,
        title: input.title,
        remoteCount: 0,
        localCount: 0,
        private: input.private
      }
    })
  }
  localFolderEdit(input: { accountId: string; folderId: string; title: string }): FavoriteFolder {
    return this.transaction(() => {
      const folder = this.folders(input.accountId).find((entry) => entry.id === input.folderId)
      if (!folder?.managedLocally)
        throw new AppError('LOCAL_FOLDER_ONLY', '只有本地创建的收藏夹可以在本机改名。')
      if (
        this.folders(input.accountId).some(
          (entry) => entry.id !== input.folderId && entry.title === input.title
        )
      )
        throw new AppError('FOLDER_EXISTS', '已有同名收藏夹，请选择其他名称。')
      this.db
        .prepare('UPDATE saved_folders SET title=? WHERE accountId=? AND id=?')
        .run(input.title, input.accountId, input.folderId)
      this.db
        .prepare('UPDATE favorite_folder_links SET localTitle=? WHERE accountId=? AND localId=?')
        .run(input.title, input.accountId, input.folderId)
      this.db
        .prepare(
          "UPDATE favorite_write_ops SET title=? WHERE accountId=? AND folderId=? AND kind='folder-create'"
        )
        .run(input.title, input.accountId, input.folderId)
      return this.folders(input.accountId).find((entry) => entry.id === input.folderId)!
    })
  }
  localFolderDelete(input: { accountId: string; folderId: string }): {
    folderId: string
    title: string
    localCount: number
  } {
    return this.transaction(() => {
      const folder = this.folders(input.accountId).find((entry) => entry.id === input.folderId)
      if (!folder?.managedLocally)
        throw new AppError('LOCAL_FOLDER_ONLY', '只有本地创建的收藏夹可以在本机删除。')
      const result = {
        folderId: folder.id,
        title: folder.title,
        localCount: folder.localCount
      }
      this.db
        .prepare('DELETE FROM favorite_write_ops WHERE accountId=? AND folderId=?')
        .run(input.accountId, input.folderId)
      this.db
        .prepare('DELETE FROM favorite_folder_overrides WHERE accountId=? AND folderId=?')
        .run(input.accountId, input.folderId)
      this.db
        .prepare('DELETE FROM favorite_member_overrides WHERE accountId=? AND folderId=?')
        .run(input.accountId, input.folderId)
      if (folder.remoteId && !folder.localOnly) {
        this.db
          .prepare('UPDATE favorite_folder_links SET hiddenLocally=1 WHERE accountId=? AND localId=?')
          .run(input.accountId, input.folderId)
        this.db
          .prepare('DELETE FROM saved_members WHERE accountId=? AND folderId=?')
          .run(input.accountId, input.folderId)
      } else {
        this.db
          .prepare('DELETE FROM favorite_folder_links WHERE accountId=? AND localId=?')
          .run(input.accountId, input.folderId)
        this.db
          .prepare('DELETE FROM saved_folders WHERE accountId=? AND id=?')
          .run(input.accountId, input.folderId)
      }
      return result
    })
  }
  queueWrite(input: {
    accountId: string
    remoteId: string
    kind: 'favorite-add' | 'folder-add' | 'folder-remove'
    folderId?: string
    workId?: string
  }): null {
    return this.transaction(() => {
      if (input.remoteId) this.verifyIdentity(input.accountId, input.remoteId)
      const folderId = input.folderId ?? ''
      const workId = input.workId ?? ''
      if (input.kind !== 'favorite-add' && !folderId)
        throw new AppError('INVALID_INPUT', '收藏夹写回缺少收藏夹标识。')
      if (
        (input.kind === 'favorite-add' || input.kind === 'folder-add' || input.kind === 'folder-remove') &&
        !workId
      )
        throw new AppError('INVALID_INPUT', '作品写回缺少作品标识。')
      if (input.kind === 'folder-add') {
        const link = this.db
          .prepare('SELECT localOnly FROM favorite_folder_links WHERE accountId=? AND localId=?')
          .get(input.accountId, folderId)
        if (link?.localOnly)
          this.queue(
            input.accountId,
            'folder-create',
            folderId,
            '',
            String(
              this.db
                .prepare('SELECT title FROM saved_folders WHERE accountId=? AND id=?')
                .get(input.accountId, folderId)?.title ?? ''
            ),
            false
          )
      }
      this.queue(input.accountId, input.kind, folderId, workId)
      return null
    })
  }
  writeOps(accountId: string): {
    id: number
    kind: 'favorite-add' | 'folder-add' | 'folder-remove' | 'folder-create'
    folderId: string | null
    workId: string | null
    title: string | null
    private: boolean | null
  }[] {
    return this.db
      .prepare(
        `SELECT id,kind,nullif(folderId,'') AS folderId,nullif(workId,'') AS workId,
        CASE WHEN kind='folder-create' THEN title ELSE NULL END AS title,
        CASE WHEN kind='folder-create' THEN isPrivate ELSE NULL END AS private
        FROM favorite_write_ops WHERE accountId=? ORDER BY id`
      )
      .all(accountId) as unknown as ReturnType<FavoritesStore['writeOps']>
  }
  writePending(accountId: string): number {
    const operations = this.writeOps(accountId)
    const queued = new Set(
      operations.map(
        (operation) => `${operation.kind}\u0000${operation.folderId ?? ''}\u0000${operation.workId ?? ''}`
      )
    )
    let pending = operations.length
    for (const folder of this.folders(accountId).filter((entry) => entry.localOnly)) {
      const createKey = `folder-create\u0000${folder.id}\u0000`
      if (!queued.has(createKey)) {
        queued.add(createKey)
        pending++
      }
      const members = this.db
        .prepare('SELECT workId FROM saved_members WHERE accountId=? AND folderId=?')
        .all(accountId, folder.id) as { workId: string }[]
      for (const member of members) {
        const addKey = `folder-add\u0000${folder.id}\u0000${member.workId}`
        if (!queued.has(addKey)) {
          queued.add(addKey)
          pending++
        }
      }
    }
    const addMissing = (query: string, key: (row: Record<string, string>) => string) => {
      for (const row of this.db.prepare(query).all(accountId) as Record<string, string>[]) {
        const operationKey = key(row)
        if (!queued.has(operationKey)) {
          queued.add(operationKey)
          pending++
        }
      }
    }
    addMissing(
      'SELECT workId FROM favorite_default_overrides WHERE accountId=? AND synced=0',
      (row) => `favorite-add\u0000\u0000${row.workId}`
    )
    addMissing(
      'SELECT folderId,workId FROM favorite_member_overrides WHERE accountId=? AND desired=1 AND synced=0',
      (row) => `folder-add\u0000${row.folderId}\u0000${row.workId}`
    )
    return pending
  }
  folderWorkIds(input: { accountId: string; folderId: string }): string[] {
    if (!this.folders(input.accountId).some((folder) => folder.id === input.folderId))
      throw new AppError('FOLDER_CHANGED', '收藏夹已变化，请重新读取。')
    return (
      this.db
        .prepare('SELECT workId FROM saved_members WHERE accountId=? AND folderId=?')
        .all(input.accountId, input.folderId) as { workId: string }[]
    ).map(({ workId }) => workId)
  }
  stageLocalFolders(input: {
    accountId: string
    remoteId: string
    folderIds?: string[]
    includeDefault?: boolean
  }): number {
    return this.transaction(() => {
      this.verifyIdentity(input.accountId, input.remoteId)
      const selectedFolders = input.folderIds
        ? new Set(input.folderIds)
        : new Set(this.folders(input.accountId).map((folder) => folder.id))
      for (const folder of this.folders(input.accountId).filter(
        (entry) => entry.localOnly && selectedFolders.has(entry.id)
      )) {
        this.queue(input.accountId, 'folder-create', folder.id, '', folder.title, !!folder.private)
        const members = this.db
          .prepare('SELECT workId FROM saved_members WHERE accountId=? AND folderId=?')
          .all(input.accountId, folder.id) as { workId: string }[]
        for (const member of members) this.queue(input.accountId, 'folder-add', folder.id, member.workId)
      }
      const defaults = this.db
        .prepare('SELECT workId FROM favorite_default_overrides WHERE accountId=? AND synced=0')
        .all(input.accountId) as { workId: string }[]
      const selectedMemberWorkIds = new Set(
        (
          this.db
            .prepare(
              `SELECT DISTINCT folderId,workId FROM favorite_member_overrides
              WHERE accountId=? AND desired=1 AND synced=0`
            )
            .all(input.accountId) as { folderId: string; workId: string }[]
        )
          .filter((item) => selectedFolders.has(item.folderId))
          .map((item) => item.workId)
      )
      for (const item of defaults)
        if (input.includeDefault || selectedMemberWorkIds.has(item.workId))
          this.queue(input.accountId, 'favorite-add', '', item.workId)
      const members = this.db
        .prepare(
          `SELECT folderId,workId FROM favorite_member_overrides
          WHERE accountId=? AND desired=1 AND synced=0`
        )
        .all(input.accountId) as { folderId: string; workId: string }[]
      for (const member of members)
        if (selectedFolders.has(member.folderId))
          this.queue(input.accountId, 'folder-add', member.folderId, member.workId)
      return this.writeOps(input.accountId).length
    })
  }
  writeComplete(accountId: string, operationId: number): null {
    return this.transaction(() => {
      const operation = this.db
        .prepare('SELECT kind,folderId,workId FROM favorite_write_ops WHERE accountId=? AND id=?')
        .get(accountId, operationId) as { kind: string; folderId: string; workId: string } | undefined
      if (operation?.kind === 'favorite-add')
        this.db
          .prepare('UPDATE favorite_default_overrides SET synced=1 WHERE accountId=? AND workId=?')
          .run(accountId, operation.workId)
      if (operation?.kind === 'folder-add')
        this.db
          .prepare(
            'UPDATE favorite_member_overrides SET synced=1 WHERE accountId=? AND folderId=? AND workId=? AND desired=1'
          )
          .run(accountId, operation.folderId, operation.workId)
      this.db.prepare('DELETE FROM favorite_write_ops WHERE accountId=? AND id=?').run(accountId, operationId)
      return null
    })
  }
  linkFolder(input: {
    accountId: string
    folderId: string
    remoteId: string
    title?: string
    remoteCount?: number
    private?: boolean
  }): null {
    return this.transaction(() => {
      const collision = this.db
        .prepare('SELECT localId FROM favorite_folder_links WHERE accountId=? AND remoteId=? AND localId<>?')
        .get(input.accountId, input.remoteId, input.folderId)
      if (collision) {
        const previousId = String(collision.localId)
        this.db
          .prepare(
            `INSERT INTO saved_members(accountId,folderId,workId,seenRun)
            SELECT accountId,?,workId,seenRun FROM saved_members WHERE accountId=? AND folderId=?
            ON CONFLICT(accountId,folderId,workId) DO NOTHING`
          )
          .run(input.folderId, input.accountId, previousId)
        this.db
          .prepare(
            `INSERT OR IGNORE INTO favorite_member_overrides(accountId,folderId,workId,desired)
            SELECT accountId,?,workId,desired FROM favorite_member_overrides WHERE accountId=? AND folderId=?`
          )
          .run(input.folderId, input.accountId, previousId)
        this.db
          .prepare('DELETE FROM favorite_member_overrides WHERE accountId=? AND folderId=?')
          .run(input.accountId, previousId)
        this.db
          .prepare(
            `UPDATE favorite_write_ops SET folderId=?
            WHERE accountId=? AND folderId=? AND NOT EXISTS(
              SELECT 1 FROM favorite_write_ops current
              WHERE current.accountId=? AND current.folderId=? AND current.kind=favorite_write_ops.kind AND current.workId=favorite_write_ops.workId
            )`
          )
          .run(input.folderId, input.accountId, previousId, input.accountId, input.folderId)
        this.db
          .prepare('DELETE FROM favorite_write_ops WHERE accountId=? AND folderId=?')
          .run(input.accountId, previousId)
        this.db
          .prepare('DELETE FROM saved_folders WHERE accountId=? AND id=?')
          .run(input.accountId, previousId)
        this.db
          .prepare('DELETE FROM favorite_folder_links WHERE accountId=? AND localId=?')
          .run(input.accountId, previousId)
      }
      this.db
        .prepare(
          `INSERT INTO favorite_folder_links(accountId,localId,remoteId,localOnly,isPrivate,managedLocally,localTitle,hiddenLocally)
          VALUES(?,?,?,0,?,0,NULL,0)
          ON CONFLICT(accountId,localId) DO UPDATE SET
          remoteId=excluded.remoteId,localOnly=0,isPrivate=excluded.isPrivate,localTitle=NULL`
        )
        .run(input.accountId, input.folderId, input.remoteId, +!!input.private)
      this.db
        .prepare(
          `UPDATE saved_folders SET title=coalesce(?,title),remoteCount=coalesce(?,remoteCount)
          WHERE accountId=? AND id=?`
        )
        .run(input.title ?? null, input.remoteCount ?? null, input.accountId, input.folderId)
      return null
    })
  }
  private queue(
    accountId: string,
    kind: string,
    folderId: string,
    workId: string,
    title = '',
    isPrivate = false
  ): void {
    this.db
      .prepare(
        `INSERT INTO favorite_write_ops(accountId,kind,folderId,workId,title,isPrivate,createdAt)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(accountId,kind,folderId,workId)
        DO UPDATE SET title=excluded.title,isPrivate=excluded.isPrivate`
      )
      .run(accountId, kind, folderId, workId, title, +isPrivate, Date.now())
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
        `INSERT INTO saved_folders(accountId,id,title,remoteCount,seenRun) VALUES(?,?,?,?,?)
      ON CONFLICT(accountId,id) DO UPDATE SET title=excluded.title,remoteCount=max(saved_folders.remoteCount,excluded.remoteCount),seenRun=excluded.seenRun`
      )
      .run(accountId, folder.id, folder.title, folder.remoteCount, run)
  }
  rememberFolder(accountId: string, remoteId: string, folder: FavoriteFolder): FavoriteFolder {
    return this.transaction(() => {
      this.verifyIdentity(accountId, remoteId)
      this.remember(accountId, folder)
      this.db
        .prepare(
          `INSERT INTO favorite_folder_links(accountId,localId,remoteId,localOnly,isPrivate,managedLocally)
          VALUES(?,?,?,?,?,?)
          ON CONFLICT(accountId,localId) DO UPDATE SET
          remoteId=coalesce(excluded.remoteId,favorite_folder_links.remoteId),
          localOnly=min(favorite_folder_links.localOnly,excluded.localOnly),isPrivate=excluded.isPrivate,
          managedLocally=max(favorite_folder_links.managedLocally,excluded.managedLocally)`
        )
        .run(
          accountId,
          folder.id,
          folder.remoteId ?? (folder.localOnly ? null : folder.id),
          +!!folder.localOnly,
          +!!folder.private,
          +(!!folder.managedLocally || !!folder.localOnly)
        )
      return {
        ...folder,
        localCount: this.folders(accountId).find((entry) => entry.id === folder.id)!.localCount
      }
    })
  }
  confirm(input: {
    accountId: string
    remoteId: string
    work: Work
    folder?: FavoriteFolder
    queueWrite?: boolean
    queueFavoriteAdd?: boolean
    favoriteAddIntent?: boolean
    /** The caller already confirmed this change with the platform. */
    synced?: boolean
  }): null {
    return this.transaction(() => {
      if (input.remoteId) this.verifyIdentity(input.accountId, input.remoteId)
      const work = input.work
      this.db
        .prepare(
          `INSERT INTO works(id,title,author,publishedAt,coverUrl,mediaType,isLive,authorId) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,author=excluded.author,publishedAt=excluded.publishedAt,coverUrl=coalesce(excluded.coverUrl,works.coverUrl),mediaType=excluded.mediaType,isLive=excluded.isLive,authorId=coalesce(excluded.authorId,works.authorId)`
        )
        .run(
          work.id,
          work.title,
          work.author,
          work.publishedAt,
          work.coverUrl,
          work.mediaType,
          +work.isLive,
          work.authorId ?? null
        )
      this.db
        .prepare('INSERT OR IGNORE INTO saved_items VALUES(?,?,?)')
        .run(input.accountId, work.id, Date.now())
      if (input.folder) {
        this.remember(input.accountId, input.folder)
        this.db
          .prepare(
            `INSERT INTO favorite_folder_links(accountId,localId,remoteId,localOnly,isPrivate,managedLocally)
            VALUES(?,?,?,?,?,?)
            ON CONFLICT(accountId,localId) DO UPDATE SET
            remoteId=coalesce(excluded.remoteId,favorite_folder_links.remoteId),
            localOnly=min(favorite_folder_links.localOnly,excluded.localOnly),isPrivate=excluded.isPrivate,
            managedLocally=max(favorite_folder_links.managedLocally,excluded.managedLocally)`
          )
          .run(
            input.accountId,
            input.folder.id,
            input.folder.remoteId ?? (input.folder.localOnly ? null : input.folder.id),
            +!!input.folder.localOnly,
            +!!input.folder.private,
            +(!!input.folder.managedLocally || !!input.folder.localOnly)
          )
        const task = this.task(input.accountId)
        this.db
          .prepare(
            `INSERT INTO saved_members VALUES(?,?,?,?) ON CONFLICT(accountId,folderId,workId) DO UPDATE SET seenRun=excluded.seenRun`
          )
          .run(input.accountId, input.folder.id, work.id, task?.id ?? 'manual')
        if (task) this.state.seen(task.id, input.accountId, input.folder.id, work.id, '', true)
        this.db
          .prepare(
            `INSERT INTO favorite_member_overrides(accountId,folderId,workId,desired,synced,updatedAt) VALUES(?,?,?,1,?,?)
            ON CONFLICT(accountId,folderId,workId) DO UPDATE SET desired=1,synced=excluded.synced,updatedAt=excluded.updatedAt`
          )
          .run(input.accountId, input.folder.id, work.id, input.synced ? 1 : 0, Date.now())
        if (input.queueWrite) {
          const link = this.db
            .prepare('SELECT localOnly FROM favorite_folder_links WHERE accountId=? AND localId=?')
            .get(input.accountId, input.folder.id)
          if (link?.localOnly)
            this.queue(
              input.accountId,
              'folder-create',
              input.folder.id,
              '',
              input.folder.title,
              !!input.folder.private
            )
          this.queue(input.accountId, 'folder-add', input.folder.id, work.id)
        }
      }
      if (input.favoriteAddIntent) {
        this.db
          .prepare(
            `INSERT INTO favorite_default_overrides(accountId,workId,synced) VALUES(?,?,?)
            ON CONFLICT(accountId,workId) DO UPDATE SET synced=excluded.synced`
          )
          .run(input.accountId, work.id, input.synced ? 1 : 0)
      }
      if (input.queueFavoriteAdd) this.queue(input.accountId, 'favorite-add', '', work.id)
      return null
    })
  }
  forgetFolderWork(input: {
    accountId: string
    remoteId: string
    folderId: string
    workId: string
    /** The caller already removed the cloud copy (or no cloud copy exists). */
    synced?: boolean
  }): null {
    return this.transaction(() => {
      if (input.remoteId) this.verifyIdentity(input.accountId, input.remoteId)
      const result = this.db
        .prepare('DELETE FROM saved_members WHERE accountId=? AND folderId=? AND workId=?')
        .run(input.accountId, input.folderId, input.workId)
      if (result.changes)
        this.db
          .prepare('UPDATE saved_folders SET remoteCount=max(0,remoteCount-1) WHERE accountId=? AND id=?')
          .run(input.accountId, input.folderId)
      // Keep the removal intent so a later sync cannot silently re-add a work
      // that is still present in the cloud because the remote write failed.
      this.db
        .prepare(
          `INSERT INTO favorite_member_overrides(accountId,folderId,workId,desired,synced,updatedAt) VALUES(?,?,?,0,?,?)
          ON CONFLICT(accountId,folderId,workId) DO UPDATE SET desired=0,synced=excluded.synced,updatedAt=excluded.updatedAt`
        )
        .run(input.accountId, input.folderId, input.workId, input.synced === false ? 0 : 1, Date.now())
      return null
    })
  }
  start(
    accountId: string,
    id: string,
    mode: 'sync' | 'update' = 'sync',
    stage: 'all' | 'folders' = 'all'
  ): FavoritesTask {
    const previous = this.task(accountId, mode)
    if (previous && previous.status !== 'completed') {
      // An explicit "sync folders" request always re-reads the collection list
      // instead of resuming a task that may already be past that stage (or in
      // the invalid folder stage without a folder id).
      if (mode === 'sync' && stage === 'folders') {
        return this.transaction(() => {
          this.db
            .prepare(
              "UPDATE saved_tasks SET stage='folders',folderId=NULL,cursor='0',status='running',reason=NULL,errorCode=NULL,updatedAt=? WHERE id=?"
            )
            .run(Date.now(), previous.id)
          // Re-verify every folder's contents. Trusting jobs completed by an
          // earlier run would leave local memberships stale whenever the cloud
          // changed after that run, which is what users see as count mismatches.
          const jobs = this.db.prepare('SELECT folderId FROM saved_jobs WHERE taskId=?').all(previous.id) as {
            folderId: string
          }[]
          for (const job of jobs) {
            this.db
              .prepare("UPDATE saved_jobs SET completed=0,cursor='0' WHERE taskId=? AND folderId=?")
              .run(previous.id, job.folderId)
            this.db
              .prepare(
                'UPDATE saved_job_meta SET deferred=0,incomplete=0,reason=NULL,errorCode=NULL,scanId=? WHERE taskId=? AND folderId=?'
              )
              .run(randomUUID(), previous.id, job.folderId)
          }
          this.db
            .prepare('UPDATE saved_task_meta SET incomplete=0,skipped=0,partial=0 WHERE taskId=?')
            .run(previous.id)
          this.db
            .prepare("UPDATE saved_scan_members SET scanId='' WHERE taskId=? AND manual=0")
            .run(previous.id)
          this.db.prepare('DELETE FROM saved_cursors WHERE taskId=?').run(previous.id)
          this.state.touch(previous.id)
          return this.task(accountId, mode)!
        })
      }
      return this.update(accountId, previous.id, 'running', null, null, mode)
    }
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
        `INSERT INTO saved_tasks(accountId,id,stage,cursor,status,updatedAt) VALUES(?,?,?,'0','running',?)`
      )
      .run(accountId, id, stage, Date.now())
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
          } else {
            // Clear the stale partial flag before advancing; advance() re-derives it.
            this.state.partial(taskId, false)
            this.advance(taskId)
          }
        }
        // Advancing may already have confirmed that nothing remains. Never force
        // a finished task back to running with an empty folder stage.
        const advanced = this.task(accountId, mode)!
        if (mode !== 'update' && advanced.status === 'completed') return advanced
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
    // Never leave a non-completed task in the folder stage without a folder id:
    // folder items cannot be requested without `collects_id`.
    const stage = checkpoint?.stage ?? (next ? 'folder' : 'folders')
    this.db
      .prepare(
        'UPDATE saved_tasks SET stage=?,folderId=?,cursor=?,status=?,reason=?,errorCode=?,updatedAt=? WHERE id=?'
      )
      .run(
        stage,
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
      const localFolderId = String(
        this.db
          .prepare('SELECT localId FROM favorite_folder_links WHERE accountId=? AND remoteId=?')
          .get(input.accountId, task.folderId)?.localId ?? task.folderId
      )
      this.state.protect(task.id, input.accountId, localFolderId)
      this.advance(task.id)
      return this.task(input.accountId)!
    })
  }
  private writeWork(accountId: string, work: Work): number {
    this.db
      .prepare(
        'INSERT INTO works(id,title,author,publishedAt,coverUrl,mediaType,isLive,authorId) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,author=excluded.author,publishedAt=excluded.publishedAt,coverUrl=coalesce(excluded.coverUrl,works.coverUrl),mediaType=excluded.mediaType,isLive=excluded.isLive,authorId=coalesce(excluded.authorId,works.authorId)'
      )
      .run(
        work.id,
        work.title,
        work.author,
        work.publishedAt,
        work.coverUrl,
        work.mediaType,
        +work.isLive,
        work.authorId ?? null
      )
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
      const localFolderId =
        task.stage === 'folder'
          ? String(
              this.db
                .prepare('SELECT localId FROM favorite_folder_links WHERE accountId=? AND remoteId=?')
                .get(input.accountId, task.folderId)?.localId ?? task.folderId
            )
          : null
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
        if (task.stage === 'folder') this.state.protect(task.id, input.accountId, localFolderId!)
        if (task.stage === 'folders')
          this.db
            .prepare('UPDATE saved_folders SET seenRun=? WHERE accountId=?')
            .run(task.id, input.accountId)
      }
      let added = 0
      const memberRun = task.stage === 'folder' ? this.memberRun(input.accountId, task.folderId!) : ''
      const folderSyncedAt =
        task.stage === 'folder'
          ? Number(
              this.db
                .prepare('SELECT syncedAt FROM saved_folders WHERE accountId=? AND id=?')
                .get(input.accountId, localFolderId)?.syncedAt ?? 0
            )
          : 0
      for (const work of input.items ?? []) {
        added += this.writeWork(input.accountId, work)
        if (task.stage === 'folder') {
          const memberOverride = this.db
            .prepare(
              'SELECT desired,synced,updatedAt FROM favorite_member_overrides WHERE accountId=? AND folderId=? AND workId=?'
            )
            .get(input.accountId, localFolderId, work.id) as
            { desired: number; synced: number; updatedAt: number } | undefined
          // A local removal wins while it is newer than the last confirmed sync.
          // Once the cloud re-adds the work after that sync, the cloud wins instead.
          const staleRemoval =
            memberOverride?.desired === 0 &&
            memberOverride.synced === 1 &&
            memberOverride.updatedAt > 0 &&
            memberOverride.updatedAt <= folderSyncedAt
          if (memberOverride?.desired === 0 && !staleRemoval) continue
          if (staleRemoval)
            this.db
              .prepare('DELETE FROM favorite_member_overrides WHERE accountId=? AND folderId=? AND workId=?')
              .run(input.accountId, localFolderId, work.id)
          this.db
            .prepare(
              'INSERT INTO saved_members VALUES(?,?,?,?) ON CONFLICT(accountId,folderId,workId) DO UPDATE SET seenRun=excluded.seenRun'
            )
            .run(input.accountId, localFolderId, work.id, task.id)
          this.state.seen(
            task.id,
            input.accountId,
            localFolderId!,
            work.id,
            memberRun,
            memberOverride?.desired === 1
          )
        }
      }
      for (const folder of input.folders ?? []) {
        const linked = this.db
          .prepare(
            'SELECT localId,localTitle,hiddenLocally FROM favorite_folder_links WHERE accountId=? AND remoteId=?'
          )
          .get(input.accountId, folder.id)
        if (linked?.hiddenLocally) continue
        const localId = String(linked?.localId ?? folder.id)
        const title = String(linked?.localTitle ?? folder.title)
        this.db
          .prepare(
            'INSERT INTO saved_folders(accountId,id,title,remoteCount,seenRun) VALUES(?,?,?,?,?) ON CONFLICT(accountId,id) DO UPDATE SET title=excluded.title,remoteCount=excluded.remoteCount,seenRun=excluded.seenRun'
          )
          .run(input.accountId, localId, title, folder.remoteCount, task.id)
        this.db
          .prepare(
            `INSERT INTO favorite_folder_links(accountId,localId,remoteId,localOnly,isPrivate,managedLocally,hiddenLocally)
            VALUES(?,?,?,0,?,0,0)
            ON CONFLICT(accountId,localId) DO UPDATE SET remoteId=excluded.remoteId,localOnly=0,isPrivate=excluded.isPrivate`
          )
          .run(input.accountId, localId, folder.id, +!!folder.private)
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
                .prepare(
                  `DELETE FROM saved_folders WHERE accountId=? AND seenRun<>?
                  AND id NOT IN (SELECT localId FROM favorite_folder_links WHERE accountId=? AND localOnly=1)
                  AND id NOT IN (SELECT folderId FROM favorite_write_ops WHERE accountId=? AND folderId<>'')`
                )
                .run(input.accountId, task.id, input.accountId, input.accountId)
            this.db
              .prepare(
                'DELETE FROM favorite_folder_links WHERE accountId=? AND localOnly=0 AND hiddenLocally=0 AND localId NOT IN (SELECT id FROM saved_folders WHERE accountId=?)'
              )
              .run(input.accountId, input.accountId)
            this.db
              .prepare(
                `DELETE FROM saved_jobs WHERE taskId=? AND NOT EXISTS(
                SELECT 1 FROM saved_folders f LEFT JOIN favorite_folder_links l ON l.accountId=f.accountId AND l.localId=f.id
                WHERE f.accountId=? AND coalesce(l.remoteId,f.id)=saved_jobs.folderId)`
              )
              .run(task.id, input.accountId)
          } else {
            const oldMembers = Number(
              this.db
                .prepare('SELECT count(*) AS total FROM saved_members WHERE accountId=? AND folderId=?')
                .get(input.accountId, localFolderId)?.total ?? 0
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
            if (dirty) this.state.protect(task.id, input.accountId, localFolderId!)
            if (!dirty) {
              // A locally added work that the cloud no longer has, after that
              // addition was already confirmed by an earlier sync, follows the
              // cloud. The inverse (cloud re-adds a locally removed work) is
              // handled per item above.
              this.db
                .prepare(
                  `DELETE FROM favorite_member_overrides
                  WHERE accountId=? AND folderId=? AND desired=1 AND synced=1
                    AND updatedAt>0 AND updatedAt<=?
                    AND workId NOT IN (
                      SELECT workId FROM saved_scan_members WHERE taskId=? AND folderId=? AND scanId=?
                    )`
                )
                .run(input.accountId, localFolderId, folderSyncedAt, task.id, localFolderId, memberRun)
              this.db
                .prepare(
                  `INSERT INTO saved_members(accountId,folderId,workId,seenRun)
                  SELECT o.accountId,o.folderId,o.workId,? FROM favorite_member_overrides o
                  JOIN saved_items i ON i.accountId=o.accountId AND i.workId=o.workId
                  WHERE o.accountId=? AND o.folderId=? AND o.desired=1
                  ON CONFLICT(accountId,folderId,workId) DO UPDATE SET seenRun=excluded.seenRun`
                )
                .run(task.id, input.accountId, localFolderId)
              this.state.importManual(task.id)
              this.db
                .prepare(
                  'DELETE FROM saved_members WHERE accountId=? AND folderId=? AND NOT EXISTS(SELECT 1 FROM saved_scan_members s WHERE s.taskId=? AND s.accountId=saved_members.accountId AND s.folderId=saved_members.folderId AND s.workId=saved_members.workId AND (s.scanId=? OR s.manual=1))'
                )
                .run(input.accountId, localFolderId, task.id, memberRun)
              this.db
                .prepare('UPDATE saved_folders SET syncedAt=? WHERE accountId=? AND id=?')
                .run(Date.now(), input.accountId, localFolderId)
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
