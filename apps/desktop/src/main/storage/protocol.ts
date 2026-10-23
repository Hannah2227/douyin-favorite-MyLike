import type {
  FavoritesTask,
  FavoriteFolder,
  Account,
  CollectionTask,
  Filter,
  LibraryPage,
  LibraryOverview,
  PageResult,
  Query,
  Work,
  QueueState,
  QueueCreate,
  PlaybackScope,
  PlaybackPosition,
  PlaybackPreferences,
  Outputs,
  ImportPreview,
  ImportResult,
  ExportResult,
  UnlikeTask,
  UnlikeItem
} from '../../shared/contracts'
import type { FavoritesPage } from './favorites'
import type { AppPreferences, WindowState } from '../../shared/preferences'

export interface Inputs {
  appPreferences: { preferences?: Partial<AppPreferences> }
  windowState: { state?: WindowState }
  checkDatabase: Record<string, never>
  favoritesTask: { accountId: string }
  favoritesStart: { accountId: string; id: string }
  favoritesUpdate: {
    accountId: string
    taskId: string
    status: FavoritesTask['status']
    reason: string | null
    errorCode?: string | null
  }
  favoritesSave: FavoritesPage
  favoriteFolders: { accountId: string }
  accounts: undefined
  createAccount: { id: string; name: string }
  bindAccount: { accountId: string; remoteId: string; nickname: string; avatarUrl: string | null }
  renameAccount: { accountId: string; name: string }
  clearAccountAuth: { accountId: string }
  removeAccount: { accountId: string }
  backup: { reason: 'manual' | 'before-account-remove' }
  setting: { key: 'activeAccount' | 'theme'; value?: string }
  checkpoint: { accountId: string }
  collection: { accountId: string }
  startCollection: { accountId: string; id: string; mode: CollectionTask['mode'] }
  updateCollection: {
    accountId: string
    taskId: string
    status: CollectionTask['status']
    reason: string | null
    errorCode?: string | null
  }
  saveCollectionPage: {
    accountId: string
    taskId: string
    remoteId: string
    requestCursor: string
    items: Work[]
    cursor: string
    hasMore: boolean
  }
  savePage: {
    accountId: string
    remoteId: string
    items: Work[]
    cursor: string
    hasMore: boolean
    preserveCheckpoint?: boolean
  }
  query: Query
  libraryOverview: { accountId: string }
  matchingIds: Filter
  deleteLocal: { accountId: string; workIds: string[] }
  unlikeTask: { accountId: string; taskId?: string }
  unlikeHistory: { accountId: string }
  unlikeItems: { accountId: string; taskId: string; offset: number; limit: number }
  unlikeCreate: { accountId: string; id: string; workIds: string[]; mode: 'single' | 'batch' }
  unlikeUpdate: {
    accountId: string
    taskId: string
    status: UnlikeTask['status']
    reason: string | null
    errorCode?: string | null
  }
  unlikeNext: { accountId: string; taskId: string }
  unlikeReserve: { accountId: string; taskId: string; workId: string }
  unlikeFinish: {
    accountId: string
    taskId: string
    workId: string
    status: 'success' | 'failed' | 'unknown'
    reason: string | null
    errorCode: string | null
  }
  unlikeResolve: { accountId: string; taskId: string; workId: string; liked: boolean }
  queueState: { accountId: string }
  queueCreate: QueueCreate
  queueResume: { accountId: string; queueId: string }
  queueMove: { accountId: string; queueId: string; target: 'next' | 'previous' | number }
  queueProgress: PlaybackScope & { position: PlaybackPosition; sequence: number }
  queueEnd: PlaybackScope & { position: PlaybackPosition; advance: boolean }
  queueReplay: PlaybackScope
  queueDismiss: PlaybackScope
  queueItems: { accountId: string; queueId: string; offset: number; limit: number }
  playbackPreferences: { preferences?: PlaybackPreferences }
  prepareExport: { accountId: string; source: QueueCreate['source'] }
  finishExport: { accountId: string; token: string; file: string }
  prepareImport: { accountId: string; file: string }
  commitImport: { accountId: string; token: string }
  discardTransfer: { token: string }
  sqliteVersion: undefined
  close: undefined
}
export interface Replies {
  appPreferences: AppPreferences
  windowState: WindowState | null
  checkDatabase: { ok: boolean; checkedAt: number; issues: number }
  favoritesTask: FavoritesTask | null
  favoritesStart: FavoritesTask
  favoritesUpdate: FavoritesTask
  favoritesSave: FavoritesTask
  favoriteFolders: FavoriteFolder[]
  accounts: Account[]
  createAccount: Account
  bindAccount: Account
  renameAccount: Account
  clearAccountAuth: null
  removeAccount: null
  backup: { fileName: string }
  setting: string | null
  checkpoint: { cursor: string; hasMore: boolean } | null
  collection: CollectionTask | null
  startCollection: CollectionTask
  updateCollection: CollectionTask
  saveCollectionPage: CollectionTask
  savePage: PageResult & { previouslyCollected: number }
  query: LibraryPage
  libraryOverview: Omit<LibraryOverview, 'metadataBytes'>
  matchingIds: string[]
  deleteLocal: { removed: number }
  unlikeTask: UnlikeTask | null
  unlikeHistory: UnlikeTask[]
  unlikeItems: { items: UnlikeItem[]; total: number }
  unlikeCreate: UnlikeTask
  unlikeUpdate: UnlikeTask
  unlikeNext: (UnlikeItem & { platformSeen: boolean }) | null
  unlikeReserve: null
  unlikeFinish: UnlikeTask
  unlikeResolve: UnlikeTask
  queueState: QueueState | null
  queueCreate: QueueState
  queueResume: QueueState
  queueMove: QueueState
  queueProgress: QueueState
  queueEnd: QueueState
  queueReplay: QueueState
  queueDismiss: QueueState
  queueItems: Outputs['queueItems']
  playbackPreferences: PlaybackPreferences
  prepareExport: { token: string; count: number }
  finishExport: ExportResult
  prepareImport: ImportPreview
  commitImport: ImportResult
  discardTransfer: null
  sqliteVersion: string
  close: null
}
