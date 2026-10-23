import { z } from 'zod'
import { appPreferencesPatchSchema, playbackPreferencesSchema, type AppPreferences } from './preferences'
export { playbackPreferencesSchema, shortcutKeys } from './preferences'

export const idSchema = z.string().uuid()
export const workIdSchema = z.string().regex(/^\d{1,30}$/)
export const filterSchema = z.object({
  accountId: idSchema,
  search: z.string().max(200).default(''),
  mediaType: z.enum(['all', 'video', 'gallery']).default('all'),
  year: z.number().int().min(2000).max(2200).nullable().default(null),
  month: z.number().int().min(1).max(12).nullable().default(null),
  sort: z.enum(['published', 'collected']).default('published'),
  source: z.enum(['likes', 'favorites', 'all']).optional(),
  folderId: workIdSchema.nullable().optional()
})
export const querySchema = filterSchema.extend({
  offset: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(120).default(60)
})
export const playbackScopeSchema = z.object({
  accountId: idSchema,
  queueId: idSchema,
  revision: z.number().int().min(0)
})
export const playbackPositionSchema = z.object({
  seconds: z.number().finite().min(0).max(86400),
  slide: z.number().int().min(0).max(1000),
  musicSeconds: z.number().finite().min(0).max(86400)
})
const queueSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('filter'), filter: filterSchema.omit({ accountId: true }) }),
  z.object({
    type: z.literal('ids'),
    ids: z.array(workIdSchema).min(1).max(100000),
    sort: z.enum(['published', 'collected']).default('published')
  })
])

export const commands = {
  snapshot: z.object({}),
  createAccount: z.object({ name: z.string().trim().min(1).max(40) }),
  switchAccount: z.object({ accountId: idSchema }),
  renameAccount: z.object({ accountId: idSchema, name: z.string().trim().min(1).max(40) }),
  logoutAccount: z.object({ accountId: idSchema }),
  removeAccount: z.object({ accountId: idSchema }),
  login: z.object({ accountId: idSchema }),
  probe: z.object({ accountId: idSchema }),
  releaseEngine: z.object({}),
  collectPage: z.object({ accountId: idSchema, continue: z.boolean() }),
  collectionStart: z.object({ accountId: idSchema, mode: z.enum(['update', 'full']) }),
  favoritesStart: z.object({ accountId: idSchema }),
  favoritesControl: z.object({
    accountId: idSchema,
    taskId: idSchema,
    action: z.enum(['pause', 'resume', 'stop'])
  }),
  favoriteFolders: z.object({ accountId: idSchema }),
  collectionControl: z.object({
    accountId: idSchema,
    taskId: idSchema,
    action: z.enum(['pause', 'resume', 'stop'])
  }),
  stopRequest: z.object({}),
  query: querySchema,
  libraryOverview: z.object({ accountId: idSchema }),
  matchingIds: filterSchema,
  deleteLocal: z.object({ accountId: idSchema, workIds: z.array(workIdSchema).min(1).max(100000) }),
  unlikeStart: z.object({
    accountId: idSchema,
    workIds: z.array(workIdSchema).min(1).max(1000),
    mode: z.enum(['single', 'batch'])
  }),
  unlikeControl: z.object({ accountId: idSchema, taskId: idSchema, action: z.enum(['resume', 'stop']) }),
  unlikeItems: z.object({
    accountId: idSchema,
    taskId: idSchema,
    offset: z.number().int().min(0).max(1000),
    limit: z.number().int().min(1).max(100).default(50)
  }),
  unlikeHistory: z.object({ accountId: idSchema }),
  unlikeVerify: z.object({ accountId: idSchema, taskId: idSchema, workId: workIdSchema }),
  queueCreate: z.object({
    accountId: idSchema,
    source: queueSourceSchema,
    mode: z.enum(['sequence', 'shuffle']),
    startWorkId: workIdSchema.optional()
  }),
  queueResume: z.object({ accountId: idSchema, queueId: idSchema }),
  queueMove: z.object({
    accountId: idSchema,
    queueId: idSchema,
    target: z.union([z.enum(['next', 'previous']), z.number().int().min(0).max(99999)])
  }),
  queueProgress: playbackScopeSchema.extend({
    position: playbackPositionSchema,
    sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
  }),
  queueEnd: playbackScopeSchema.extend({ advance: z.boolean(), position: playbackPositionSchema }),
  queueReplay: playbackScopeSchema,
  queueDismiss: playbackScopeSchema,
  cancelMedia: playbackScopeSchema,
  queueItems: z.object({
    accountId: idSchema,
    queueId: idSchema,
    offset: z.number().int().min(0).max(100000),
    limit: z.number().int().min(1).max(100).default(50)
  }),
  playbackPreferences: z.object({ preferences: playbackPreferencesSchema }),
  appPreferences: z.object({ preferences: appPreferencesPatchSchema }),
  checkDatabase: z.object({}),
  copyDiagnostics: z.object({}),
  openReleases: z.object({}),
  exportLibrary: z.object({ accountId: idSchema, source: queueSourceSchema }),
  importLibrary: z.object({ accountId: idSchema }),
  importCommit: z.object({ accountId: idSchema, token: idSchema }),
  importCancel: z.object({ token: idSchema }),
  backup: z.object({}),
  dataInfo: z.object({ accountId: idSchema.nullable() }),
  openDataFolder: z.object({ target: z.enum(['data', 'backups']) }),
  clearCache: z.object({ accountId: idSchema }),
  media: z.object({
    accountId: idSchema,
    workId: workIdSchema,
    playback: z.object({ queueId: idSchema, revision: z.number().int().min(0) }).optional()
  }),
  original: z.object({
    accountId: idSchema,
    workId: workIdSchema,
    playback: z.object({ queueId: idSchema, revision: z.number().int().min(0) }).optional()
  }),
  theme: z.object({ theme: z.enum(['dark', 'light']) }),
  windowPresentation: z.object({ player: z.boolean() }),
  openProject: z.object({}),
  diagnostics: z.object({})
}
export type Command = keyof typeof commands
export type Query = z.infer<typeof querySchema>
export type Filter = z.infer<typeof filterSchema>
export type PlaybackPreferences = z.infer<typeof playbackPreferencesSchema>
export type PlaybackPosition = z.infer<typeof playbackPositionSchema>
export type PlaybackScope = z.infer<typeof playbackScopeSchema>
export type QueueCreate = z.infer<typeof commands.queueCreate>
export interface ImportPreview {
  token: string
  accountId: string
  accountName: string
  fileName: string
  sourceLabel: string
  total: number
  newCount: number
  existingCount: number
  duplicates: number
}
export interface ImportResult {
  received: number
  added: number
  duplicates: number
}
export interface ExportResult {
  fileName: string
  count: number
}
export interface QueueState extends PlaybackScope {
  source?: 'likes' | 'favorites' | 'all'
  mode: 'sequence' | 'shuffle'
  index: number
  total: number
  position: PlaybackPosition
  completed: boolean
  work: Work
  next: Work | null
}
export interface Account {
  id: string
  name: string
  remoteId: string | null
  nickname: string | null
  avatarUrl: string | null
  createdAt: number
  lastVerifiedAt: number | null
}
export interface Work {
  id: string
  title: string
  author: string
  publishedAt: number
  coverUrl: string | null
  mediaType: 'video' | 'gallery'
  isLive: boolean
}
export interface Media {
  work: Work
  videos: string[]
  images: { url: string; liveUrl: string | null }[]
  music: string | null
}
export interface LibraryPage {
  items: Work[]
  total: number
  years: number[]
}
export interface LibraryOverview {
  metadataBytes: number
  accountId: string
  total: number
  videos: number
  galleries: number
  live: number
  recent: Work[]
  likes: number
  favorites: number
  overlap: number
  folders: number
  years: { year: number | null; count: number }[]
}
export type EngineStatus = 'stopped' | 'starting' | 'ready' | 'visible' | 'failed'
export interface CollectionTask {
  id: string
  accountId: string
  mode: 'update' | 'full'
  phase: 'head' | 'backfill'
  status: 'running' | 'paused' | 'stopped' | 'completed'
  cursor: string
  backfillCursor: string | null
  pages: number
  received: number
  added: number
  reason: string | null
  errorCode: string | null
  updatedAt: number
}
export interface UnlikeTask {
  id: string
  accountId: string
  mode: 'single' | 'batch'
  remoteId: string
  status: 'running' | 'paused' | 'stopped' | 'completed'
  reason: string | null
  errorCode: string | null
  createdAt: number
  updatedAt: number
  total: number
  pending: number
  inflight: number
  success: number
  failed: number
  unknown: number
}
export interface UnlikeItem {
  position: number
  workId: string
  title: string
  status: 'pending' | 'inflight' | 'success' | 'failed' | 'unknown'
  reason: string | null
  errorCode: string | null
}
export interface Snapshot {
  favorites: FavoritesTask | null
  favoritesActivity: 'requesting' | 'waiting' | 'recycling' | null
  accounts: Account[]
  activeAccountId: string | null
  theme: 'dark' | 'light'
  engine: { status: EngineStatus; accountId: string | null }
  busy: boolean
  collection: CollectionTask | null
  collectionActivity: 'requesting' | 'waiting' | 'recycling' | null
  unlike: UnlikeTask | null
  libraryRevision: number
  playback: QueueState | null
  playbackPreferences: PlaybackPreferences
  appPreferences: AppPreferences
  version: string
}
export interface PageResult {
  received: number
  added: number
  hasMore: boolean
  cursor: string
}
export interface Diagnostics {
  electron: string
  chromium: string
  node: string
  sqlite: string
  packaged: boolean
  processes: { type: string; memoryMB: number }[]
}
export interface DataInfo {
  folder: string
  metadataBytes: number
  backupsBytes: number
  backupsCount: number
  cacheBytes: number
}
export interface FavoriteFolder {
  id: string
  title: string
  remoteCount: number
  localCount: number
}
export interface FavoritesTask {
  id: string
  accountId: string
  stage: 'all' | 'folders' | 'folder'
  folderId: string | null
  cursor: string
  status: 'running' | 'paused' | 'stopped' | 'completed'
  pages: number
  received: number
  added: number
  foldersDone: number
  foldersTotal: number
  reason: string | null
  errorCode: string | null
  updatedAt: number
}
export interface Outputs {
  appPreferences: AppPreferences
  checkDatabase: { ok: boolean; checkedAt: number; issues: number }
  copyDiagnostics: null
  openReleases: null
  favoritesStart: FavoritesTask
  favoritesControl: FavoritesTask
  favoriteFolders: FavoriteFolder[]
  snapshot: Snapshot
  createAccount: Account
  switchAccount: null
  renameAccount: Account
  logoutAccount: null
  removeAccount: null
  login: null
  probe: Account
  releaseEngine: null
  collectPage: PageResult
  collectionStart: CollectionTask
  collectionControl: CollectionTask
  stopRequest: null
  query: LibraryPage
  libraryOverview: LibraryOverview
  matchingIds: string[]
  deleteLocal: { removed: number }
  unlikeStart: UnlikeTask
  unlikeControl: UnlikeTask
  unlikeItems: { items: UnlikeItem[]; total: number }
  unlikeHistory: UnlikeTask[]
  unlikeVerify: UnlikeTask
  queueCreate: QueueState
  queueResume: QueueState
  queueMove: QueueState
  queueProgress: QueueState
  queueEnd: QueueState
  queueReplay: QueueState
  queueDismiss: QueueState
  cancelMedia: null
  queueItems: { items: { index: number; work: Work }[]; total: number }
  playbackPreferences: PlaybackPreferences
  exportLibrary: ExportResult | null
  importLibrary: ImportPreview | null
  importCommit: ImportResult
  importCancel: null
  backup: { fileName: string }
  dataInfo: DataInfo
  openDataFolder: null
  clearCache: null
  media: Media
  original: null
  theme: null
  windowPresentation: null
  openProject: null
  diagnostics: Diagnostics
}
export type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }
export interface DesktopAPI {
  invoke<K extends Command>(command: K, input: z.input<(typeof commands)[K]>): Promise<Result<Outputs[K]>>
  onChanged(callback: () => void): () => void
  onBeforeQuit(callback: () => Promise<void>): () => void
}
