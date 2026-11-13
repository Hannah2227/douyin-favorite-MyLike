import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  AiClassifier,
  normalizeAssignments,
  parseClassificationLog,
  parseFolderNameSuggestions,
  parseModelAssignments
} from '../../src/main/ai-classifier'
import type { Database } from '../../src/main/storage/client'
import { Store } from '../../src/main/storage/database'
import type { Operation } from '../../src/main/douyin/page-request'
import type { DouyinEngine } from '../../src/main/douyin/engine'
import { AppError } from '../../src/main/errors'
import { runtimeEventCategory, type RuntimeEventInput } from '../../src/shared/runtime-events'
import type { AiClassificationProgress } from '../../src/shared/contracts'

const roots: string[] = []
const stores: Store[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  for (const store of stores.splice(0)) store.call('close', undefined)
  for (const root of roots.splice(0)) {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()))
    expect(basename(root)).toMatch(/^mylike-ai-classifier-/)
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

it('normalizes multiple categories per work and ignores duplicate or invalid assignments', () => {
  expect(
    normalizeAssignments(
      {
        assignments: [
          { workId: '1', categories: ['旅行', '回忆', '旅行'] },
          { workId: '1', category: '回忆' },
          { workId: '2', categories: ['  音乐   分享 '] },
          { workId: 'unknown', categories: ['跳过'] },
          { workId: '1', categories: [null, ' '] }
        ]
      },
      new Set(['1', '2'])
    )
  ).toEqual([
    { workId: '1', category: '旅行' },
    { workId: '1', category: '回忆' },
    { workId: '2', category: '音乐 分享' }
  ])
})

it('parses JSON assignments wrapped in Markdown or model-added text', () => {
  const workIds = new Set(['1'])
  const expected = [{ workId: '1', category: '旅行' }]

  expect(
    parseModelAssignments('```json\n{"assignments":[{"workId":"1","category":"旅行"}]}\n```', workIds)
  ).toEqual(expected)
  expect(
    parseModelAssignments(
      '<think>Let me consider the result.</think>\n分类如下：{"assignments":[{"workId":"1","category":"旅行"}]}',
      workIds
    )
  ).toEqual(expected)
})

it('parses unique AI folder name suggestions and removes an AI prefix', () => {
  expect(parseFolderNameSuggestions('```json\n{"folders":["旅行","AI-美食","旅行","",12]}\n```')).toEqual([
    '旅行',
    '美食'
  ])
})

it('creates private AI folders and records the same work in each assigned folder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mylike-ai-classifier-'))
  roots.push(root)
  const store = new Store(join(root, 'db.sqlite'))
  stores.push(store)
  store.call('createAccount', { id: 'a', name: '账号 A' })
  store.call('bindAccount', {
    accountId: 'a',
    remoteId: 'remote-a',
    nickname: '账号 A',
    avatarUrl: null
  })
  store.call('appPreferences', {
    preferences: {
      deepseekApiKey: 'test-key',
      syncFavoritesToCloud: true
    }
  })
  const work = {
    id: '1234567890123456789',
    title: '旅行记录',
    author: '作者',
    publishedAt: 1,
    coverUrl: null,
    mediaType: 'video' as const,
    isLive: false
  }
  const secondWork = { ...work, id: '1234567890123456790', title: '周末城市漫步' }
  store.call('favoriteConfirm', { accountId: 'a', remoteId: 'remote-a', work })
  store.call('favoriteConfirm', { accountId: 'a', remoteId: 'remote-a', work: secondWork })

  let onlyMatchTravel = false
  let assignOnlyFirstFolder = false
  let assignNoCategories = false
  const classificationRules: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body))
      const userContent = request.messages[1].content as string
      const { works, targetFolders, rule } = JSON.parse(userContent.split('\n')[0]!)
      classificationRules.push(rule)
      const content =
        works.length > 1
          ? 'not-json'
          : JSON.stringify({
              assignments: [
                {
                  workId: works[0].id,
                  categories: assignNoCategories
                    ? []
                    : targetFolders
                        .filter(
                          (_folder: { id: string }, index: number) => !assignOnlyFirstFolder || index === 0
                        )
                        .filter(() => !onlyMatchTravel || works[0].title.includes('旅行'))
                        .map((folder: { id: string }) => folder.id)
                }
              ]
            })
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { content }
            }
          ]
        }),
        { status: 200 }
      )
    })
  )

  const requests: { operation: Operation; parameters: Record<string, string> }[] = []
  const createdFolders: {
    collects_id_str: string
    collects_name: string
    aweme_count: number
    status: number
  }[] = []
  let nextFolderId = 10
  const engine: Pick<DouyinEngine, 'request'> = {
    async request(_accountId, operation, parameters = {}) {
      requests.push({ operation, parameters })
      if (operation === 'folders')
        return {
          status_code: 0,
          collects_list: [
            { collects_id_str: '5', collects_name: '旅行', aweme_count: 2, status: 1 },
            ...createdFolders
          ],
          has_more: 0,
          cursor: '0'
        }
      if (operation === 'favoriteFolderCreate') {
        const folder = {
          collects_id_str: String(nextFolderId++),
          collects_name: parameters.collects_name!,
          aweme_count: 0,
          status: Number(parameters.secret === '1' ? 0 : 1)
        }
        createdFolders.push(folder)
        return {
          status_code: 0,
          collects_info: {
            ...folder,
            total_number: 0
          }
        }
      }
      if (operation === 'detail') {
        const knownWork = [work, secondWork].find((entry) => entry.id === parameters.aweme_id)
        return {
          aweme_detail: {
            aweme_id: parameters.aweme_id,
            desc: knownWork?.title ?? '已收藏作品',
            collect_stat: 1,
            aweme_type: 0,
            video: { cover: { url_list: ['https://p3.douyinpic.com/refreshed-cover.jpg'] } }
          }
        }
      }
      if (operation === 'favoriteAdd') return { status_code: 0 }
      if (operation === 'favoriteFolderAdd') return { status_code: 0 }
      throw new Error(`Unexpected operation: ${operation}`)
    }
  }
  const database: Pick<Database, 'call'> = {
    async call(method, input) {
      return store.call(method, input)
    }
  }
  const progress: { phase: string; current: number; total: number; status: string }[] = []
  const classifier = new AiClassifier(
    database,
    engine,
    async (_accountId, action) => action(() => {}),
    async () => store.call('accounts', undefined).find((account) => account.id === 'a')!,
    () => {},
    undefined,
    (state) => progress.push(state)
  )

  await expect(
    classifier.runClassification('a', {
      folderIds: ['5'],
      createAiFolders: true,
      aiFolderNames: ['创意-回忆']
    })
  ).resolves.toMatchObject({
    classified: 4,
    failed: 0,
    foldersCreated: 1,
    foldersUsed: 2,
    unmatched: 0,
    folderCounts: [
      { title: '旅行', count: 2 },
      { title: 'AI-创意-回忆', count: 2 }
    ]
  })
  expect(classificationRules[0]).toContain('羽毛球、篮球、乒乓球、一般健身')
  expect(classificationRules[0]).toContain('categories 必须返回空数组')
  expect(requests.some((request) => request.operation === 'favoriteFolderCreate')).toBe(false)
  // Classification records local changes; platform writes only happen on an
  // explicit writeback, never as a burst during classification.
  expect(requests.some((request) => request.operation === 'favoriteFolderAdd')).toBe(false)
  const operations = store.call('favoriteWriteOps', { accountId: 'a' })
  const localFolderId = operations.find((operation) => operation.kind === 'folder-create')?.folderId
  expect(localFolderId).toBeTruthy()
  expect(operations.filter((operation) => operation.kind === 'folder-add')).toHaveLength(4)
  expect(
    operations.filter((operation) => operation.kind === 'folder-add' && operation.folderId === '5')
  ).toHaveLength(2)
  expect(
    operations.filter((operation) => operation.kind === 'folder-add' && operation.folderId === localFolderId)
  ).toHaveLength(2)
  expect(progress).toContainEqual(
    expect.objectContaining({
      phase: 'AI 返回格式异常，正在拆分 2 条批次重试',
      current: 0,
      total: 2,
      status: 'running'
    })
  )
  expect(progress).toContainEqual(
    expect.objectContaining({ phase: 'AI 已完成分类', current: 2, total: 2, status: 'running' })
  )
  expect(progress.at(-1)).toMatchObject({ phase: '分类完成', status: 'completed' })
  expect(store.call('favoriteFolders', { accountId: 'a' })).toMatchObject([
    { title: 'AI-创意-回忆', localCount: 2 },
    { title: '旅行', localCount: 2 }
  ])

  onlyMatchTravel = true
  await expect(
    classifier.runClassification('a', {
      folderIds: ['5'],
      createAiFolders: false,
      aiFolderNames: []
    })
  ).resolves.toMatchObject({
    classified: 1,
    failed: 0,
    foldersCreated: 0,
    foldersUsed: 1,
    unmatched: 1,
    folderCounts: [{ title: '旅行', count: 1 }]
  })
  expect(requests.filter((request) => request.operation === 'favoriteFolderCreate')).toHaveLength(0)

  onlyMatchTravel = false
  await expect(
    classifier.runClassification('a', {
      folderIds: ['5'],
      createAiFolders: true,
      aiFolderNames: ['创意-回忆']
    })
  ).resolves.toMatchObject({
    classified: 4,
    failed: 0,
    foldersCreated: 0,
    foldersUsed: 2,
    unmatched: 0,
    folderCounts: [
      { title: '旅行', count: 2 },
      { title: 'AI-创意-回忆', count: 2 }
    ]
  })
  expect(requests.filter((request) => request.operation === 'favoriteFolderCreate')).toHaveLength(0)

  const likedWork = { ...work, id: '1234567890123456790', title: '喜欢里的旅行作品' }
  const secondLikedWork = { ...work, id: '1234567890123456791', title: '喜欢里的城市散步' }
  store.call('savePage', {
    accountId: 'a',
    remoteId: 'remote-a',
    items: [likedWork, secondLikedWork],
    cursor: '0',
    hasMore: false
  })
  const detailBeforeLikes = requests.filter((request) => request.operation === 'detail').length
  await expect(
    classifier.runClassification('a', {
      folderIds: ['5'],
      createAiFolders: false,
      aiFolderNames: [],
      source: 'likes'
    })
  ).resolves.toMatchObject({ classified: 2, failed: 0, foldersUsed: 1 })
  expect(requests.filter((request) => request.operation === 'detail').length).toBeGreaterThanOrEqual(
    detailBeforeLikes + 2
  )
  expect(
    store
      .call('query', {
        accountId: 'a',
        source: 'favorites',
        folderId: '5',
        search: '',
        mediaType: 'all',
        year: null,
        month: null,
        sort: 'collected',
        offset: 0,
        limit: 60
      })
      .items.map((item) => item.id)
  ).toEqual(expect.arrayContaining([likedWork.id, secondLikedWork.id]))
  expect(
    store
      .call('query', {
        accountId: 'a',
        source: 'favorites',
        folderId: '5',
        search: '',
        mediaType: 'all',
        year: null,
        month: null,
        sort: 'collected',
        offset: 0,
        limit: 60
      })
      .items.filter((item) => [likedWork.id, secondLikedWork.id].includes(item.id))
      .every((item) => item.coverUrl === 'https://p3.douyinpic.com/refreshed-cover.jpg')
  ).toBe(true)

  assignOnlyFirstFolder = true
  const priorAddCount = requests.filter((request) => request.operation === 'favoriteFolderAdd').length
  await expect(
    classifier.runClassification('a', {
      folderIds: ['5'],
      createAiFolders: true,
      aiFolderNames: ['新分类']
    })
  ).rejects.toMatchObject({
    code: 'AI_RESPONSE_INVALID',
    message: expect.stringContaining('未创建收藏夹且未写入任何作品')
  })
  expect(requests.filter((request) => request.operation === 'favoriteFolderAdd')).toHaveLength(priorAddCount)
  expect(requests.filter((request) => request.operation === 'favoriteFolderCreate')).toHaveLength(0)

  assignOnlyFirstFolder = false
  assignNoCategories = true
  await expect(
    classifier.runClassification('a', {
      folderIds: ['5'],
      createAiFolders: true,
      aiFolderNames: ['无匹配分类']
    })
  ).resolves.toMatchObject({
    classified: 0,
    failed: 0,
    foldersCreated: 0,
    foldersUsed: 0,
    unmatched: 3,
    folderCounts: []
  })
  expect(requests.filter((request) => request.operation === 'favoriteFolderCreate')).toHaveLength(0)
})

it('records the AI phase when the identity request fails, even though standalone self failures are filtered', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mylike-ai-classifier-'))
  roots.push(root)
  const store = new Store(join(root, 'db.sqlite'))
  stores.push(store)
  store.call('createAccount', { id: 'a', name: '账号 A' })
  store.call('bindAccount', {
    accountId: 'a',
    remoteId: 'remote-a',
    nickname: '账号 A',
    avatarUrl: null
  })
  store.call('appPreferences', {
    preferences: {
      deepseekApiKey: 'test-key',
      siliconFlowApiKey: 'test-key'
    }
  })
  const events: RuntimeEventInput[] = []
  const classifier = new AiClassifier(
    { call: async (method, input) => store.call(method, input) } as Database,
    {
      async request() {
        throw new AppError('AUTH_REQUIRED', '尚未取得登录身份。', 'payload.identity')
      }
    } as Pick<DouyinEngine, 'request'>,
    async (_accountId, action) => action(() => {}),
    async () => {
      throw new AppError('AUTH_REQUIRED', '尚未取得登录身份。', 'payload.identity')
    },
    () => {},
    (_accountId, event) => events.push(event)
  )

  await expect(classifier.runClassification('a')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({
    kind: 'task',
    operation: 'aiClassify',
    code: 'AUTH_REQUIRED',
    rule: 'payload.identity',
    message: 'AI 自动分类在“核验抖音身份”阶段失败。'
  })
  expect(runtimeEventCategory(events[0]!)).toBe('exception')
})

it('reports a missing DeepSeek key as an AI configuration issue, not a Douyin login issue', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mylike-ai-classifier-'))
  roots.push(root)
  const store = new Store(join(root, 'db.sqlite'))
  stores.push(store)
  store.call('createAccount', { id: 'a', name: '账号 A' })
  store.call('appPreferences', { preferences: {} })
  const events: RuntimeEventInput[] = []
  const classifier = new AiClassifier(
    { call: async (method, input) => store.call(method, input) } as Database,
    {
      async request(_accountId, operation) {
        if (operation === 'folders') return { status_code: 0, collects_list: [], has_more: 0, cursor: '0' }
        throw new Error('Should not access Douyin')
      }
    } as Pick<DouyinEngine, 'request'>,
    async (_accountId, action) => action(() => {}),
    async () => {
      throw new Error('Should not check the Douyin identity')
    },
    () => {},
    (_accountId, event) => events.push(event)
  )

  await expect(classifier.runClassification('a')).rejects.toMatchObject({
    code: 'AI_DEEPSEEK_KEY_REQUIRED'
  })
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({
    operation: 'aiClassify',
    code: 'AI_DEEPSEEK_KEY_REQUIRED',
    message: 'AI 自动分类在“读取设置”阶段失败。'
  })
  expect(runtimeEventCategory(events[0]!)).toBe('exception')
})

it('requires SiliconFlow only when a short-title video needs transcription', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mylike-ai-classifier-'))
  roots.push(root)
  const store = new Store(join(root, 'db.sqlite'))
  stores.push(store)
  store.call('createAccount', { id: 'a', name: '账号 A' })
  store.call('bindAccount', {
    accountId: 'a',
    remoteId: 'remote-a',
    nickname: '账号 A',
    avatarUrl: null
  })
  store.call('appPreferences', { preferences: { deepseekApiKey: 'test-key' } })
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work: {
      id: '1234567890123456789',
      title: '猫',
      author: '作者',
      publishedAt: 1,
      coverUrl: null,
      mediaType: 'video',
      isLive: false
    }
  })
  const events: RuntimeEventInput[] = []
  const classifier = new AiClassifier(
    { call: async (method, input) => store.call(method, input) } as Database,
    {
      async request(_accountId, operation) {
        if (operation === 'folders') return { status_code: 0, collects_list: [], has_more: 0, cursor: '0' }
        throw new Error('Should not access Douyin')
      }
    } as Pick<DouyinEngine, 'request'>,
    async (_accountId, action) => action(() => {}),
    async () => store.call('accounts', undefined).find((account) => account.id === 'a')!,
    () => {},
    (_accountId, event) => events.push(event)
  )

  await expect(
    classifier.runClassification('a', {
      folderIds: [],
      createAiFolders: true,
      aiFolderNames: ['AI-其他']
    })
  ).rejects.toMatchObject({ code: 'AI_SILICONFLOW_KEY_REQUIRED' })
  expect(events[0]).toMatchObject({
    operation: 'aiClassify',
    code: 'AI_SILICONFLOW_KEY_REQUIRED'
  })
})

it('records AI network failures without exposing the underlying exception', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mylike-ai-classifier-'))
  roots.push(root)
  const store = new Store(join(root, 'db.sqlite'))
  stores.push(store)
  store.call('createAccount', { id: 'a', name: '账号 A' })
  store.call('bindAccount', {
    accountId: 'a',
    remoteId: 'remote-a',
    nickname: '账号 A',
    avatarUrl: null
  })
  store.call('appPreferences', { preferences: { deepseekApiKey: 'test-secret-key' } })
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work: {
      id: '1234567890123456789',
      title: '旅行记录',
      author: '作者',
      publishedAt: 1,
      coverUrl: null,
      mediaType: 'video',
      isLive: false
    }
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('fetch failed: test-secret-key', {
        cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
      })
    })
  )
  const events: RuntimeEventInput[] = []
  const classifier = new AiClassifier(
    { call: async (method, input) => store.call(method, input) } as Database,
    {
      async request(_accountId, operation) {
        if (operation === 'folders') return { status_code: 0, collects_list: [], has_more: 0, cursor: '0' }
        throw new Error('Unexpected Douyin request')
      }
    } as Pick<DouyinEngine, 'request'>,
    async (_accountId, action) => action(() => {}),
    async () => store.call('accounts', undefined).find((account) => account.id === 'a')!,
    () => {},
    (_accountId, event) => events.push(event)
  )

  await expect(
    classifier.runClassification('a', {
      folderIds: [],
      createAiFolders: true,
      aiFolderNames: ['AI-其他']
    })
  ).rejects.toMatchObject({
    code: 'AI_NETWORK_ERROR',
    message: '无法连接 AI 服务，请检查网络连接和 API Key 格式后重试。（诊断代码：ECONNRESET）'
  })
  expect(events[0]).toMatchObject({
    operation: 'aiClassify',
    code: 'AI_NETWORK_ERROR',
    message: 'AI 自动分类在“调用 AI 分类”阶段失败。 网络原因：ECONNRESET。'
  })
  expect(JSON.stringify(events)).not.toContain('test-secret-key')
})

it('tests the saved provider key and reports a clear result for success or HTTP 401', async () => {
  const requests: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init })
      return new Response('{}', { status: 401 })
    })
  )
  const classifier = new AiClassifier(
    {
      call: async () => ({
        deepseekApiKey: 'saved-deepseek-key',
        siliconFlowApiKey: '',
        favoriteCategoryHints: ''
      })
    } as Pick<Database, 'call'>,
    {
      async request() {
        throw new Error('Unexpected Douyin request')
      }
    } as Pick<DouyinEngine, 'request'>,
    async (_accountId, action) => action(() => {}),
    async () => {
      throw new Error('Unexpected identity request')
    },
    () => {}
  )

  await expect(classifier.testConnection('deepseek')).rejects.toMatchObject({
    code: 'AI_AUTH_REJECTED',
    message: 'DeepSeek 拒绝了 API Key（HTTP 401）。请确认使用该平台签发的有效 Key，且账户可用。'
  })
  expect(requests).toHaveLength(1)
  expect(requests[0]?.url).toBe('https://api.deepseek.com/models')
  expect(new Headers(requests[0]?.init?.headers).get('Authorization')).toBe('Bearer saved-deepseek-key')

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 }))
  )
  await expect(classifier.testConnection('deepseek')).resolves.toBeNull()
})

it('reports malformed model output as an AI response error, not a Douyin API error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mylike-ai-classifier-'))
  roots.push(root)
  const store = new Store(join(root, 'db.sqlite'))
  stores.push(store)
  store.call('createAccount', { id: 'a', name: '账号 A' })
  store.call('bindAccount', {
    accountId: 'a',
    remoteId: 'remote-a',
    nickname: '账号 A',
    avatarUrl: null
  })
  store.call('appPreferences', { preferences: { deepseekApiKey: 'test-key' } })
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work: {
      id: '1234567890123456789',
      title: '旅行记录',
      author: '作者',
      publishedAt: 1,
      coverUrl: null,
      mediaType: 'video',
      isLive: false
    }
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'not-json' } }] }), {
          status: 200
        })
    )
  )
  const events: RuntimeEventInput[] = []
  const progress: AiClassificationProgress[] = []
  const classifier = new AiClassifier(
    { call: async (method, input) => store.call(method, input) } as Database,
    {
      async request(_accountId, operation) {
        if (operation === 'folders') return { status_code: 0, collects_list: [], has_more: 0, cursor: '0' }
        throw new Error('Unexpected Douyin request')
      }
    } as Pick<DouyinEngine, 'request'>,
    async (_accountId, action) => action(() => {}),
    async () => store.call('accounts', undefined).find((account) => account.id === 'a')!,
    () => {},
    (_accountId, event) => events.push(event),
    (state) => progress.push(state)
  )

  await expect(
    classifier.runClassification('a', {
      folderIds: [],
      createAiFolders: true,
      aiFolderNames: ['AI-其他']
    })
  ).rejects.toMatchObject({ code: 'AI_RESPONSE_INVALID' })
  expect(events[0]).toMatchObject({
    operation: 'aiClassify',
    code: 'AI_RESPONSE_INVALID',
    message: 'AI 自动分类在“调用 AI 分类”阶段失败。'
  })
  expect(progress.at(-1)).toMatchObject({
    status: 'failed',
    phase: '调用 AI 分类失败',
    current: 0,
    total: 1,
    error: 'DeepSeek 请求已返回，但分类结果不是有效 JSON 或没有可用分类，请稍后重试。'
  })
})

it('parses failed-write lines from a previous classification log', () => {
  expect(
    parseClassificationLog(
      '[AI] 正在写入收藏夹：舞蹈，作品 2 条。\n' +
        '[AI] 写入失败：作品 1234567890123456789 → 舞蹈：抖音暂时无法处理这项操作，请稍后重试。\n' +
        '[AI] 写入失败：作品 1234567890123456790 → 舞蹈：抖音暂时无法处理这项操作，请稍后重试。\n' +
        '[AI] 写入失败：作品 1234567890123456789 → 恋爱：抖音暂时无法处理这项操作，请稍后重试。\n' +
        '[AI] 写入失败：作品 1234567890123456789 → 舞蹈：重复行应去重。'
    )
  ).toEqual([
    { workId: '1234567890123456789', category: '舞蹈' },
    { workId: '1234567890123456790', category: '舞蹈' },
    { workId: '1234567890123456789', category: '恋爱' }
  ])
})

it('re-applies a previous classification log locally without calling the AI', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mylike-ai-classifier-'))
  roots.push(root)
  const store = new Store(join(root, 'db.sqlite'))
  stores.push(store)
  store.call('createAccount', { id: 'a', name: '账号 A' })
  store.call('bindAccount', {
    accountId: 'a',
    remoteId: 'remote-a',
    nickname: '账号 A',
    avatarUrl: null
  })
  const work = {
    id: '1234567890123456789',
    title: '旅行记录',
    author: '作者',
    publishedAt: 1,
    coverUrl: null,
    mediaType: 'video' as const,
    isLive: false
  }
  const secondWork = { ...work, id: '1234567890123456790', title: '周末城市漫步' }
  store.call('favoriteConfirm', { accountId: 'a', remoteId: 'remote-a', work })
  store.call('favoriteConfirm', { accountId: 'a', remoteId: 'remote-a', work: secondWork })

  let aiCalls = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      aiCalls++
      throw new Error('AI must not be called during log recovery')
    })
  )
  const engine = {
    request: async (_accountId: string, operation: Operation) => {
      if (operation === 'folders') return { collects_list: [], has_more: 0, cursor: '0' }
      throw new Error(`Unexpected operation: ${operation}`)
    }
  } as unknown as Pick<DouyinEngine, 'request'>
  const logs: string[] = []
  const classifier = new AiClassifier(
    { call: async (method: any, input: any) => store.call(method, input) } as Database,
    engine,
    async (_accountId, action) => action(() => {}),
    async () => store.call('accounts', undefined).find((account) => account.id === 'a')!,
    () => {},
    () => {},
    () => {},
    (line) => logs.push(line)
  )

  const result = await classifier.importClassificationLog(
    'a',
    'favorites',
    '[AI] 写入失败：作品 1234567890123456789 → 舞蹈：抖音暂时无法处理这项操作，请稍后重试。\n' +
      '[AI] 写入失败：作品 1234567890123456790 → 舞蹈：抖音暂时无法处理这项操作，请稍后重试。\n' +
      '[AI] 写入失败：作品 1234567890123456789 → 恋爱：抖音暂时无法处理这项操作，请稍后重试。\n' +
      '[AI] 写入失败：作品 9999999999999999999 → 舞蹈：作品已不在本地列表中，跳过。',
    () => {}
  )

  expect(result).toMatchObject({ classified: 3, failed: 1, foldersCreated: 2, foldersUsed: 2 })
  expect(aiCalls).toBe(0)
  expect(parseClassificationLog(logs.join('\n'))).toContainEqual({
    workId: '9999999999999999999',
    category: '舞蹈'
  })
  expect(store.call('favoriteFolders', { accountId: 'a' })).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ title: '舞蹈', localCount: 2 }),
      expect.objectContaining({ title: '恋爱', localCount: 1 })
    ])
  )
  expect(store.call('aiAssignmentPending', { accountId: 'a', source: 'favorites' })).toEqual([])
})

it('lists favorites that have no folder membership yet', () => {
  const root = mkdtempSync(join(tmpdir(), 'mylike-ai-classifier-'))
  roots.push(root)
  const store = new Store(join(root, 'db.sqlite'))
  stores.push(store)
  store.call('createAccount', { id: 'a', name: '账号 A' })
  store.call('bindAccount', {
    accountId: 'a',
    remoteId: 'remote-a',
    nickname: '账号 A',
    avatarUrl: null
  })
  const work = {
    id: '1234567890123456789',
    title: '旅行记录',
    author: '作者',
    publishedAt: 1,
    coverUrl: null,
    mediaType: 'video' as const,
    isLive: false
  }
  const secondWork = { ...work, id: '1234567890123456790', title: '周末城市漫步' }
  store.call('favoriteConfirm', { accountId: 'a', remoteId: 'remote-a', work })
  store.call('favoriteConfirm', { accountId: 'a', remoteId: 'remote-a', work: secondWork })
  store.call('favoriteConfirm', {
    accountId: 'a',
    remoteId: 'remote-a',
    work,
    folder: { id: '8', title: '旅行', remoteCount: 0, localCount: 0 }
  })

  expect(store.call('unclassifiedWorkIds', { accountId: 'a', source: 'favorites' })).toEqual([secondWork.id])
})
