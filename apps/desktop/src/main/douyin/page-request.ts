export type WriteOperation =
  'unlike' | 'favoriteRemove' | 'favoriteAdd' | 'favoriteFolderAdd' | 'favoriteFolderCreate'
export type Operation = 'self' | 'likes' | 'detail' | 'favorites' | 'folders' | 'folderItems' | WriteOperation
export function isWriteOperation(operation: Operation): operation is WriteOperation {
  return ['unlike', 'favoriteRemove', 'favoriteAdd', 'favoriteFolderAdd', 'favoriteFolderCreate'].includes(
    operation
  )
}
export interface PageRequest {
  id: string
  operation: Operation
  parameters: Record<string, string>
  timeout: number
}

// This function is serialized and executed in the MAIN world of the actual Douyin page.
// It must not capture imports, Node objects, IPC, or application services.
async function requestInPage(request: PageRequest) {
  const paths = {
    self: '/aweme/v1/web/user/profile/self/',
    likes: '/aweme/v1/web/aweme/favorite/',
    detail: '/aweme/v1/web/aweme/detail/',
    unlike: '/aweme/v1/web/commit/item/digg/',
    favorites: '/aweme/v1/web/aweme/listcollection/',
    folders: '/aweme/v1/web/collects/list/',
    folderItems: '/aweme/v1/web/collects/video/list/',
    favoriteAdd: '/aweme/v1/web/aweme/collect/',
    favoriteRemove: '/aweme/v1/web/aweme/collect/',
    favoriteFolderAdd: '/aweme/v1/web/collects/video/move/',
    favoriteFolderCreate: '/aweme/v1/web/collects/maintain/'
  }
  const scope = globalThis as typeof globalThis & { __mylikeRequests?: Map<string, AbortController> }
  const controllers = (scope.__mylikeRequests ??= new Map())
  const controller = new AbortController()
  controllers.set(request.id, controller)
  const timer = setTimeout(() => controller.abort(), request.timeout)
  const params = new URLSearchParams({
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    version_code: '290100',
    version_name: '29.1.0',
    update_version_code: '170400',
    cookie_enabled: 'true',
    platform: 'PC',
    ...(['unlike', 'favorites', 'favoriteAdd', 'favoriteRemove'].includes(request.operation)
      ? {}
      : request.parameters)
  })
  if (request.operation === 'favoriteFolderCreate') {
    params.set('version_code', '230000')
    params.set('version_name', '23.0.0')
  }
  if (request.operation === 'favoriteFolderAdd') params.delete('aweme_id')
  try {
    // Match the original page-SDK request: use only the current page's token,
    // never a fabricated or persisted signing value.
    if (request.operation === 'likes') {
      try {
        const token = document.cookie.match(/(?:^|;\s*)msToken=([^;]+)/)?.[1]
        if (token) {
          try {
            params.set('msToken', decodeURIComponent(token))
          } catch {
            params.set('msToken', token)
          }
        }
      } catch {
        /* The page SDK can supply its own token when the cookie is unavailable. */
      }
    }
    const response = await fetch('https://www.douyin.com' + paths[request.operation] + '?' + params, {
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
      method: [
        'unlike',
        'favorites',
        'favoriteAdd',
        'favoriteRemove',
        'favoriteFolderAdd',
        'favoriteFolderCreate'
      ].includes(request.operation)
        ? 'POST'
        : 'GET',
      headers: {
        accept: 'application/json, text/plain, */*',
        ...(['unlike', 'favorites', 'favoriteAdd', 'favoriteRemove'].includes(request.operation)
          ? { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }
          : {})
      },
      body:
        request.operation === 'unlike'
          ? new URLSearchParams({
              aweme_id: request.parameters.aweme_id ?? '',
              item_type: '0',
              type: '0'
            }).toString()
          : request.operation === 'favoriteAdd' || request.operation === 'favoriteRemove'
            ? new URLSearchParams({
                aweme_id: request.parameters.aweme_id ?? '',
                action: request.operation === 'favoriteRemove' ? '0' : '1',
                aweme_type: request.parameters.aweme_type ?? '0'
              }).toString()
            : request.operation === 'favorites'
              ? new URLSearchParams({
                  cursor: request.parameters.cursor ?? '0',
                  count: request.parameters.count ?? '18'
                }).toString()
              : undefined
    })
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > 16 * 1024 * 1024) return { id: request.id, error: 'TOO_LARGE' }
    return { id: request.id, status: response.status, body: await response.text() }
  } catch {
    return { id: request.id, error: controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR' }
  } finally {
    clearTimeout(timer)
    controllers.delete(request.id)
  }
}

export function serializeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}
export function buildPageScript(request: PageRequest): string {
  return `(${requestInPage.toString()})(${serializeForScript(request)})`
}
