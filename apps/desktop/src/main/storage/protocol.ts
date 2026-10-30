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
  UnlikeTask,
  UnlikeItem
} from '../../shared/contracts'
import type { FavoritesPage } from './favorites'
import type { AppPreferences, WindowState } from '../../shared/preferences'
import type { RuntimeEvent, RuntimeEventInput } from '../../shared/runtime-events'

export interface Inputs {
  runtimeEvents: { accountId: string }
  appendRuntimeEvent: { accountId: string; event: RuntimeEventInput }
  appPreferences: { preferences?: Partial<AppPreferences> }
  windowState: { state?: WindowState }
  checkDatabase: Record<string, never>
  favoritesTask: { accountId: string; mode?: 'sync' | 'update' }
  favoritesStart: { accountId: string; id: string; mode?: 'sync' | 'update' }
  favoritesDefer: {
    accountId: string
    taskId: string
    folderId: string
    requestCursor: string
    reason: string
    errorCode: string
  }
  favoritesUpdate: {
    accountId: string
    taskId: string
    status: FavoritesTask['status']
    reason: string | null
    errorCode?: string | null
    mode?: 'sync' | 'update'
  }
  favoritesSave: FavoritesPage
  favoriteFolders: { accountId: string }
  favoriteStatus: { accountId: string; workId: string }
  favoriteWriteGuard: { accountId: string; workId: string }
  favoriteRememberFolder: { accountId: string; remoteId: string; folder: FavoriteFolder }
  favoriteConfirm: { accountId: string; remoteId: string; work: Work; folder?: FavoriteFolder }
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
    mode?: 'update'
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
    checkpointCursor?: string
    traversedCursors?: string[]
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
  unlikeItems: { accountId: string; taskId: string; offset: number; limit: number; issuesOnly?: boolean }
  unlikeSkip: { accountId: string; taskId: string; workId: string; reason: string }
  unlikeCreate: {
    accountId: string
    id: string
    workIds: string[]
    mode: 'single' | 'batch'
    source?: 'likes' | 'favorites'
  }
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
  sqliteVersion: undefined
  close: undefined
}
export interface Replies {
  runtimeEvents: RuntimeEvent[]
  appendRuntimeEvent: null
  appPreferences: AppPreferences
  windowState: WindowState | null
  checkDatabase: { ok: boolean; checkedAt: number; issues: number }
  favoritesTask: FavoritesTask | null
  favoritesStart: FavoritesTask
  favoritesDefer: FavoritesTask
  favoritesUpdate: FavoritesTask
  favoritesSave: FavoritesTask
  favoriteFolders: FavoriteFolder[]
  favoriteStatus: { collected: boolean }
  favoriteWriteGuard: null
  favoriteRememberFolder: FavoriteFolder
  favoriteConfirm: null
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
  unlikeSkip: UnlikeTask
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
  sqliteVersion: string
  close: null
}
