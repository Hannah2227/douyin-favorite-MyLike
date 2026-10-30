/** The next local attempt time; it does not promise when Douyin will recover. */
export interface RecoveryState {
  accountId: string
  operation: string
  code: string
  retryAt: number
}

export type RecoveryOperation =
  | 'likes'
  | 'favorites'
  | 'folders'
  | 'folderItems'
  | 'self'
  | 'detail'
  | 'unlike'
  | 'favoriteAdd'
  | 'favoriteRemove'
  | 'favoriteFolderAdd'
  | 'favoriteFolderCreate'
