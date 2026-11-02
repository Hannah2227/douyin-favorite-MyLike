import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Account, FavoriteFolder, Work } from '../shared/contracts'
import type { AppPreferences } from '../shared/preferences'
import type { Database } from './storage/client'
import type { DouyinEngine } from './douyin/engine'
import {
  parseFavoriteFolder,
  parseFavoriteFolders,
  parseMedia,
  parseWriteResult
} from './douyin/parse'
import { AppError } from './errors'

type Run = <T>(accountId: string, action: (check: () => void) => Promise<T>) => Promise<T>
type Assignment = { workId: string; category: string }

const lineNames = (value: string) =>
  [...new Set(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))].slice(0, 100)

const requestJson = async (url: string, init: RequestInit): Promise<any> => {
  const response = await fetch(url, init)
  const body = await response.text()
  let data: any
  try {
    data = JSON.parse(body)
  } catch {
    throw new AppError('API_REJECTED', `AI 服务返回了无法解析的内容（HTTP ${response.status}）。`)
  }
  if (!response.ok) throw new AppError('API_REJECTED', data?.error?.message || `AI 服务请求失败（HTTP ${response.status}）。`)
  return data
}

export class AiClassifier {
  constructor(
    private readonly db: Pick<Database, 'call'>,
    private readonly engine: Pick<DouyinEngine, 'request'>,
    private readonly run: Run,
    private readonly identity: (accountId: string, check: () => void) => Promise<Account>,
    private readonly changed: () => void
  ) {}

  async testConnection(provider: 'deepseek' | 'siliconflow'): Promise<null> {
    const preferences = (await this.db.call('appPreferences', {})) as AppPreferences
    const apiKey = provider === 'deepseek' ? preferences.deepseekApiKey : preferences.siliconFlowApiKey
    if (!apiKey) throw new AppError('AUTH_REQUIRED', `请先填写${provider === 'deepseek' ? 'DeepSeek' : 'SiliconFlow'} API Key。`)
    const response = await fetch(
      provider === 'deepseek' ? 'https://api.deepseek.com/models' : 'https://api.siliconflow.cn/v1/models',
      { headers: { Authorization: `Bearer ${apiKey}` } }
    )
    if (!response.ok) throw new AppError('API_REJECTED', `${provider === 'deepseek' ? 'DeepSeek' : 'SiliconFlow'} API Key 无效或接口不可用。`)
    return null
  }

  async runClassification(accountId: string): Promise<{
    classified: number
    failed: number
    failedItems: { workId: string; category: string; reason: string }[]
    foldersCreated: number
    foldersUsed: number
  }> {
    return this.run(accountId, async (check) => {
      const preferences = (await this.db.call('appPreferences', {})) as AppPreferences
      if (!preferences.deepseekApiKey) throw new AppError('AUTH_REQUIRED', '请先在设置中填写 DeepSeek API Key。')
      if (!preferences.siliconFlowApiKey)
        throw new AppError('AUTH_REQUIRED', '请先在设置中填写 SiliconFlow API Key。')
      const account = await this.identity(accountId, check)
      if (!account.remoteId) throw new AppError('AUTH_REQUIRED', '请先登录并核验抖音账号。')
      const works = await this.favoriteWorks(accountId, check)
      console.info(`[AI] 收藏分类开始：读取 ${works.length} 条默认收藏。`)
      if (!works.length)
        return { classified: 0, failed: 0, failedItems: [], foldersCreated: 0, foldersUsed: 0 }
      const assignments = await this.classify(works, preferences, accountId, check)
      console.info(`[AI] DeepSeek 返回 ${assignments.length} 条分类结果。`)
      const folders = await this.remoteFolders(accountId, check)
      const folderMap = new Map(folders.map((folder) => [folder.title, folder]))
      let foldersCreated = 0
      const grouped = new Map<string, string[]>()
      for (const assignment of assignments) {
        const preferred = lineNames(preferences.favoriteCategoryHints).find(
          (name) => name.toLocaleLowerCase() === assignment.category.toLocaleLowerCase()
        )
        const suggestedCategory =
          preferred ??
          (lineNames(preferences.favoriteCategoryHints).includes(assignment.category)
            ? assignment.category
            : `AI-${assignment.category.replace(/^AI[-：:]\s*/i, '').trim()}`)
        const existingCategory = [...folderMap.keys()].find(
          (name) =>
            name.toLocaleLowerCase() === suggestedCategory.toLocaleLowerCase() ||
            (!preferences.allowFavoriteFolderCreation &&
              suggestedCategory.replace(/^AI[-：:]\s*/i, '').trim().toLocaleLowerCase() ===
                name.toLocaleLowerCase())
        )
        const category = preferences.allowFavoriteFolderCreation ? suggestedCategory : existingCategory
        if (!category || category === 'AI-') continue
        if (!folderMap.has(category) && preferences.allowFavoriteFolderCreation) {
          const response = await this.engine.request(accountId, 'favoriteFolderCreate', {
            action: '1',
            collects_name: category,
            secret: '0'
          })
          parseWriteResult(response)
          const folder = { ...parseFavoriteFolder(response.collects_info), localCount: 0 }
          folderMap.set(folder.title, folder)
          await this.db.call('favoriteRememberFolder', { accountId, remoteId: account.remoteId, folder })
          foldersCreated++
          console.info(`[AI] 已创建收藏夹：${folder.title}`)
        }
        if (!folderMap.has(category)) {
          console.info(`[AI] 跳过分类：收藏夹不存在且未允许自动创建：${category}`)
          continue
        }
        const ids = grouped.get(category) ?? []
        ids.push(assignment.workId)
        grouped.set(category, ids)
      }
      const details = new Map(
        works
          .filter((work) => assignments.some((assignment) => assignment.workId === work.id))
          .map((work) => [work.id, { type: '2', work }] as const)
      )
      let classified = 0
      let failed = 0
      const failedItems: { workId: string; category: string; reason: string }[] = []
      for (const [category, ids] of grouped) {
        const folder = folderMap.get(category)!
        console.info(`[AI] 正在写入收藏夹：${category}，作品 ${ids.length} 条。`)
        for (const workId of ids) {
          check()
          const detail = details.get(workId)
          if (!detail) continue
          try {
            parseWriteResult(
              await this.engine.request(accountId, 'favoriteFolderAdd', {
                aweme_id: workId,
                item_ids: workId,
                item_type: '2',
                to_collects_id: folder.id,
                collects_name: folder.title,
                update_collects_sort: 'true'
              })
            )
            await this.db.call('favoriteConfirm', {
              accountId,
              remoteId: account.remoteId,
              work: detail.work,
              folder
            })
            classified++
          } catch (error) {
            failed++
            const reason = error instanceof Error ? error.message : String(error)
            failedItems.push({ workId, category, reason })
            console.error(`[AI] 写入失败：作品 ${workId} → ${category}：${reason}`)
          }
        }
      }
      this.changed()
      console.info(`[AI] 分类完成：成功 ${classified} 条，失败 ${failed} 条，创建 ${foldersCreated} 个收藏夹，使用 ${grouped.size} 个收藏夹。`)
      return { classified, failed, failedItems, foldersCreated, foldersUsed: grouped.size }
    })
  }

  private async favoriteWorks(accountId: string, check: () => void): Promise<Work[]> {
    const items: Work[] = []
    for (let offset = 0; offset < 100000; offset += 120) {
      check()
      const page = await this.db.call('query', {
        accountId,
        source: 'favorites',
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
    const folders: FavoriteFolder[] = []
    let cursor = '0'
    for (let page = 0; page < 100; page++) {
      check()
      const parsed = parseFavoriteFolders(await this.engine.request(accountId, 'folders', { cursor, count: '18' }))
      folders.push(...parsed.folders.map((folder) => ({ ...folder, localCount: 0 })))
      if (!parsed.hasMore) return folders
      cursor = parsed.cursor
    }
    throw new AppError('TOO_MANY_FOLDERS', '收藏夹数量过多，未继续自动分类。')
  }

  private async classify(
    works: Work[],
    preferences: AppPreferences,
    accountId: string,
    check: () => void
  ): Promise<Assignment[]> {
    const input: { id: string; title: string; author: string; transcript?: string }[] = []
    for (const work of works) {
      check()
      const entry: (typeof input)[number] = { id: work.id, title: work.title, author: work.author }
      if (work.title.trim().length < 3 && work.mediaType === 'video') {
        entry.transcript = await this.transcribe(accountId, work.id, preferences.siliconFlowApiKey, check)
      }
      input.push(entry)
    }
    const preferred = lineNames(preferences.favoriteCategoryHints)
    const system = '你是抖音收藏整理助手。只输出 JSON，不要输出 Markdown。'
    const user = JSON.stringify({
      preferredCategories: preferred,
      rule: '优先使用 preferredCategories 中的原名；无法匹配时可以创建新分类，但只返回简短中文名称。',
      works: input
    })
    const data = await requestJson('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${preferences.deepseekApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `${user}\n返回格式：{"assignments":[{"workId":"作品ID","category":"分类名"}]}` }
        ]
      })
    })
    check()
    let parsed: any
    try {
      parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}')
    } catch {
      throw new AppError('API_REJECTED', 'DeepSeek 返回的分类结果不是有效 JSON。')
    }
    const ids = new Set(works.map((work) => work.id))
    return Array.isArray(parsed.assignments)
      ? parsed.assignments.filter(
          (entry: any) => ids.has(String(entry.workId)) && typeof entry.category === 'string' && entry.category.trim()
        )
      : []
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
        const process = spawn('ffmpeg', ['-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', audio], {
          windowsHide: true
        })
        let error = ''
        process.stderr.on('data', (chunk) => (error += String(chunk)))
        process.on('error', reject)
        process.on('close', (code) => (code === 0 ? resolve() : reject(new Error(error || 'ffmpeg failed'))))
      })
      const form = new FormData()
      form.append('model', 'FunAudioLLM/SenseVoiceSmall')
      form.append('file', new Blob([await readFile(audio)], { type: 'audio/mpeg' }), 'audio.mp3')
      const result = await requestJson('https://api.siliconflow.cn/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form
      })
      return typeof result.text === 'string' ? result.text.slice(0, 4000) : ''
    } catch {
      return ''
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}
