import type { DatabaseSync } from 'node:sqlite'

// Historical fixtures must remove additive tables too before dropping their
// parents; real v1-v6 databases never contained these backwards-compatible FKs.
export function dropFavoriteExtensions(db: DatabaseSync): void {
  db.exec(
    'DROP TABLE IF EXISTS saved_scan_members; DROP TABLE IF EXISTS saved_job_meta; DROP TABLE IF EXISTS saved_task_meta; DROP TABLE IF EXISTS saved_update_cursors; DROP TABLE IF EXISTS saved_updates;'
  )
}
