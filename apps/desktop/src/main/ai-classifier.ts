import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  Account,
  AiClassificationProgress,
  AiClassificationResult,
  FavoriteFolder,
  Work
} from '../shared/contracts'
import type { AppPreferences } from '../shared/preferences'
import type { Database } from './storage/client'
import type { DouyinEngine } from './douyin/engine'
import { parseFavoriteFolders, parseMedia, parseWork } from './douyin/parse'
import { AppError, publicError } from './errors'
import type { RuntimeEventInput } from '../shared/runtime-events'

type Run = <T>(accountId: string, action: (check: () => void) => Promise<T>) => Promise<T>
type Assignment = { workId: string; category: string }
type WorkAssignment = { workId: string; categories: string[] }

function normalizeWorkAssignments(value: unknown, workIds: ReadonlySet<string>): WorkAssignment[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const entries = (value as Record<string, unknown>).assignments
  if (!Array.isArray(entries)) return []
  const result = new Map<string, string[]>()
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const assignment = entry as Record<string, unknown>
    const workId =
      typeof assignment.workId === 'string' || typeof assignment.workId === 'number'
        ? String(assignment.workId)
        : ''
    if (!workIds.has(workId)) continue
    if (!Array.isArray(assignment.categories) && typeof assignment.category !== 'string') continue
    const categoriesForWork = result.get(workId) ?? []
    const categories = Array.isArray(assignment.categories) ? assignment.categories : [assignment.category]
    for (const value of categories) {
      if (typeof value !== 'string') continue
      const category = value.trim().replace(/\s+/g, ' ').slice(0, 100)
      if (!category) continue
      if (
        !categoriesForWork.some((existing) => existing.toLocaleLowerCase() === category.toLocaleLowerCase())
      )
        categoriesForWork.push(category)
    }
    result.set(workId, categoriesForWork)
  }
  return [...result].map(([workId, categories]) => ({ workId, categories }))
}

export function normalizeAssignments(value: unknown, workIds: ReadonlySet<string>): Assignment[] {
  return normalizeWorkAssignments(value, workIds).flatMap(({ workId, categories }) =>
    categories.map((category) => ({ workId, category }))
  )
}

function parseModelWorkAssignments(content: string, workIds: ReadonlySet<string>): WorkAssignment[] {
  const text = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]
  const candidates = fenced ? [fenced, text] : [text]

  for (const candidate of candidates) {
    try {
      const assignments = normalizeWorkAssignments(JSON.parse(candidate), workIds)
      if (assignments.length) return assignments
    } catch {
      // The response may wrap JSON in explanatory text or Markdown.
    }

    for (let start = candidate.indexOf('{'); start !== -1; start = candidate.indexOf('{', start + 1)) {
      let depth = 0
      let inString = false
      let escaped = false
      for (let index = start; index < candidate.length; index++) {
        const character = candidate[index]!
        if (inString) {
          if (escaped) escaped = false
          else if (character === '\\') escaped = true
          else if (character === '"') inString = false
          continue
        }
        if (character === '"') inString = true
        else if (character === '{') depth++
        else if (character === '}' && --depth === 0) {
          try {
            const assignments = normalizeWorkAssignments(
              JSON.parse(candidate.slice(start, index + 1)),
              workIds
            )
            if (assignments.length) return assignments
          } catch {
            break
          }
          break
        }
      }
    }
  }

  throw new AppError(
    'AI_RESPONSE_INVALID',
    'DeepSeek 请求已返回，但分类结果不是有效 JSON 或没有可用分类，请稍后重试。'
  )
}

export function parseModelAssignments(content: string, workIds: ReadonlySet<string>): Assignment[] {
  const assignments = parseModelWorkAssignments(content, workIds).flatMap(({ workId, categories }) =>
    categories.map((category) => ({ workId, category }))
  )
  if (!assignments.length)
    throw new AppError(
      'AI_RESPONSE_INVALID',
      'DeepSeek 请求已返回，但分类结果不是有效 JSON 或没有可用分类，请稍后重试。'
    )
  return assignments
}

const emptyClassification = (): AiClassificationResult => ({
  classified: 0,
  failed: 0,
  failedItems: [],
  foldersCreated: 0,
  foldersUsed: 0,
  unmatched: 0,
  folderCounts: []
})

/** Extracts `作品 <id> → <收藏夹>` pairs from a previous classification log. */
export function parseClassificationLog(text: string): { workId: string; category: string }[] {
  const seen = new Set<string>()
  const items: { workId: string; category: string }[] = []
  const pattern = /作品\s+(\d{5,30})\s*→\s*([^\n：:]+?)\s*[：:]/gu
  for (const match of text.matchAll(pattern)) {
    const workId = match[1]!
    const category = match[2]!.trim()
    if (!workId || !category) continue
    const key = `${workId}\u0000${category}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push({ workId, category })
  }
  return items
}

export function parseFolderNameSuggestions(content: string): string[] {
  const text = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]
  const candidate = fenced ?? text.match(/\{[\s\S]*\}/)?.[0]
  if (!candidate) throw new AppError('AI_RESPONSE_INVALID', 'AI 没有返回可解析的收藏夹名称，请重试。')
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    throw new AppError('AI_RESPONSE_INVALID', 'AI 返回的收藏夹名称不是有效 JSON，请重试。')
  }
  if (!parsed || typeof parsed !== 'object' || !('folders' in parsed) || !Array.isArray(parsed.folders))
    throw new AppError('AI_RESPONSE_INVALID', 'AI 返回内容缺少收藏夹名称列表，请重试。')
  const names = [
    ...new Set(
      parsed.folders
        .filter((name): name is string => typeof name === 'string')
        .map((name) =>
          name
            .trim()
            .replace(/^AI[-：:]\s*/i, '')
            .trim()
        )
        .filter((name) => !!name && name.length <= 27)
    )
  ].slice(0, 10)
  if (!names.length) throw new AppError('AI_RESPONSE_INVALID', 'AI 没有生成有效的收藏夹名称，请重试。')
  return names
}

const lineNames = (value: string) =>
  [
    ...new Set(
      value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    )
  ].slice(0, 100)

const fetchAi = async (url: string, init: RequestInit): Promise<Response> => {
  try {
    return await fetch(url, init)
  } catch (error) {
    const causeCode =
      typeof error === 'object' &&
      error !== null &&
      'cause' in error &&
      typeof error.cause === 'object' &&
      error.cause !== null &&
      'code' in error.cause &&
      typeof error.cause.code === 'string' &&
      /^[A-Z0-9_]{1,40}$/.test(error.cause.code)
        ? error.cause.code
        : undefined
    console.error('[AI] Service request failed before receiving a response.', {
      error: error instanceof Error ? error.name : 'unknown',
      ...(causeCode ? { causeCode } : {})
    })
    throw new AppError(
      'AI_NETWORK_ERROR',
      `无法连接 AI 服务，请检查网络连接和 API Key 格式后重试。${causeCode ? `（诊断代码：${causeCode}）` : ''}`
    )
  }
}

const requestJson = async (
  url: string,
  init: RequestInit,
  provider: 'DeepSeek' | 'SiliconFlow' = 'DeepSeek'
): Promise<any> => {
  const response = await fetchAi(url, init)
  if ([401, 403].includes(response.status))
    throw new AppError(
      'AI_AUTH_REJECTED',
      `${provider} 拒绝了 API Key（HTTP ${response.status}）。请确认使用该平台签发的有效 Key，且账户可用。`
    )
  if (!response.ok)
    throw new AppError(
      'AI_API_REJECTED',
      `${provider} 请求失败（HTTP ${response.status}），请检查账户额度或服务状态。`
    )
  const body = await response.text()
  let data: any
  try {
    data = JSON.parse(body)
  } catch {
    throw new AppError('AI_API_REJECTED', `AI 服务返回了无法解析的内容（HTTP ${response.status}）。`)
  }
  return data
}

const missingApiKey = (provider: 'deepseek' | 'siliconflow') =>
  new AppError(
    provider === 'deepseek' ? 'AI_DEEPSEEK_KEY_REQUIRED' : 'AI_SILICONFLOW_KEY_REQUIRED',
    `请先在设置中填写 ${provider === 'deepseek' ? 'DeepSeek' : 'SiliconFlow'} API Key。`
  )

export class AiClassifier {
  constructor(
    private readonly db: Pick<Database, 'call'>,
    private readonly engine: Pick<DouyinEngine, 'request'>,
    private readonly run: Run,
    private readonly identity: (accountId: string, check: () => void) => Promise<Account>,
    private readonly changed: () => void,
    private readonly report: (accountId: string, event: RuntimeEventInput) => void = () => {},
    private readonly onProgress: (progress: AiClassificationProgress) => void = () => {},
    private readonly log: (line: string) => void = () => {}
  ) {}

  async testConnection(provider: 'deepseek' | 'siliconflow'): Promise<null> {
    const preferences = (await this.db.call('appPreferences', {})) as AppPreferences
    const apiKey = provider === 'deepseek' ? preferences.deepseekApiKey : preferences.siliconFlowApiKey
    if (!apiKey) throw missingApiKey(provider)
    const response = await fetchAi(
      provider === 'deepseek' ? 'https://api.deepseek.com/models' : 'https://api.siliconflow.cn/v1/models',
      { headers: { Authorization: `Bearer ${apiKey}` } }
    )
    if ([401, 403].includes(response.status))
      throw new AppError(
        'AI_AUTH_REJECTED',
        `${provider === 'deepseek' ? 'DeepSeek' : 'SiliconFlow'} 拒绝了 API Key（HTTP ${response.status}）。请确认使用该平台签发的有效 Key，且账户可用。`
      )
    if (!response.ok)
      throw new AppError(
        'AI_API_REJECTED',
        `${provider === 'deepseek' ? 'DeepSeek' : 'SiliconFlow'} 测试请求失败（HTTP ${response.status}），请检查账户状态或服务状态。`
      )
    return null
  }

  async suggestFolderNames(
    accountId: string,
    source: 'likes' | 'favorites' = 'favorites'
  ): Promise<{ folderNames: string[] }> {
    return this.run(accountId, async (check) => {
      const preferences = (await this.db.call('appPreferences', {})) as AppPreferences
      if (!preferences.deepseekApiKey) throw missingApiKey('deepseek')
      const account = await this.identity(accountId, check)
      if (!account.remoteId) throw new AppError('AUTH_REQUIRED', '请先登录并核验抖音账号。')
      const works = await this.works(accountId, source, check)
      if (!works.length)
        throw new AppError(
          'AI_RESPONSE_INVALID',
          `${source === 'likes' ? '喜欢' : '收藏'}列表为空，暂时无法生成分类名称。`
        )
      const data = await requestJson('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${preferences.deepseekApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          temperature: 0.3,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: '根据短视频标题和作者生成简洁、互不重复的中文收藏夹名称。只输出 JSON。'
            },
            {
              role: 'user',
              content: `${JSON.stringify({
                preferredCategories: lineNames(preferences.favoriteCategoryHints),
                works: works.slice(0, 80).map(({ title, author }) => ({ title, author }))
              })}\n输出格式：{"folders":["名称1","名称2"]}。不要加 AI- 前缀，每个名称不超过 27 个字符。`
            }
          ]
        })
      })
      check()
      const content = data.choices?.[0]?.message?.content
      if (typeof content !== 'string' || !content.trim())
        throw new AppError('AI_RESPONSE_INVALID', 'AI 没有返回收藏夹名称，请重试。')
      return { folderNames: parseFolderNameSuggestions(content) }
    })
  }

  async runClassification(
    accountId: string,
    options: {
      folderIds: string[]
      createAiFolders: boolean
      aiFolderNames: string[]
      source?: 'likes' | 'favorites'
      onlyUnclassified?: boolean
    } = {
      folderIds: [],
      createAiFolders: false,
      aiFolderNames: []
    }
  ): Promise<AiClassificationResult> {
    this.thumbnailBlocked = false
    let phase = '启动任务'
    let progress: AiClassificationProgress = {
      accountId,
      status: 'running',
      phase: '正在准备作品',
      current: 0,
      total: 0,
      startedAt: Date.now()
    }
    const updateProgress = (update: Partial<AiClassificationProgress>) => {
      progress = { ...progress, ...update }
      this.onProgress(progress)
    }
    updateProgress({})
    try {
      const result = await this.run(accountId, async (check) => {
        phase = '读取设置'
        const preferences = (await this.db.call('appPreferences', {})) as AppPreferences
        if (!preferences.deepseekApiKey) throw missingApiKey('deepseek')
        phase = '核验抖音身份'
        const account = await this.identity(accountId, check)
        if (!account.remoteId) throw new AppError('AUTH_REQUIRED', '请先登录并核验抖音账号。')
        phase = '读取本地收藏'
        const source = options.source ?? 'favorites'
        let works = await this.works(accountId, source, check)
        if (options.onlyUnclassified) {
          const unclassified = new Set(
            (await this.db.call('unclassifiedWorkIds', { accountId, source })) as string[]
          )
          works = works.filter((work) => unclassified.has(work.id))
        }
        console.info(`[AI] ${source === 'likes' ? '喜欢添加' : '收藏分类'}开始：读取 ${works.length} 条。`)
        this.log(
          `\n===== ${new Date().toISOString()} ${source === 'likes' ? '喜欢添加' : '收藏分类'}：${works.length} 条 =====`
        )
        if (!works.length) {
          updateProgress({ status: 'completed', phase: '没有待分类作品' })
          return {
            classified: 0,
            failed: 0,
            failedItems: [],
            foldersCreated: 0,
            foldersUsed: 0,
            unmatched: 0,
            folderCounts: []
          }
        }
        const aiFolderNames: string[] = []
        if (options.createAiFolders) {
          const seenNames = new Set<string>()
          for (const rawName of options.aiFolderNames) {
            const name = rawName.trim()
            if (!name) continue
            const normalizedName = /^AI[-：:]\s*/i.test(name)
              ? name.replace(/^AI[-：:]\s*/i, 'AI-').trim()
              : `AI-${name}`
            if (normalizedName.length > 30)
              throw new AppError('AI_RESPONSE_INVALID', `收藏夹名称“${normalizedName}”超过 30 个字符。`)
            const key = normalizedName.toLocaleLowerCase()
            if (!seenNames.has(key)) {
              seenNames.add(key)
              aiFolderNames.push(normalizedName)
            }
          }
        }
        if (!options.folderIds.length && !aiFolderNames.length)
          throw new AppError(
            'AI_RESPONSE_INVALID',
            '请至少选择一个已存在的收藏夹，或勾选创建并输入 AI 收藏夹名称。'
          )
        phase = '读取抖音收藏夹'
        const folders = await this.remoteFolders(accountId, check)
        const foldersById = new Map(folders.map((folder) => [folder.id, folder]))
        const targetFolders = options.folderIds.map((id) => foldersById.get(id))
        if (targetFolders.some((folder) => !folder))
          throw new AppError('AI_RESPONSE_INVALID', '所选收藏夹已不存在，请刷新后重新选择。')
        const selectedFolders = targetFolders.filter((folder): folder is FavoriteFolder => !!folder)
        const foldersByName = new Map(folders.map((folder) => [folder.title.toLocaleLowerCase(), folder]))
        for (const name of aiFolderNames) {
          const existing = foldersByName.get(name.toLocaleLowerCase())
          if (existing && !selectedFolders.some((folder) => folder.id === existing.id))
            selectedFolders.push(existing)
        }
        const pendingAiFolders = aiFolderNames.filter((name) => !foldersByName.has(name.toLocaleLowerCase()))
        phase = '调用 AI 分类'
        updateProgress({ phase: '正在分析作品', total: works.length, current: 0 })
        const assignments = await this.classify(
          works,
          preferences,
          accountId,
          check,
          selectedFolders,
          pendingAiFolders,
          (phase, current, total) => updateProgress({ phase, current, total })
        )
        console.info(`[AI] DeepSeek 返回 ${assignments.length} 条分类结果。`)
        // Persist the AI output before applying it. If the app is closed or a
        // local write fails, the same result can be re-applied later without
        // calling the AI again. Each new run supersedes the previous one.
        await this.db.call('aiAssignmentClear', { accountId, source })
        await this.db.call('aiAssignmentSave', {
          accountId,
          source,
          items: assignments.map((assignment) => ({
            workId: assignment.workId,
            category: assignment.category
          }))
        })
        updateProgress({ phase: '整理分类结果', current: 0, total: assignments.length })
        const matchedWorkIds = new Set(assignments.map((assignment) => assignment.workId))
        const unmatched = works.length - matchedWorkIds.size
        if (!assignments.length) {
          updateProgress({
            status: 'completed',
            phase: '没有作品匹配已选收藏夹',
            current: works.length,
            total: works.length
          })
          return {
            classified: 0,
            failed: 0,
            failedItems: [],
            foldersCreated: 0,
            foldersUsed: 0,
            unmatched,
            folderCounts: []
          }
        }
        const allowedCategories = new Map<string, string>()
        for (const folder of selectedFolders)
          allowedCategories.set(folder.title.toLocaleLowerCase(), folder.title)
        for (const name of pendingAiFolders) allowedCategories.set(name.toLocaleLowerCase(), name)
        const grouped = new Map<string, string[]>()
        for (const assignment of assignments) {
          const category = allowedCategories.get(assignment.category.toLocaleLowerCase())
          if (!category)
            throw new AppError(
              'AI_RESPONSE_INVALID',
              `AI 返回了未选择的收藏夹“${assignment.category}”，未写入任何作品。`
            )
          const ids = grouped.get(category) ?? []
          ids.push(assignment.workId)
          grouped.set(category, ids)
        }
        if (unmatched === 0 && allowedCategories.size > 1 && grouped.size === 1) {
          const [category, ids] = [...grouped][0]!
          throw new AppError(
            'AI_RESPONSE_INVALID',
            `AI 将 ${ids.length} 条作品全部分配到“${category}”，但本次选择了 ${allowedCategories.size} 个收藏夹。为避免错误写入，未创建收藏夹且未写入任何作品；请检查分类名称或重新选择收藏夹。`
          )
        }
        const folderMap = new Map(folders.map((folder) => [folder.title, folder]))
        let foldersCreated = 0
        for (const name of pendingAiFolders.filter((name) => grouped.has(name))) {
          phase = '创建 AI 收藏夹'
          const folder = await this.db.call('favoriteLocalFolderCreate', {
            accountId,
            remoteId: account.remoteId,
            id: `local-${randomUUID()}`,
            title: name,
            private: true,
            queueWrite: preferences.syncFavoritesToCloud
          })
          folderMap.set(folder.title, folder)
          folderMap.set(name, folder)
          foldersCreated++
          console.info(`[AI] 已在本地创建收藏夹：${folder.title}`)
        }
        const writeGroups = [...grouped].map(([category, ids]) => {
          const folder = folderMap.get(category)
          if (!folder)
            throw new AppError('AI_RESPONSE_INVALID', `目标收藏夹“${category}”已不存在，未写入任何作品。`)
          return { category, ids, folder }
        })
        const details = new Map(
          works
            .filter((work) => assignments.some((assignment) => assignment.workId === work.id))
            .map((work) => [work.id, { type: '2', work }] as const)
        )
        let classified = 0
        let failed = 0
        const failedItems: { workId: string; category: string; reason: string }[] = []
        const folderCounts = new Map<string, number>()
        const thumbnailCache = new Map<string, Work>()
        const writeTotal = writeGroups.reduce((total, group) => total + group.ids.length, 0)
        let writeCurrent = 0
        updateProgress({ phase: '写入本地收藏夹', current: 0, total: writeTotal })
        for (const { category, ids, folder } of writeGroups) {
          console.info(`[AI] 正在写入收藏夹：${category}，作品 ${ids.length} 条。`)
          for (const workId of ids) {
            phase = '写入 AI 分类'
            check()
            const detail = details.get(workId)
            if (!detail) continue
            try {
              const localWork = thumbnailCache.get(workId) ?? detail.work
              const work =
                source === 'likes' ? await this.refreshThumbnail(accountId, localWork, check) : localWork
              thumbnailCache.set(workId, work)
              // Classification is a local change. Recording it here and pushing
              // it only through an explicit writeback avoids a burst of platform
              // writes that trips risk control and fails every remaining item.
              await this.db.call('favoriteConfirm', {
                accountId,
                remoteId: account.remoteId,
                work,
                folder,
                favoriteAddIntent: source === 'likes',
                queueWrite: preferences.syncFavoritesToCloud,
                queueFavoriteAdd: source === 'likes' && preferences.syncFavoritesToCloud
              })
              await this.db.call('aiAssignmentComplete', { accountId, source, workId, category })
              classified++
              folderCounts.set(category, (folderCounts.get(category) ?? 0) + 1)
            } catch (error) {
              failed++
              const reason = error instanceof Error ? error.message : String(error)
              failedItems.push({ workId, category, reason })
              console.error(`[AI] 写入失败：作品 ${workId} → ${category}：${reason}`)
              this.log(`[AI] 写入失败：作品 ${workId} → ${category}：${reason}`)
            } finally {
              writeCurrent++
              updateProgress({ current: writeCurrent, total: writeTotal })
            }
          }
        }
        this.changed()
        console.info(
          `[AI] 分类完成：成功 ${classified} 条，失败 ${failed} 条，创建 ${foldersCreated} 个收藏夹，使用 ${grouped.size} 个收藏夹。`
        )
        this.log(
          `[AI] 分类完成：成功 ${classified} 条，失败 ${failed} 条，创建 ${foldersCreated} 个收藏夹，使用 ${grouped.size} 个收藏夹 =====`
        )
        if (failedItems.length) {
          const detail = publicError(new AppError('WRITE_UNCONFIRMED', failedItems[0]!.reason))
          this.report(accountId, {
            kind: 'task',
            operation: 'aiClassify',
            code: detail.code,
            message: `AI 自动分类完成，但有 ${failedItems.length} 项写入失败。`
          })
        }
        updateProgress({ status: 'completed', phase: '分类完成' })
        return {
          classified,
          failed,
          failedItems,
          foldersCreated,
          foldersUsed: grouped.size,
          unmatched,
          folderCounts: [...grouped.keys()].map((title) => ({
            title,
            count: folderCounts.get(title) ?? 0
          }))
        }
      })
      return result
    } catch (error) {
      const stopped = error instanceof AppError && error.code === 'CANCELLED'
      const detail = publicError(error)
      updateProgress({
        status: stopped ? 'stopped' : 'failed',
        phase: stopped ? '已停止' : `${phase}失败`,
        ...(stopped ? {} : { error: detail.message })
      })
      const diagnostic =
        error instanceof AppError &&
        ['AI_NETWORK_ERROR', 'AI_API_REJECTED', 'AI_AUTH_REJECTED'].includes(error.code)
          ? error.message.match(/(?:诊断代码：([A-Z0-9_]{1,40})|HTTP (\d{3}))/)
          : null
      const diagnosticHint = diagnostic?.[1]
        ? ` 网络原因：${diagnostic[1]}。`
        : diagnostic?.[2]
          ? ` AI 服务 HTTP 状态：${diagnostic[2]}。`
          : ''
      this.report(accountId, {
        kind: 'task',
        operation: 'aiClassify',
        code: detail.code,
        rule: error instanceof AppError ? error.rule : undefined,
        message: `AI 自动分类在“${phase}”阶段失败。${diagnosticHint}`
      })
      throw error
    }
  }

  private async works(accountId: string, source: 'likes' | 'favorites', check: () => void): Promise<Work[]> {
    const items: Work[] = []
    for (let offset = 0; offset < 100000; offset += 120) {
      check()
      const page = await this.db.call('query', {
        accountId,
        source,
        folderId: null,
        search: '',
        mediaType: 'all',
        year: null,
        month: null,
        sort: 'collected',
        offset,
        limit: 120
      })
      items.push(...page.items)
      if (items.length >= page.total || !page.items.length) return items
    }
    return items
  }

  private async remoteFolders(accountId: string, check: () => void): Promise<FavoriteFolder[]> {
    const local = await this.db.call('favoriteFolders', { accountId })
    const localByRemoteId = new Map(local.map((folder) => [folder.remoteId ?? folder.id, folder]))
    const folders = new Map<string, FavoriteFolder>()
    let cursor = '0'
    for (let page = 0; page < 100; page++) {
      check()
      const parsed = parseFavoriteFolders(
        await this.engine.request(accountId, 'folders', { cursor, count: '18' })
      )
      for (const folder of parsed.folders) {
        const known = localByRemoteId.get(folder.id)
        const mapped = {
          ...folder,
          id: known?.id ?? folder.id,
          remoteId: folder.id,
          localOnly: false,
          localCount: known?.localCount ?? 0
        }
        folders.set(mapped.id, mapped)
      }
      if (!parsed.hasMore) {
        for (const folder of local.filter((entry) => entry.localOnly)) folders.set(folder.id, folder)
        return [...folders.values()]
      }
      cursor = parsed.cursor
    }
    throw new AppError('TOO_MANY_FOLDERS', '收藏夹数量过多，未继续自动分类。')
  }

  private thumbnailBlocked = false

  private async refreshThumbnail(accountId: string, work: Work, check: () => void): Promise<Work> {
    if (work.coverUrl || this.thumbnailBlocked) return work
    try {
      check()
      const response = await this.engine.request(accountId, 'detail', { aweme_id: work.id })
      const refreshed = parseWork(response.aweme_detail)
      check()
      if (refreshed.id === work.id && refreshed.coverUrl) return { ...work, coverUrl: refreshed.coverUrl }
      console.warn(`[AI] 缩略图仍缺失：作品 ${work.id}`)
    } catch (error) {
      const detail = publicError(error)
      // Once the platform restricts detail reads, retrying every remaining work
      // only spams failures; keep the existing covers and continue classifying.
      if (['RATE_LIMITED', 'UPSTREAM_RISK_CONTROL', 'API_REJECTED'].includes(detail.code))
        this.thumbnailBlocked = true
      console.warn(`[AI] 缩略图刷新失败：作品 ${work.id} code=${detail.code}`)
    }
    return work
  }

  /**
   * Re-applies saved AI assignments locally without calling the AI again. Used
   * when a previous run was interrupted or its local writes failed.
   */
  async resumeClassification(
    accountId: string,
    source: 'likes' | 'favorites',
    check: () => void,
    options: { createMissingFolders?: boolean } = {}
  ): Promise<AiClassificationResult> {
    const pending = (await this.db.call('aiAssignmentPending', { accountId, source })) as {
      workId: string
      category: string
    }[]
    if (!pending.length) return emptyClassification()
    return this.applyAssignments(accountId, source, pending, check, options)
  }

  /** Recovers a classification from a previous run's `作品 <id> → <收藏夹>` log. */
  async importClassificationLog(
    accountId: string,
    source: 'likes' | 'favorites',
    text: string,
    check: () => void,
    options: { createMissingFolders?: boolean } = {}
  ): Promise<AiClassificationResult> {
    const items = parseClassificationLog(text)
    if (!items.length)
      throw new AppError(
        'AI_RESPONSE_INVALID',
        '没有识别到“作品 … → 收藏夹”记录。请粘贴上次分类日志中包含“写入失败：作品 … → …”的行。'
      )
    await this.db.call('aiAssignmentSave', { accountId, source, items })
    return this.applyAssignments(accountId, source, items, check, options)
  }

  private async applyAssignments(
    accountId: string,
    source: 'likes' | 'favorites',
    items: { workId: string; category: string }[],
    check: () => void,
    options: { createMissingFolders?: boolean }
  ): Promise<AiClassificationResult> {
    // Applying saved assignments is entirely local: it must keep working while
    // the platform is temporarily restricting reads.
    const accounts = (await this.db.call('accounts', undefined)) as Account[]
    const account = accounts.find((entry) => entry.id === accountId)
    if (!account?.remoteId) throw new AppError('AUTH_REQUIRED', '请先登录并核验抖音账号。')
    const preferences = (await this.db.call('appPreferences', {})) as AppPreferences
    const folders = (await this.db.call('favoriteFolders', { accountId })) as FavoriteFolder[]
    const byTitle = new Map(folders.map((folder) => [folder.title, folder]))
    const workIds = [...new Set(items.map((item) => item.workId))]
    const works = new Map(
      ((await this.db.call('worksByIds', { workIds })) as Work[]).map((work) => [work.id, work])
    )
    let classified = 0
    let failed = 0
    let foldersCreated = 0
    const failedItems: { workId: string; category: string; reason: string }[] = []
    const usedFolders = new Set<string>()
    const folderCounts = new Map<string, number>()
    for (const [index, item] of items.entries()) {
      if (index % 50 === 0) check()
      const work = works.get(item.workId)
      if (!work) {
        failed++
        const reason = '作品已不在本地列表中，跳过。'
        failedItems.push({ ...item, reason })
        this.log(`[AI] 写入失败：作品 ${item.workId} → ${item.category}：${reason}`)
        // A work that no longer exists locally cannot be applied by any retry.
        await this.db.call('aiAssignmentComplete', {
          accountId,
          source,
          workId: item.workId,
          category: item.category
        })
        continue
      }
      let folder = byTitle.get(item.category)
      if (!folder) {
        if (options.createMissingFolders === false) {
          failed++
          failedItems.push({ ...item, reason: `收藏夹“${item.category}”不存在。` })
          continue
        }
        folder = (await this.db.call('favoriteLocalFolderCreate', {
          accountId,
          remoteId: account.remoteId,
          id: `local-${randomUUID()}`,
          title: item.category,
          private: true,
          queueWrite: preferences.syncFavoritesToCloud
        })) as FavoriteFolder
        byTitle.set(item.category, folder)
        foldersCreated++
      }
      try {
        await this.db.call('favoriteConfirm', {
          accountId,
          remoteId: account.remoteId,
          work,
          folder,
          favoriteAddIntent: source === 'likes',
          queueWrite: preferences.syncFavoritesToCloud,
          queueFavoriteAdd: source === 'likes' && preferences.syncFavoritesToCloud
        })
        await this.db.call('aiAssignmentComplete', {
          accountId,
          source,
          workId: item.workId,
          category: item.category
        })
        classified++
        usedFolders.add(folder.id)
        folderCounts.set(item.category, (folderCounts.get(item.category) ?? 0) + 1)
      } catch (error) {
        failed++
        const reason = error instanceof Error ? error.message : String(error)
        failedItems.push({ ...item, reason })
        this.log(`[AI] 写入失败：作品 ${item.workId} → ${item.category}：${reason}`)
      }
    }
    this.changed()
    return {
      classified,
      failed,
      failedItems,
      foldersCreated,
      foldersUsed: usedFolders.size,
      unmatched: 0,
      folderCounts: [...folderCounts].map(([title, count]) => ({ title, count }))
    }
  }

  private async classify(
    works: Work[],
    preferences: AppPreferences,
    accountId: string,
    check: () => void,
    targetFolders: FavoriteFolder[],
    pendingAiFolders: string[],
    onProgress: (phase: string, current: number, total: number) => void = () => {},
    offset = 0,
    overallTotal = works.length,
    splitDepth = 0
  ): Promise<Assignment[]> {
    if (works.length > 30) {
      const assignments: Assignment[] = []
      for (let batchOffset = 0; batchOffset < works.length; batchOffset += 30) {
        assignments.push(
          ...(await this.classify(
            works.slice(batchOffset, batchOffset + 30),
            preferences,
            accountId,
            check,
            targetFolders,
            pendingAiFolders,
            onProgress,
            offset + batchOffset,
            overallTotal,
            splitDepth
          ))
        )
      }
      return assignments
    }
    const input: { id: string; title: string; author: string; transcript?: string }[] = []
    const workIdsByReference = new Map<string, string>()
    for (const [index, work] of works.entries()) {
      check()
      const reference = `W${index + 1}`
      workIdsByReference.set(reference, work.id)
      const entry: (typeof input)[number] = { id: reference, title: work.title, author: work.author }
      if (work.title.trim().length < 3 && work.mediaType === 'video') {
        if (!preferences.siliconFlowApiKey) throw missingApiKey('siliconflow')
        entry.transcript = await this.transcribe(accountId, work.id, preferences.siliconFlowApiKey, check)
      }
      input.push(entry)
      onProgress('正在准备作品', offset + input.length, overallTotal)
    }
    onProgress('等待 AI 返回', offset, overallTotal)
    const preferred = lineNames(preferences.favoriteCategoryHints)
    const allowedFolders = [...targetFolders.map((folder) => folder.title), ...pendingAiFolders]
    const folderReferences = allowedFolders.map((title, index) => ({ id: `F${index + 1}`, title }))
    const folderTitlesByReference = new Map(folderReferences.map((folder) => [folder.id, folder.title]))
    const folderTitlesByName = new Map(allowedFolders.map((title) => [title.toLocaleLowerCase(), title]))
    const system =
      '你是谨慎的抖音收藏整理助手。只根据作品标题、作者和提供的作品信息，与收藏夹名称做严格的主题匹配。只输出 JSON，不要输出 Markdown 或解释。'
    const user = JSON.stringify({
      targetFolders: folderReferences,
      preferredCategories: preferred.filter((name) =>
        allowedFolders.some((folder) => folder.toLocaleLowerCase() === name.toLocaleLowerCase())
      ),
      rule: 'works 中每个作品都必须返回一个 assignment。逐条判断作品本身的主题是否明确符合收藏夹名称；只有标题、作者或提供的作品信息有直接且充分的证据时才归类。不能仅因属于相邻领域、同一大类、作者相同或可能相关就归类；信息不足或只是宽泛关联时，categories 必须返回空数组。例：收藏夹名为“游泳”时，羽毛球、篮球、乒乓球、一般健身或其他运动作品都不匹配，除非作品本身明确涉及游泳。不要为了填满收藏夹而降低标准。不同作品应独立判断，不要为了省事把所有作品都放进同一个收藏夹；只有当每条作品都确实符合该收藏夹时，才可全部选择同一个收藏夹。workId 必须原样复制 works[].id 的字符串，categories 必须从 targetFolders[].id 中选择零个或多个值；不要输出收藏夹名称或改写引用。',
      works: input
    })
    try {
      const data = await requestJson('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${preferences.deepseekApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          temperature: 0.1,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            {
              role: 'user',
              content: `${user}\n返回格式：{"assignments":[{"workId":"W1","categories":["F1","F2"]},{"workId":"W2","categories":[]}]}`
            }
          ]
        })
      })
      check()
      const content = data.choices?.[0]?.message?.content
      if (typeof content !== 'string' || !content.trim())
        throw new AppError(
          'AI_RESPONSE_INVALID',
          'DeepSeek 请求已返回，但没有返回可用的分类结果，请稍后重试。'
        )
      const parsedAssignments = parseModelWorkAssignments(content, new Set(workIdsByReference.keys()))
      if (new Set(parsedAssignments.map((assignment) => assignment.workId)).size !== works.length)
        throw new AppError('AI_RESPONSE_INVALID', 'AI 没有为全部作品返回分类结果，请调整分类后重试。')
      const assignments = parsedAssignments.flatMap(({ workId: reference, categories }) => {
        const workId = workIdsByReference.get(reference)
        if (!workId) throw new AppError('AI_RESPONSE_INVALID', 'AI 返回了无法识别的作品引用，请重试。')
        return categories.map((value) => {
          const category =
            folderTitlesByReference.get(value) ?? folderTitlesByName.get(value.toLocaleLowerCase())
          if (!category)
            throw new AppError('AI_RESPONSE_INVALID', 'AI 返回了未选择的收藏夹分类，请调整分类后重试。')
          return { workId, category }
        })
      })
      onProgress('AI 已完成分类', offset + works.length, overallTotal)
      return assignments
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        error.code !== 'AI_RESPONSE_INVALID' ||
        works.length <= 1 ||
        splitDepth >= 3
      )
        throw error
      const midpoint = Math.ceil(works.length / 2)
      onProgress(`AI 返回格式异常，正在拆分 ${works.length} 条批次重试`, offset, overallTotal)
      const first = await this.classify(
        works.slice(0, midpoint),
        preferences,
        accountId,
        check,
        targetFolders,
        pendingAiFolders,
        onProgress,
        offset,
        overallTotal,
        splitDepth + 1
      )
      const second = await this.classify(
        works.slice(midpoint),
        preferences,
        accountId,
        check,
        targetFolders,
        pendingAiFolders,
        onProgress,
        offset + midpoint,
        overallTotal,
        splitDepth + 1
      )
      return [...first, ...second]
    }
  }

  private async transcribe(
    accountId: string,
    workId: string,
    apiKey: string,
    check: () => void
  ): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'mylike-asr-'))
    const input = join(directory, 'source.mp4')
    const audio = join(directory, 'audio.mp3')
    try {
      const media = parseMedia(
        await this.engine.request(accountId, 'detail', {
          aweme_id: workId,
          publish_video_strategy_type: '2',
          pc_client_type: '1'
        })
      )
      const url = media.videos[0]
      if (!url) return ''
      const response = await fetch(url, { headers: { Referer: 'https://www.douyin.com/' } })
      if (!response.ok) return ''
      await writeFile(input, Buffer.from(await response.arrayBuffer()))
      check()
      await new Promise<void>((resolve, reject) => {
        const process = spawn(
          'ffmpeg',
          ['-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', audio],
          {
            windowsHide: true
          }
        )
        let error = ''
        process.stderr.on('data', (chunk) => (error += String(chunk)))
        process.on('error', reject)
        process.on('close', (code) => (code === 0 ? resolve() : reject(new Error(error || 'ffmpeg failed'))))
      })
      const form = new FormData()
      form.append('model', 'FunAudioLLM/SenseVoiceSmall')
      form.append('file', new Blob([await readFile(audio)], { type: 'audio/mpeg' }), 'audio.mp3')
      const result = await requestJson(
        'https://api.siliconflow.cn/v1/audio/transcriptions',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form
        },
        'SiliconFlow'
      )
      return typeof result.text === 'string' ? result.text.slice(0, 4000) : ''
    } catch {
      return ''
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}
