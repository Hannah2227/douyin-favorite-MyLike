import { FavoritesStore, favoritesMigration } from './favorites'
import { FavoriteState, favoriteStateSchema } from './favorite-state'
import { RuntimeEventsStore } from './runtime-events'
import { purgeAccountRows, purgeAccountBackups } from './account-purge'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Account, CollectionTask, Filter, Query } from '../../shared/contracts'
import { MAX_BATCH_SIZE } from '../../shared/contracts'
import type { Inputs, Replies } from './protocol'
import { AppError } from '../errors'
import { PlaybackStore } from './playback'
import { UnlikeStore } from './unlike'
import { appPreferencesSchema } from '../../shared/preferences'

export class Store {
  private readonly db: DatabaseSync
  private readonly events: RuntimeEventsStore
  private readonly favorites: FavoritesStore
  private readonly playback: PlaybackStore
  private readonly unlike: UnlikeStore
  constructor(private readonly file: string) {
    this.db = new DatabaseSync(file)
    this.events = new RuntimeEventsStore(this.db)
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
      const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
      if (version.user_version > 7) throw new Error('Database version is newer than this application')
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      if (version.user_version > 0 && version.user_version < 6) {
        this.backup('before-v6')
      }
      if (version.user_version === 6) this.backup('before-v7')
      if (!version.user_version)
        this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, remoteId TEXT UNIQUE, nickname TEXT, avatarUrl TEXT, createdAt INTEGER NOT NULL);
      CREATE TABLE works (id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL, publishedAt INTEGER NOT NULL, coverUrl TEXT, mediaType TEXT NOT NULL, isLive INTEGER NOT NULL);
      CREATE TABLE account_items (accountId TEXT NOT NULL REFERENCES accounts(id), workId TEXT NOT NULL REFERENCES works(id), firstSeen INTEGER NOT NULL, PRIMARY KEY(accountId, workId));
      CREATE INDEX works_published ON works(publishedAt DESC, id);
      CREATE TABLE checkpoints (accountId TEXT PRIMARY KEY REFERENCES accounts(id), cursor TEXT NOT NULL, hasMore INTEGER NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version=1;
      COMMIT;
    `)
      if (version.user_version < 2)
        this.db.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE collection_tasks (
            accountId TEXT PRIMARY KEY REFERENCES accounts(id), id TEXT NOT NULL UNIQUE,
            mode TEXT NOT NULL, phase TEXT NOT NULL, status TEXT NOT NULL,
            cursor TEXT NOT NULL, backfillCursor TEXT,
            pages INTEGER NOT NULL DEFAULT 0, received INTEGER NOT NULL DEFAULT 0, added INTEGER NOT NULL DEFAULT 0,
            reason TEXT, errorCode TEXT, updatedAt INTEGER NOT NULL
          );
          CREATE TABLE collection_cursors (taskId TEXT NOT NULL REFERENCES collection_tasks(id) ON DELETE CASCADE, phase TEXT NOT NULL, cursor TEXT NOT NULL, PRIMARY KEY(taskId,phase,cursor));
          PRAGMA user_version=2;
          COMMIT;
        `)
      if (version.user_version < 3)
        this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE INDEX IF NOT EXISTS account_items_work ON account_items(workId);
        CREATE INDEX IF NOT EXISTS account_items_collected ON account_items(accountId,firstSeen DESC,workId DESC);
        PRAGMA user_version=3;
        COMMIT;
      `)
      if (version.user_version < 4)
        this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE playback_queues(id TEXT PRIMARY KEY,accountId TEXT NOT NULL UNIQUE REFERENCES accounts(id),mode TEXT NOT NULL,currentIndex INTEGER NOT NULL,total INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 0,seconds REAL NOT NULL DEFAULT 0,slide INTEGER NOT NULL DEFAULT 0,musicSeconds REAL NOT NULL DEFAULT 0,completed INTEGER NOT NULL DEFAULT 0,progressSequence INTEGER NOT NULL DEFAULT 0,updatedAt INTEGER NOT NULL);
        CREATE TABLE playback_items(queueId TEXT NOT NULL REFERENCES playback_queues(id) ON DELETE CASCADE,position INTEGER NOT NULL,workId TEXT NOT NULL REFERENCES works(id),PRIMARY KEY(queueId,position));
        CREATE INDEX playback_items_work ON playback_items(workId);
        PRAGMA user_version=4;
        COMMIT;
      `)
      if (version.user_version < 5)
        this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE accounts ADD COLUMN lastVerifiedAt INTEGER;
        ALTER TABLE account_items ADD COLUMN platformSeen INTEGER NOT NULL DEFAULT 1;
        CREATE TABLE unlike_tasks(id TEXT PRIMARY KEY,accountId TEXT NOT NULL REFERENCES accounts(id),mode TEXT NOT NULL,remoteId TEXT NOT NULL,status TEXT NOT NULL,reason TEXT,errorCode TEXT,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
        CREATE INDEX unlike_tasks_account ON unlike_tasks(accountId,createdAt DESC,id);
        CREATE TABLE unlike_items(taskId TEXT NOT NULL REFERENCES unlike_tasks(id) ON DELETE CASCADE,position INTEGER NOT NULL,workId TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,errorCode TEXT,reason TEXT,updatedAt INTEGER NOT NULL,PRIMARY KEY(taskId,workId),UNIQUE(taskId,position));
        CREATE INDEX unlike_items_status ON unlike_items(taskId,status,position);
        CREATE INDEX unlike_items_work ON unlike_items(workId,status);
        PRAGMA user_version=5;
        COMMIT;
      `)
      if (version.user_version < 6) this.db.exec('BEGIN IMMEDIATE; ' + favoritesMigration + ' COMMIT;')
      if (version.user_version < 7)
        this.db.exec(
          "BEGIN IMMEDIATE; ALTER TABLE unlike_tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'likes' CHECK(source IN ('likes','favorites')); PRAGMA user_version=7; COMMIT;"
        )
      this.db.exec('BEGIN IMMEDIATE; ' + favoriteStateSchema + ' COMMIT;')
      const favoriteState = new FavoriteState(this.db)
      const favoriteTasks = this.db.prepare('SELECT id FROM saved_tasks').all()
      for (const task of favoriteTasks) favoriteState.ensure(String(task.id))
      const interrupted = this.db
        .prepare(
          "SELECT accountId,'喜欢采集' AS label FROM collection_tasks WHERE status='running' UNION ALL SELECT accountId,'收藏同步' FROM saved_tasks WHERE status='running' UNION ALL SELECT accountId,'收藏更新' FROM saved_updates WHERE status='running' UNION ALL SELECT accountId,CASE source WHEN 'favorites' THEN '取消收藏' ELSE '取消点赞' END FROM unlike_tasks WHERE status='running'"
        )
        .all()
      this.db
        .prepare(
          "UPDATE saved_tasks SET status='paused',reason='应用已中断，可继续已保存的收藏断点。',errorCode='INTERRUPTED' WHERE status='running'"
        )
        .run()
      for (const task of favoriteTasks) favoriteState.touch(String(task.id))
      this.favorites = new FavoritesStore(this.db, this.transaction.bind(this))
      this.db.exec(
        "UPDATE saved_updates SET status='paused',reason='应用已中断，可继续收藏更新。',errorCode='INTERRUPTED' WHERE status='running'"
      )
      this.db.exec(
        "BEGIN IMMEDIATE; UPDATE unlike_items SET status='unknown',errorCode='INTERRUPTED',reason='应用退出前请求结果未确认，未自动重发。' WHERE status='inflight'; UPDATE unlike_tasks SET status='paused',errorCode='INTERRUPTED',reason='任务已中断；仅可继续未发送项。' WHERE status='running'; COMMIT;"
      )
      this.db
        .prepare(
          "UPDATE collection_tasks SET status='paused',reason='应用退出或中断；可继续已保存进度。',errorCode='INTERRUPTED',updatedAt=? WHERE status='running'"
        )
        .run(Date.now())
      this.playback = new PlaybackStore(this.db, this.filter.bind(this), this.transaction.bind(this))
      this.unlike = new UnlikeStore(this.db, this.transaction.bind(this))
      for (const row of interrupted) {
        try {
          this.events.append(String(row.accountId), {
            kind: 'task',
            message: `${row.label}因上次应用中断而暂停，已恢复已保存进度；未确认写入不会自动重发。`,
            code: 'INTERRUPTED'
          })
        } catch {
          console.error('[MyLike] Interrupted task retained; runtime record could not be saved.')
        }
      }
    } catch (error) {
      this.db.close()
      throw error
    }
  }
  private backup(reason: string): string {
    const backups = join(dirname(this.file), 'backups')
    mkdirSync(backups, { recursive: true })
    // Includes committed WAL contents, unlike copying only the DB file.
    const fileName = `${reason}-${Date.now()}-${randomUUID()}.sqlite`
    const temporary = join(backups, `${fileName}.tmp`)
    try {
      this.db.prepare('VACUUM INTO ?').run(temporary)
      renameSync(temporary, join(backups, fileName))
    } finally {
      try {
        unlinkSync(temporary)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return fileName
  }
  private account(id: string): Account {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id=?').get(id) as unknown as Account | undefined
    if (!row) throw new AppError('ACCOUNT_NOT_FOUND', '账号不存在，请重新选择。')
    return row
  }
  private collection(accountId: string): CollectionTask | null {
    const row = this.db
      .prepare('SELECT * FROM collection_tasks WHERE accountId=?')
      .get(accountId) as unknown as CollectionTask | undefined
    return row ? { ...row, tailCursor: this.tailCursor(accountId) } : null
  }
  private tailCursor(accountId: string): string | null {
    const value = this.db
      .prepare('SELECT value FROM settings WHERE key=?')
      .get(`collectionTail:${accountId}`)?.value
    return typeof value === 'string' && /^\d{1,30}$/.test(value) ? value : null
  }
  private task(accountId: string, taskId: string): CollectionTask {
    const task = this.collection(accountId)
    if (!task || task.id !== taskId) throw new AppError('TASK_CHANGED', '任务已变化，请刷新后重试。')
    return task
  }
  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  private savePage(input: Inputs['savePage']): Replies['savePage'] {
    if (this.account(input.accountId).remoteId !== input.remoteId)
      throw new AppError('IDENTITY_MISMATCH', '账号身份发生变化，本页未保存。')
    const work = this.db.prepare(
      'INSERT INTO works VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,author=excluded.author,publishedAt=excluded.publishedAt,coverUrl=excluded.coverUrl,mediaType=excluded.mediaType,isLive=excluded.isLive'
    )
    const member = this.db.prepare(
      'INSERT OR IGNORE INTO account_items(accountId,workId,firstSeen,platformSeen) VALUES(?,?,?,1)'
    )
    const proof = this.db.prepare('SELECT platformSeen FROM account_items WHERE accountId=? AND workId=?')
    const mark = this.db.prepare(
      'UPDATE account_items SET platformSeen=1 WHERE accountId=? AND workId=? AND platformSeen=0'
    )
    const previous = new Map<string, boolean>()
    let added = 0
    for (const item of input.items) {
      if (!previous.has(item.id))
        previous.set(item.id, proof.get(input.accountId, item.id)?.platformSeen === 1)
      work.run(
        item.id,
        item.title,
        item.author,
        item.publishedAt,
        item.coverUrl,
        item.mediaType,
        +item.isLive
      )
      added += Number(member.run(input.accountId, item.id, Date.now()).changes)
      mark.run(input.accountId, item.id)
    }
    if (!input.preserveCheckpoint)
      this.db
        .prepare(
          'INSERT INTO checkpoints VALUES(?,?,?) ON CONFLICT(accountId) DO UPDATE SET cursor=excluded.cursor,hasMore=excluded.hasMore'
        )
        .run(input.accountId, input.cursor, +input.hasMore)
    return {
      received: input.items.length,
      added,
      cursor: input.cursor,
      hasMore: input.hasMore,
      previouslyCollected: [...previous.values()].filter(Boolean).length
    }
  }
  call<K extends keyof Inputs>(method: K, input: Inputs[K]): Replies[K] {
    const kind = ['startCollection', 'updateCollection', 'saveCollectionPage'].includes(method)
      ? '喜欢采集'
      : ['favoritesStart', 'favoritesUpdate', 'favoritesSave', 'favoritesDefer'].includes(method)
        ? '收藏同步'
        : ['unlikeCreate', 'unlikeUpdate'].includes(method)
          ? '取消点赞'
          : null
    const accountId = (input as { accountId?: string } | undefined)?.accountId
    const task = () =>
      kind === '喜欢采集'
        ? this.collection(accountId!)
        : kind === '收藏同步'
          ? this.favorites.task(accountId!, (input as { mode?: 'sync' | 'update' }).mode)
          : this.unlike.call('unlikeTask', { accountId: accountId! })
    const before = kind ? task() : null
    const result = this.dispatch(method, input) as Replies[K]
    if (kind && accountId) {
      try {
        const after = task()
        const end =
          ['saveCollectionPage', 'favoritesSave'].includes(method) &&
          (input as { hasMore?: boolean }).hasMore === false
        const collectionInput = input as Inputs['favoritesSave']
        const uncertainScope =
          method === 'favoritesSave' &&
          ((collectionInput.stage === 'folder' &&
            !!this.db
              .prepare('SELECT deferred FROM saved_job_meta WHERE taskId=? AND folderId=?')
              .get(collectionInput.taskId, collectionInput.folderId)?.deferred) ||
            (collectionInput.stage === 'all' && !!((after as { incomplete?: number })?.incomplete! & 1)) ||
            (collectionInput.stage === 'folders' && !!((after as { incomplete?: number })?.incomplete! & 2)))
        if (
          end &&
          after?.status === 'completed' &&
          !(input as { incomplete?: boolean }).incomplete &&
          !(input as { skipped?: unknown[] }).skipped?.length &&
          !uncertainScope
        ) {
          const favorites = kind === '收藏同步'
          const label = favorites
            ? (input as { mode?: string }).mode === 'update'
              ? '收藏更新'
              : '收藏同步'
            : '喜欢采集'
          this.events.append(accountId, {
            kind: 'task',
            code: 'END_CONFIRMED',
            operation: favorites ? 'favorites' : 'likes',
            message: `${label}已确认触底，本轮新增 ${'added' in after ? after.added : 0} 条。`
          })
        } else if (
          after?.errorCode &&
          (after.id !== before?.id ||
            after.status !== before?.status ||
            after.errorCode !== before?.errorCode)
        ) {
          this.events.append(accountId, {
            kind: 'task',
            message:
              `${'source' in after && after.source === 'favorites' ? '取消收藏' : kind === '收藏同步' && (input as { mode?: string }).mode === 'update' ? '收藏更新' : kind}${after.status === 'partial' ? '部分完成' : '异常中断'}${after.reason ? `：${after.reason}` : ''}`.slice(
                0,
                600
              ),
            code: after.errorCode,
            operation:
              kind === '喜欢采集'
                ? 'likes'
                : kind === '收藏同步'
                  ? before && 'stage' in before && before.stage === 'folder'
                    ? 'folderItems'
                    : before && 'stage' in before && before.stage === 'folders'
                      ? 'folders'
                      : 'favorites'
                  : 'source' in after && after.source === 'favorites'
                    ? 'favoriteRemove'
                    : 'unlike'
          })
        }
      } catch {
        console.error('[MyLike] Task outcome saved; runtime record could not be saved.')
      }
    }
    return result
  }
  private dispatch(method: keyof Inputs, input: any): unknown {
    switch (method) {
      case 'runtimeEvents':
        return this.events.read(input.accountId)
      case 'appendRuntimeEvent':
        return this.events.append(input.accountId, input.event)
      case 'appPreferences': {
        if (input.preferences) {
          const current = this.call('appPreferences', {})
          const preferences = appPreferencesSchema.parse({ ...current, ...input.preferences })
          this.db
            .prepare(
              "INSERT INTO settings VALUES('application',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
            )
            .run(JSON.stringify(preferences))
          return preferences
        }
        const value = this.db.prepare("SELECT value FROM settings WHERE key='application'").get()?.value
        try {
          return appPreferencesSchema.parse(value ? JSON.parse(String(value)) : {})
        } catch {
          throw new AppError('SETTINGS_ERROR', '通用设置无法读取，原设置已保留。')
        }
      }
      case 'windowState': {
        if (input.state) {
          this.db
            .prepare(
              "INSERT INTO settings VALUES('window',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
            )
            .run(JSON.stringify(input.state))
          return input.state
        }
        const value = this.db.prepare("SELECT value FROM settings WHERE key='window'").get()?.value
        try {
          return value ? JSON.parse(String(value)) : null
        } catch {
          return null
        }
      }
      case 'checkDatabase': {
        const integrity = this.db.prepare('PRAGMA quick_check').all()
        const references = this.db.prepare('PRAGMA foreign_key_check').all()
        const issues = integrity.filter((row) => row.quick_check !== 'ok').length + references.length
        return { ok: issues === 0, issues, checkedAt: Date.now() }
      }
      case 'favoritesTask':
        return this.favorites.task(input.accountId, input.mode)
      case 'favoriteFolders':
        return this.favorites.folders(input.accountId)
      case 'favoriteStatus':
        this.account(input.accountId)
        return this.favorites.status(input.accountId, input.workId)
      case 'favoriteRememberFolder':
        return this.favorites.rememberFolder(input.accountId, input.remoteId, input.folder)
      case 'favoriteConfirm':
        return this.favorites.confirm(input)
      case 'favoritesStart':
        this.account(input.accountId)
        return this.favorites.start(input.accountId, input.id, input.mode)
      case 'favoritesDefer':
        return this.favorites.defer(input)
      case 'favoritesUpdate':
        return this.favorites.update(
          input.accountId,
          input.taskId,
          input.status,
          input.reason,
          input.errorCode,
          input.mode
        )
      case 'favoritesSave':
        return this.favorites.save(input)
      case 'accounts':
        return this.db.prepare('SELECT * FROM accounts ORDER BY createdAt, id').all()
      case 'createAccount': {
        this.db
          .prepare('INSERT INTO accounts(id,name,createdAt) VALUES(?,?,?)')
          .run(input.id, input.name, Date.now())
        return this.account(input.id)
      }
      case 'bindAccount': {
        const old = this.account(input.accountId)
        if (old.remoteId && old.remoteId !== input.remoteId)
          throw new AppError(
            'IDENTITY_MISMATCH',
            '窗口登录的身份与这个账号不一致，请重新登录或添加正确的账号。'
          )
        const other = this.db
          .prepare('SELECT id FROM accounts WHERE remoteId=? AND id<>?')
          .get(input.remoteId, input.accountId)
        if (other)
          throw new AppError('DUPLICATE_ACCOUNT', '这个抖音身份已经绑定其他本地账号，请切换到已有账号。')
        this.db
          .prepare('UPDATE accounts SET remoteId=?,nickname=?,avatarUrl=?,lastVerifiedAt=? WHERE id=?')
          .run(input.remoteId, input.nickname, input.avatarUrl, Date.now(), input.accountId)
        return this.account(input.accountId)
      }
      case 'renameAccount':
        this.account(input.accountId)
        this.db.prepare('UPDATE accounts SET name=? WHERE id=?').run(input.name, input.accountId)
        return this.account(input.accountId)
      case 'clearAccountAuth':
        this.account(input.accountId)
        this.db.prepare('UPDATE accounts SET lastVerifiedAt=NULL WHERE id=?').run(input.accountId)
        return null
      case 'backup':
        return { fileName: this.backup(input.reason) }
      case 'removeAccount': {
        this.account(input.accountId)
        purgeAccountBackups(dirname(this.file), input.accountId)
        this.db.exec('PRAGMA secure_delete=ON')
        this.transaction(() => purgeAccountRows(this.db, input.accountId))
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        return null
      }
      case 'setting': {
        if (input.value !== undefined)
          this.db
            .prepare(
              'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
            )
            .run(input.key, input.value)
        return (
          (
            this.db.prepare('SELECT value FROM settings WHERE key=?').get(input.key) as
              { value: string } | undefined
          )?.value ?? null
        )
      }
      case 'checkpoint': {
        const row = this.db
          .prepare('SELECT cursor,hasMore FROM checkpoints WHERE accountId=?')
          .get(input.accountId) as { cursor: string; hasMore: number } | undefined
        return row ? { cursor: row.cursor, hasMore: !!row.hasMore } : null
      }
      case 'savePage':
        return this.transaction(() => this.savePage(input))
      case 'collection':
        return this.collection(input.accountId)
      case 'startCollection':
        return this.transaction(() => {
          this.account(input.accountId)
          const previous = this.collection(input.accountId)
          if (previous?.status === 'running') throw new AppError('BUSY', '采集任务正在运行。')
          const tail = input.mode === 'recheck' ? this.tailCursor(input.accountId) : null
          if (input.mode === 'recheck') {
            if (previous && previous.status !== 'completed')
              throw new AppError('TASK_INCOMPLETE', '请先完成当前任务，再复查末尾。')
            if (this.call('checkpoint', { accountId: input.accountId })?.hasMore)
              throw new AppError('TASK_INCOMPLETE', '请先继续历史采集，再复查末尾。')
            if (tail === null) throw new AppError('NO_CHECKPOINT', '当前没有可复查的末尾记录。')
          }
          // An interrupted head already contains this run's new works. Keep
          // its cursor, otherwise restarting at zero could stop on those rows.
          if (input.mode === 'incremental' && previous?.phase === 'head' && previous.status !== 'completed') {
            this.db
              .prepare(
                "UPDATE collection_tasks SET mode='incremental',status='running',reason=NULL,errorCode=NULL,updatedAt=? WHERE accountId=? AND id=?"
              )
              .run(Date.now(), input.accountId, previous.id)
            return this.collection(input.accountId)!
          }
          if (input.mode === 'update' && previous && previous.status !== 'completed')
            throw new AppError('TASK_INCOMPLETE', '请继续未完成任务，或使用更新检查新增。')
          let saved = this.call('checkpoint', { accountId: input.accountId })
          if (
            input.mode === 'incremental' &&
            previous?.phase === 'backfill' &&
            previous.status !== 'completed'
          ) {
            // Preserve even a full traversal paused before its first page.
            this.db
              .prepare(
                'INSERT INTO checkpoints VALUES(?,?,1) ON CONFLICT(accountId) DO UPDATE SET cursor=excluded.cursor,hasMore=1'
              )
              .run(input.accountId, previous.cursor)
            saved = { cursor: previous.cursor, hasMore: true }
          }
          const resumeBackfill = input.mode === 'update' && previous?.mode === 'incremental' && saved?.hasMore
          const head = input.mode === 'incremental' || (input.mode === 'update' && saved && !resumeBackfill)
          this.db.prepare('DELETE FROM collection_tasks WHERE accountId=?').run(input.accountId)
          this.db
            .prepare(
              'INSERT INTO collection_tasks(accountId,id,mode,phase,status,cursor,backfillCursor,updatedAt) VALUES(?,?,?,?,?,?,?,?)'
            )
            .run(
              input.accountId,
              input.id,
              input.mode,
              head ? 'head' : 'backfill',
              'running',
              tail ?? (resumeBackfill ? saved!.cursor : '0'),
              input.mode !== 'full' && saved?.hasMore ? saved.cursor : null,
              Date.now()
            )
          return this.collection(input.accountId)!
        })
      case 'updateCollection': {
        const task = this.task(input.accountId, input.taskId)
        if (input.status === 'paused' && task.status !== 'running') return task
        if (input.status === 'running' && task.status === 'completed')
          throw new AppError('NO_MORE', '本轮任务已经结束，可使用更新检查新增。')
        if (task.status !== 'completed')
          this.db
            .prepare(
              'UPDATE collection_tasks SET status=?,reason=?,errorCode=?,updatedAt=?,mode=coalesce(?,mode) WHERE accountId=? AND id=?'
            )
            .run(
              input.status,
              input.reason,
              input.errorCode ?? null,
              Date.now(),
              input.mode ?? null,
              input.accountId,
              input.taskId
            )
        return this.collection(input.accountId)!
      }
      case 'saveCollectionPage':
        return this.transaction(() => {
          const task = this.task(input.accountId, input.taskId)
          const anchor = input.checkpointCursor ?? input.requestCursor
          const cursors: string[] = input.traversedCursors ?? [input.requestCursor]
          if (task.status !== 'running' || task.cursor !== anchor)
            throw new AppError('CANCELLED', '任务已暂停或断点已变化，本页未保存。')
          if (
            !cursors.length ||
            cursors.length > 6 ||
            cursors[0] !== anchor ||
            cursors.at(-1) !== input.requestCursor ||
            new Set(cursors).size !== cursors.length ||
            cursors.some(
              (cursor) =>
                typeof cursor !== 'string' ||
                !/^\d{1,30}$/.test(cursor) ||
                this.db
                  .prepare('SELECT 1 FROM collection_cursors WHERE taskId=? AND phase=? AND cursor=?')
                  .get(task.id, task.phase, cursor)
            )
          )
            throw new AppError('CURSOR_STALLED', '分页探查路径无效或出现循环，原断点未推进。')
          if (
            input.hasMore &&
            (!input.items.length ||
              cursors.includes(input.cursor) ||
              this.db
                .prepare('SELECT 1 FROM collection_cursors WHERE taskId=? AND phase=? AND cursor=?')
                .get(task.id, task.phase, input.cursor))
          )
            throw new AppError('CURSOR_STALLED', '出现重复游标或异常空页，已暂停且未推进断点。')
          for (const cursor of cursors)
            this.db.prepare('INSERT INTO collection_cursors VALUES(?,?,?)').run(task.id, task.phase, cursor)
          const result = this.savePage({
            ...input,
            preserveCheckpoint: task.phase === 'head' && (input.hasMore || task.backfillCursor !== null)
          })
          let phase = task.phase,
            cursor = input.cursor,
            status: CollectionTask['status'] = 'running',
            reason: string | null = null
          const incrementalReason =
            task.backfillCursor !== null
              ? '新增更新已完成；历史采集断点已保留，可继续历史采集。'
              : '新增更新已完成。'
          if (!input.hasMore && task.phase === 'head' && task.mode === 'update' && task.backfillCursor) {
            phase = 'backfill'
            cursor = task.backfillCursor
          } else if (!input.hasMore) {
            status = 'completed'
            reason = task.mode === 'incremental' ? incrementalReason : '平台已返回列表末尾。'
            if (task.phase === 'backfill')
              this.db
                .prepare(
                  'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
                )
                .run(`collectionTail:${task.accountId}`, input.requestCursor)
          } else if (
            phase === 'head' &&
            input.items.length &&
            result.previouslyCollected === new Set(input.items.map((item: { id: string }) => item.id)).size
          ) {
            if (task.mode === 'incremental') {
              status = 'completed'
              reason = incrementalReason
            } else if (task.backfillCursor) {
              phase = 'backfill'
              cursor = task.backfillCursor
            } else {
              status = 'completed'
              reason = '本页均已收录，本轮新增检查结束。'
            }
          }
          this.db
            .prepare(
              'UPDATE collection_tasks SET phase=?,cursor=?,status=?,pages=pages+1,received=received+?,added=added+?,reason=?,errorCode=NULL,updatedAt=? WHERE accountId=? AND id=?'
            )
            .run(
              phase,
              cursor,
              status,
              result.received,
              result.added,
              reason,
              Date.now(),
              task.accountId,
              task.id
            )
          return this.collection(input.accountId)!
        })
      case 'query':
        return this.query(input)
      case 'libraryOverview': {
        this.account(input.accountId)
        const scope = this.filter({
          accountId: input.accountId,
          search: '',
          mediaType: 'all',
          year: null,
          month: null,
          sort: 'collected',
          source: 'all'
        })
        const counts = this.db
          .prepare(
            `SELECT count(*) AS total,coalesce(sum(w.mediaType='video'),0) AS videos,coalesce(sum(w.mediaType='gallery'),0) AS galleries,coalesce(sum(w.mediaType='gallery' AND w.isLive=1),0) AS live ${scope.from}`
          )
          .get(...scope.params)!
        const recent = this.db
          .prepare(`SELECT w.* ${scope.from} ${scope.order} LIMIT 4`)
          .all(...scope.params)
          .map((row) => ({ ...row, isLive: !!row.isLive }))
        const sources = this.db
          .prepare(
            `SELECT
          (SELECT count(*) FROM account_items WHERE accountId=?) AS likes,
          (SELECT count(*) FROM saved_items WHERE accountId=?) AS favorites,
          (SELECT count(*) FROM account_items a JOIN saved_items s ON a.accountId=s.accountId AND a.workId=s.workId WHERE a.accountId=?) AS overlap,
          (SELECT count(*) FROM saved_folders WHERE accountId=?) AS folders`
          )
          .get(input.accountId, input.accountId, input.accountId, input.accountId)!
        const years = this.db
          .prepare(
            `SELECT CASE WHEN w.publishedAt>0 THEN CAST(strftime('%Y',w.publishedAt,'unixepoch','localtime') AS INTEGER) ELSE NULL END AS year,
            count(*) AS count ${scope.from} GROUP BY year ORDER BY year DESC`
          )
          .all(...scope.params)
        return { accountId: input.accountId, ...counts, ...sources, years, recent }
      }
      case 'matchingIds': {
        this.account(input.accountId)
        const { from, params, order } = this.filter(input)
        const rows = this.db.prepare(`SELECT w.id ${from} ${order} LIMIT ?`).all(...params, MAX_BATCH_SIZE)
        return rows.map((row) => String(row.id))
      }
      case 'deleteLocal': {
        this.account(input.accountId)
        const ids = [...new Set<string>(input.workIds)]
        if (ids.length >= 20) this.backup('before-local-delete')
        return this.transaction(() => {
          const remove = this.db.prepare('DELETE FROM account_items WHERE accountId=? AND workId=?')
          const orphan = this.db.prepare(
            'DELETE FROM works WHERE id=? AND NOT EXISTS(SELECT 1 FROM account_items WHERE workId=?) AND NOT EXISTS(SELECT 1 FROM playback_items WHERE workId=?) AND NOT EXISTS(SELECT 1 FROM saved_items WHERE workId=?)'
          )
          let removed = 0
          for (const id of ids) {
            removed += Number(remove.run(input.accountId, id).changes)
            orphan.run(id, id, id, id)
          }
          return { removed }
        })
      }
      case 'sqliteVersion':
        return (this.db.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version
      case 'close':
        this.db.close()
        return null
      case 'queueState':
      case 'queueCreate':
      case 'queueResume':
      case 'queueMove':
      case 'queueProgress':
      case 'queueEnd':
      case 'queueReplay':
      case 'queueDismiss':
      case 'queueItems':
      case 'playbackPreferences':
        return this.playback.call(method, input)
      case 'unlikeTask':
      case 'favoriteWriteGuard':
      case 'unlikeHistory':
      case 'unlikeItems':
      case 'unlikeCreate':
      case 'unlikeUpdate':
      case 'unlikeNext':
      case 'unlikeReserve':
      case 'unlikeFinish':
      case 'unlikeSkip':
      case 'unlikeResolve':
        return this.unlike.call(method, input)
    }
  }
  private filter(query: Filter): { from: string; params: (string | number)[]; order: string } {
    const clauses = ['a.accountId=?'],
      params: (string | number)[] = [query.accountId]
    if (query.search) {
      clauses.push('(instr(lower(w.title),lower(?))>0 OR instr(lower(w.author),lower(?))>0)')
      params.push(query.search, query.search)
    }
    if (query.mediaType !== 'all') {
      clauses.push('w.mediaType=?')
      params.push(query.mediaType)
    }
    if (query.year !== null) {
      clauses.push('w.publishedAt>=? AND w.publishedAt<?')
      params.push(
        new Date(query.year, query.month ? query.month - 1 : 0, 1).getTime() / 1000,
        new Date(query.year + (query.month ? 0 : 1), query.month ?? 0, 1).getTime() / 1000
      )
    } else if (query.month) {
      clauses.push("cast(strftime('%m',w.publishedAt,'unixepoch','localtime') AS INTEGER)=?")
      params.push(query.month)
    }
    if (query.folderId) {
      if (query.source !== 'favorites') throw new AppError('INVALID_INPUT', '收藏夹筛选需要收藏来源。')
      clauses.push(
        'EXISTS(SELECT 1 FROM saved_members m WHERE m.accountId=a.accountId AND m.workId=w.id AND m.folderId=?)'
      )
      params.push(query.folderId)
    }
    const table =
      query.source === 'favorites'
        ? 'saved_items'
        : query.source === 'all'
          ? '(SELECT accountId,workId,max(firstSeen) AS firstSeen FROM (SELECT accountId,workId,firstSeen FROM account_items UNION ALL SELECT accountId,workId,firstSeen FROM saved_items) GROUP BY accountId,workId)'
          : 'account_items'
    const from = `FROM works w JOIN ${table} a ON a.workId=w.id WHERE ${clauses.join(' AND ')}`
    return {
      from,
      params,
      order:
        query.sort === 'collected'
          ? 'ORDER BY a.firstSeen DESC,w.id DESC'
          : 'ORDER BY w.publishedAt DESC,w.id DESC'
    }
  }
  private query(query: Query): Replies['query'] {
    const { from, params, order } = this.filter(query)
    const total = (this.db.prepare(`SELECT count(*) AS n ${from}`).get(...params) as { n: number }).n
    const items = this.db
      .prepare(`SELECT w.* ${from} ${order} LIMIT ? OFFSET ?`)
      .all(...params, query.limit, query.offset)
      .map((row) => ({ ...row, isLive: !!row.isLive }))
    const yearScope = this.filter({ ...query, search: '', mediaType: 'all', year: null, month: null })
    const years = this.db
      .prepare(
        `SELECT DISTINCT cast(strftime('%Y',w.publishedAt,'unixepoch','localtime') AS INTEGER) AS year ${yearScope.from} ORDER BY year DESC`
      )
      .all(...yearScope.params)
      .map((row) => Number(row.year))
      .filter((year) => year >= 2000)
    return { items, total, years } as Replies['query']
  }
}
