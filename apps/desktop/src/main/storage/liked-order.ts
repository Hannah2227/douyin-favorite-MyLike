import type { DatabaseSync } from 'node:sqlite'
import type { CollectionTask, Work } from '../../shared/contracts'

// Store the order observed in the browser separately from v7 work rows.
export const likedOrderSchema = `
CREATE TABLE IF NOT EXISTS liked_order (
  accountId TEXT NOT NULL,
  workId TEXT NOT NULL,
  generation INTEGER NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY(accountId, workId),
  FOREIGN KEY(accountId, workId) REFERENCES account_items(accountId, workId) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS liked_order_position ON liked_order(accountId, generation DESC, position);
CREATE TABLE IF NOT EXISTS liked_order_progress (
  taskId TEXT NOT NULL REFERENCES collection_tasks(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  generation INTEGER NOT NULL,
  nextPosition INTEGER NOT NULL,
  PRIMARY KEY(taskId, phase)
);
`
export const likedOrderJoin = 'LEFT JOIN liked_order l ON l.accountId=a.accountId AND l.workId=a.workId'
export const likedOrderSort = 'ORDER BY l.generation DESC,l.position,w.publishedAt DESC,w.id DESC'

export function recordLikedOrder(db: DatabaseSync, task: CollectionTask, items: Work[]): void {
  if (!items.length) return
  const newest = task.phase === 'head' || task.mode === 'full'
  let run = db
    .prepare('SELECT generation,nextPosition FROM liked_order_progress WHERE taskId=? AND phase=?')
    .get(task.id, task.phase) as { generation: number; nextPosition: number } | undefined
  if (!run) {
    const extreme = db
      .prepare(
        newest
          ? 'SELECT max(generation) AS n FROM liked_order WHERE accountId=?'
          : 'SELECT min(generation) AS n FROM liked_order WHERE accountId=?'
      )
      .get(task.accountId)
    run = { generation: Number(extreme?.n ?? 0) + (newest ? 1 : -1), nextPosition: 0 }
    db.prepare('INSERT INTO liked_order_progress VALUES(?,?,?,0)').run(task.id, task.phase, run.generation)
  }
  const save = db.prepare(
    newest
      ? 'INSERT INTO liked_order VALUES(?,?,?,?) ON CONFLICT(accountId,workId) DO UPDATE SET generation=excluded.generation,position=excluded.position WHERE liked_order.generation<>excluded.generation'
      : 'INSERT OR IGNORE INTO liked_order VALUES(?,?,?,?)'
  )
  for (const item of items) save.run(task.accountId, item.id, run.generation, run.nextPosition++)
  db.prepare('UPDATE liked_order_progress SET nextPosition=? WHERE taskId=? AND phase=?').run(
    run.nextPosition,
    task.id,
    task.phase
  )
}
