export type Operation = 'self' | 'likes' | 'detail' | 'unlike' | 'favorites' | 'folders' | 'folderItems'
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
    folderItems: '/aweme/v1/web/collects/video/list/'
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
    ...(['unlike', 'favorites'].includes(request.operation) ? {} : request.parameters)
  })
  try {
    const response = await fetch('https://www.douyin.com' + paths[request.operation] + '?' + params, {
      credentials: 'include',
      signal: controller.signal,
      method: ['unlike', 'favorites'].includes(request.operation) ? 'POST' : 'GET',
      headers: {
        accept: 'application/json, text/plain, */*',
        ...(['unlike', 'favorites'].includes(request.operation)
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
