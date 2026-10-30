import type { DatabaseSync } from 'node:sqlite'

// Additive tables only. The v2.0.2 tables, column order and user_version=7 stay
// readable and writable by the released application. Its account deletion also
// removes these rows through ON DELETE CASCADE, including in historical backups.
export const favoriteStateSchema = `
CREATE TABLE IF NOT EXISTS saved_task_meta(
 taskId TEXT PRIMARY KEY REFERENCES saved_tasks(id) ON DELETE CASCADE,
 incomplete INTEGER NOT NULL DEFAULT 0,skipped INTEGER NOT NULL DEFAULT 0,
 partial INTEGER NOT NULL DEFAULT 0,stamp TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS saved_job_meta(
 taskId TEXT NOT NULL,folderId TEXT NOT NULL,deferred INTEGER NOT NULL DEFAULT 0,
 incomplete INTEGER NOT NULL DEFAULT 0,reason TEXT,errorCode TEXT,scanId TEXT NOT NULL,
 PRIMARY KEY(taskId,folderId),FOREIGN KEY(taskId,folderId) REFERENCES saved_jobs(taskId,folderId) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS saved_scan_members(
 taskId TEXT NOT NULL REFERENCES saved_tasks(id) ON DELETE CASCADE,accountId TEXT NOT NULL,
 folderId TEXT NOT NULL,workId TEXT NOT NULL,scanId TEXT NOT NULL DEFAULT '',manual INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(taskId,folderId,workId),FOREIGN KEY(accountId,folderId,workId) REFERENCES saved_members(accountId,folderId,workId) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS saved_updates(
 accountId TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,id TEXT NOT NULL UNIQUE,
 cursor TEXT NOT NULL,status TEXT NOT NULL,pages INTEGER NOT NULL DEFAULT 0,received INTEGER NOT NULL DEFAULT 0,
 added INTEGER NOT NULL DEFAULT 0,incomplete INTEGER NOT NULL DEFAULT 0,skipped INTEGER NOT NULL DEFAULT 0,
 reason TEXT,errorCode TEXT,updatedAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS saved_update_cursors(taskId TEXT NOT NULL REFERENCES saved_updates(id) ON DELETE CASCADE,cursor TEXT NOT NULL,PRIMARY KEY(taskId,cursor));
`

export type SyncMeta = { incomplete: number; skipped: number; partial: number; stamp: string }

export class FavoriteState {
  constructor(private readonly db: DatabaseSync) {}
  private stamp(taskId: string): string {
    const task = this.db.prepare('SELECT * FROM saved_tasks WHERE id=?').get(taskId)
    return task ? JSON.stringify(task) : ''
  }
  read(taskId: string): SyncMeta {
    return (this.db
      .prepare('SELECT incomplete,skipped,partial,stamp FROM saved_task_meta WHERE taskId=?')
      .get(taskId) ?? { incomplete: 0, skipped: 0, partial: 0, stamp: '' }) as SyncMeta
  }
  touch(taskId: string): void {
    this.db
      .prepare(
        'INSERT INTO saved_task_meta(taskId,stamp) VALUES(?,?) ON CONFLICT(taskId) DO UPDATE SET stamp=excluded.stamp'
      )
      .run(taskId, this.stamp(taskId))
  }
  ensure(taskId: string): SyncMeta {
    const previous = this.read(taskId),
      stamp = this.stamp(taskId)
    if (previous.stamp === stamp) return previous
    // A released v2.0.2 writer knows none of this metadata. Its committed task
    // row wins; discard stale recovery flags and reconstruct its visited members.
    this.db.exec('SAVEPOINT favorite_state_reconcile')
    try {
      this.db.prepare('DELETE FROM saved_scan_members WHERE taskId=?').run(taskId)
      this.db.prepare('DELETE FROM saved_job_meta WHERE taskId=?').run(taskId)
      this.db
        .prepare(
          'INSERT INTO saved_task_meta(taskId,stamp) VALUES(?,?) ON CONFLICT(taskId) DO UPDATE SET incomplete=0,skipped=0,partial=0,stamp=excluded.stamp'
        )
        .run(taskId, stamp)
      this.db
        .prepare(
          'INSERT INTO saved_job_meta(taskId,folderId,scanId) SELECT taskId,folderId,taskId FROM saved_jobs WHERE taskId=?'
        )
        .run(taskId)
      this.db
        .prepare(
          `INSERT INTO saved_scan_members(taskId,accountId,folderId,workId,scanId)
        SELECT t.id,m.accountId,m.folderId,m.workId,t.id FROM saved_members m JOIN saved_tasks t ON t.accountId=m.accountId
        WHERE t.id=? AND m.seenRun=t.id`
        )
        .run(taskId)
      this.db.exec('RELEASE favorite_state_reconcile')
    } catch (error) {
      this.db.exec('ROLLBACK TO favorite_state_reconcile; RELEASE favorite_state_reconcile')
      throw error
    }
    return this.read(taskId)
  }
  importManual(taskId: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO saved_scan_members(taskId,accountId,folderId,workId,manual)
      SELECT t.id,m.accountId,m.folderId,m.workId,1 FROM saved_members m JOIN saved_tasks t ON t.accountId=m.accountId
      WHERE t.id=? AND m.seenRun=t.id`
      )
      .run(taskId)
  }
  seen(
    taskId: string,
    accountId: string,
    folderId: string,
    workId: string,
    scanId: string,
    manual = false
  ): void {
    this.db
      .prepare(
        `INSERT INTO saved_scan_members VALUES(?,?,?,?,?,?)
      ON CONFLICT(taskId,folderId,workId) DO UPDATE SET scanId=CASE WHEN excluded.manual=1 THEN saved_scan_members.scanId ELSE excluded.scanId END,manual=max(saved_scan_members.manual,excluded.manual)`
      )
      .run(taskId, accountId, folderId, workId, scanId, +manual)
  }
  protect(taskId: string, accountId: string, folderId: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO saved_scan_members(taskId,accountId,folderId,workId)
      SELECT ?,accountId,folderId,workId FROM saved_members WHERE accountId=? AND folderId=?`
      )
      .run(taskId, accountId, folderId)
    this.db
      .prepare('UPDATE saved_members SET seenRun=? WHERE accountId=? AND folderId=?')
      .run(taskId, accountId, folderId)
  }
  legacyCheckpoint(taskId: string): { stage: string; folderId: string | null; cursor: string } {
    const meta = this.read(taskId)
    if (meta.incomplete & 1) return { stage: 'all', folderId: null, cursor: '0' }
    if (meta.incomplete & 2) return { stage: 'folders', folderId: null, cursor: '0' }
    const job = this.db
      .prepare(
        'SELECT j.folderId FROM saved_jobs j JOIN saved_job_meta m USING(taskId,folderId) WHERE j.taskId=? AND m.deferred=1 ORDER BY j.position LIMIT 1'
      )
      .get(taskId)
    return { stage: job ? 'folder' : 'all', folderId: job ? String(job.folderId) : null, cursor: '0' }
  }
  partial(taskId: string, value: boolean): void {
    this.db.prepare('UPDATE saved_task_meta SET partial=? WHERE taskId=?').run(+value, taskId)
  }
}
