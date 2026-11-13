import { useEffect, useRef, useState } from 'react'
import type { FavoriteFolder } from '../../shared/contracts'
import { call, type Perform } from './api'
import { ConfirmDialog } from './ConfirmDialog'
import './ai-classify-dialog.css'

export type AiClassificationSource = 'likes' | 'favorites'

export function AiClassifyDialog({
  accountId,
  source,
  folders,
  busy,
  perform,
  close,
  onStart,
  notice,
  aiPending
}: {
  accountId: string | null
  source: AiClassificationSource | null
  folders: FavoriteFolder[]
  busy: boolean
  perform: Perform
  close: () => void
  onStart: () => void
  notice?: (message: string) => void
  aiPending?: { likes: number; favorites: number }
}) {
  const [folderIds, setFolderIds] = useState<string[]>([])
  const [createAiFolders, setCreateAiFolders] = useState(false)
  const [folderNamesInput, setFolderNamesInput] = useState('')
  const [suggestingNames, setSuggestingNames] = useState(false)
  const [namesGenerated, setNamesGenerated] = useState(false)
  const [namesError, setNamesError] = useState('')
  const [userFoldersExpanded, setUserFoldersExpanded] = useState(true)
  const [aiFoldersExpanded, setAiFoldersExpanded] = useState(false)
  const [recoveryExpanded, setRecoveryExpanded] = useState(false)
  const [logText, setLogText] = useState('')
  const [createMissingFolders, setCreateMissingFolders] = useState(true)
  const [onlyUnclassified, setOnlyUnclassified] = useState(false)
  const logFileInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!source) return
    setFolderIds([])
    setCreateAiFolders(false)
    setFolderNamesInput('')
    setSuggestingNames(false)
    setNamesGenerated(false)
    setNamesError('')
    setUserFoldersExpanded(true)
    setAiFoldersExpanded(false)
    setRecoveryExpanded(false)
    setLogText('')
    setOnlyUnclassified(false)
  }, [source])

  const enteredNames = folderNamesInput
    .split(/[,，]/)
    .map((name) => name.trim())
    .filter(Boolean)
  const aiFolderNames = [
    ...new Set(
      enteredNames.map((name) =>
        /^AI[-：:]\s*/i.test(name) ? name.replace(/^AI[-：:]\s*/i, 'AI-').trim() : `AI-${name}`
      )
    )
  ]
  const invalidNames = aiFolderNames.filter((name) => name.length > 30)
  const canStart =
    !suggestingNames &&
    (!createAiFolders || !invalidNames.length) &&
    (folderIds.length > 0 || (createAiFolders && aiFolderNames.length > 0))
  const userFolders = folders.filter((folder) => !folder.title.startsWith('AI-'))
  const aiFolders = folders.filter((folder) => folder.title.startsWith('AI-'))
  const toggleFolderSelection = (ids: readonly string[]) => {
    const allSelected = ids.length > 0 && ids.every((id) => folderIds.includes(id))
    setFolderIds((selected) =>
      allSelected ? selected.filter((id) => !ids.includes(id)) : [...new Set([...selected, ...ids])]
    )
  }
  const generateFolderNames = async () => {
    if (!accountId || !source) return
    setSuggestingNames(true)
    setNamesError('')
    try {
      const result = await call(window.mylike.invoke('aiSuggestFolders', { accountId, source }))
      setFolderNamesInput(result.folderNames.join(', '))
      setNamesGenerated(true)
    } catch (error) {
      setNamesError(error instanceof Error ? error.message : 'AI 收藏夹名称生成失败。')
    } finally {
      setSuggestingNames(false)
    }
  }
  const toggleCreateAiFolders = (checked: boolean) => {
    setCreateAiFolders(checked)
    setNamesError('')
    if (checked && !namesGenerated && !suggestingNames) void generateFolderNames()
  }
  const beginClassification = () => {
    if (!accountId || !source) return
    const operation = source === 'likes' ? '添加喜欢到收藏夹' : '收藏分类'
    close()
    onStart()
    void perform(operation, async () => {
      const result = await call(
        window.mylike.invoke('aiClassifyFavorites', {
          accountId,
          source,
          folderIds,
          createAiFolders,
          aiFolderNames: createAiFolders ? aiFolderNames : [],
          onlyUnclassified
        })
      )
      const shown = result.failedItems.slice(0, 5)
      notice?.(
        [
          `${source === 'likes' ? '添加喜欢' : '收藏分类'}完成：已记录 ${result.classified} 条，未匹配 ${result.unmatched} 条（未写入），失败 ${result.failed} 条；各收藏夹：${result.folderCounts.map(({ title, count }) => `${title} ${count} 条`).join('、') || '无'}；创建 ${result.foldersCreated} 个收藏夹，使用 ${result.foldersUsed} 个收藏夹。结果已写入本机；如需同步到抖音，请在收藏夹页点击“写回云端”。`,
          ...shown.map((item) => `失败作品 ${item.workId}（${item.category}）：${item.reason}`),
          result.failedItems.length > shown.length
            ? `…另有 ${result.failedItems.length - shown.length} 条失败，可在日志或诊断详情中查看。`
            : ''
        ]
          .filter(Boolean)
          .join('\n')
      )
    })
  }

  const pendingCount = source && aiPending ? aiPending[source] : 0
  const loadLogFile = async (file: File | null | undefined) => {
    if (!file) return
    try {
      setLogText(await file.text())
    } catch {
      notice?.('读取日志文件失败，请确认文件可读。')
    }
  }
  const openLogsFolder = () => {
    void call(window.mylike.invoke('openDataFolder', { target: 'logs' })).catch(() =>
      notice?.('无法打开日志文件夹，请稍后重试。')
    )
  }
  const summarizeApplied = (result: { classified: number; failed: number; foldersUsed: number }) =>
    `已应用 ${result.classified} 条分类结果${result.failed ? `，失败 ${result.failed} 条` : ''}，涉及 ${result.foldersUsed} 个收藏夹。结果已写入本机；如需同步到抖音，请在收藏夹页点击“写回云端”。`
  const applySaved = () => {
    if (!accountId || !source) return
    void perform('应用上次分类结果', async () => {
      const result = await call(
        window.mylike.invoke('aiResumeClassification', {
          accountId,
          source,
          createMissingFolders
        })
      )
      notice?.(summarizeApplied(result))
    })
  }
  const importLog = () => {
    if (!accountId || !source || !logText.trim()) return
    void perform('导入上次分类日志', async () => {
      const result = await call(
        window.mylike.invoke('aiImportClassificationLog', {
          accountId,
          source,
          text: logText,
          createMissingFolders
        })
      )
      notice?.(summarizeApplied(result))
      setLogText('')
    })
  }

  if (!source) return null

  return (
    <ConfirmDialog
      title={source === 'likes' ? '添加喜欢到收藏夹' : '收藏分类'}
      busy={busy || suggestingNames}
      danger={false}
      dialogClassName="ai-classify-dialog"
      stickyActions
      confirmLabel={source === 'likes' ? '添加到收藏夹' : '开始收藏分类'}
      confirmDisabled={!canStart}
      cancel={close}
      confirm={beginClassification}
    >
      <p>
        {source === 'likes'
          ? 'AI 将分析喜欢的作品，并添加到选中的收藏夹；作品可同时归入多个收藏夹。'
          : 'AI 将分析已收藏的作品，并添加到选中的收藏夹；作品可同时归入多个收藏夹。'}
      </p>
      <details
        className="ai-folder-group"
        open={userFoldersExpanded}
        onToggle={(event) => setUserFoldersExpanded(event.currentTarget.open)}
      >
        <summary>
          <span>我的收藏夹</span>
          <small>{userFolders.length}</small>
        </summary>
        <button
          type="button"
          className="ai-folder-select-all"
          disabled={busy || suggestingNames || !userFolders.length}
          onClick={() => toggleFolderSelection(userFolders.map((folder) => folder.id))}
        >
          {userFolders.length > 0 && userFolders.every((folder) => folderIds.includes(folder.id))
            ? '取消全选'
            : '全选'}
        </button>
        <div className="ai-classify-options" aria-label="我的收藏夹">
          {userFolders.length ? (
            userFolders.map((folder) => (
              <label key={folder.id} className="ai-classify-option">
                <input
                  type="checkbox"
                  checked={folderIds.includes(folder.id)}
                  disabled={busy || suggestingNames}
                  onChange={(event) =>
                    setFolderIds((ids) =>
                      event.target.checked ? [...ids, folder.id] : ids.filter((id) => id !== folder.id)
                    )
                  }
                />
                <span title={folder.title}>{folder.title}</span>
                <small>{folder.localCount}</small>
              </label>
            ))
          ) : (
            <p className="ai-folder-empty">暂无自建收藏夹</p>
          )}
        </div>
      </details>
      <details
        className="ai-folder-group ai-folder-group-generated"
        open={aiFoldersExpanded}
        onToggle={(event) => setAiFoldersExpanded(event.currentTarget.open)}
      >
        <summary>
          <span>AI 收藏夹</span>
          <small>{aiFolders.length}</small>
        </summary>
        <button
          type="button"
          className="ai-folder-select-all"
          disabled={busy || suggestingNames || !aiFolders.length}
          onClick={() => toggleFolderSelection(aiFolders.map((folder) => folder.id))}
        >
          {aiFolders.length > 0 && aiFolders.every((folder) => folderIds.includes(folder.id))
            ? '取消全选'
            : '全选'}
        </button>
        <div className="ai-classify-options" aria-label="AI 创建的收藏夹">
          {aiFolders.length ? (
            aiFolders.map((folder) => (
              <label key={folder.id} className="ai-classify-option">
                <input
                  type="checkbox"
                  checked={folderIds.includes(folder.id)}
                  disabled={busy || suggestingNames}
                  onChange={(event) =>
                    setFolderIds((ids) =>
                      event.target.checked ? [...ids, folder.id] : ids.filter((id) => id !== folder.id)
                    )
                  }
                />
                <span title={folder.title}>{folder.title}</span>
                <small>{folder.localCount}</small>
              </label>
            ))
          ) : (
            <p className="ai-folder-empty">尚未创建 AI 收藏夹</p>
          )}
        </div>
      </details>
      <label className="ai-classify-option ai-create-option">
        <input
          type="checkbox"
          checked={createAiFolders}
          disabled={busy || suggestingNames}
          onChange={(event) => toggleCreateAiFolders(event.target.checked)}
        />
        <span>{suggestingNames ? 'AI 正在生成收藏夹名称…' : '允许创建 AI 收藏夹'}</span>
      </label>
      {createAiFolders && (
        <label className="ai-name-prefix">
          AI 建议的收藏夹名称（逗号分隔，可自行修改）
          <input
            value={folderNamesInput}
            maxLength={600}
            placeholder="例如：旅行, 美食, 灵感"
            aria-label="AI 要创建的收藏夹名称"
            disabled={busy || suggestingNames}
            onChange={(event) => setFolderNamesInput(event.target.value)}
          />
          <button
            type="button"
            className="ai-name-regenerate"
            disabled={busy || suggestingNames}
            onClick={() => void generateFolderNames()}
          >
            重新生成名称
          </button>
          <small>仅在勾选创建并确认后处理；未输入 AI- 前缀时会自动补上，已存在的同名收藏夹会复用。</small>
        </label>
      )}
      <label className="ai-classify-option ai-create-option">
        <input
          type="checkbox"
          checked={onlyUnclassified}
          disabled={busy || suggestingNames}
          onChange={(event) => setOnlyUnclassified(event.target.checked)}
        />
        <span>只分析尚未归入任何收藏夹的作品（减少重新扫描时间）</span>
      </label>
      <details
        className="ai-folder-group"
        open={recoveryExpanded}
        onToggle={(event) => setRecoveryExpanded(event.currentTarget.open)}
      >
        <summary>
          <span>恢复上次分类</span>
          <small>{pendingCount}</small>
        </summary>
        {pendingCount > 0 && (
          <button
            type="button"
            className="ai-folder-select-all"
            disabled={busy || suggestingNames}
            onClick={applySaved}
          >
            应用上次未完成结果（{pendingCount} 条，不调用 AI）
          </button>
        )}
        <p className="ai-folder-empty">
          写入失败会自动记录到
          logs/ai-classification.log。可以把该文件拖到下方，或选择文件后点“从日志导入并应用”；不会重新调用
          AI。
        </p>
        <div className="ai-log-actions">
          <input
            ref={logFileInput}
            hidden
            type="file"
            accept=".log,.txt,text/plain"
            onChange={(event) => {
              void loadLogFile(event.target.files?.[0])
              event.target.value = ''
            }}
          />
          <button
            type="button"
            className="ai-name-regenerate"
            disabled={busy || suggestingNames}
            onClick={() => logFileInput.current?.click()}
          >
            选择日志文件
          </button>
          <button
            type="button"
            className="ai-name-regenerate"
            disabled={busy || suggestingNames}
            onClick={openLogsFolder}
          >
            打开日志文件夹
          </button>
        </div>
        <textarea
          className="ai-log-import"
          aria-label="上次 AI 分类日志"
          placeholder="[AI] 写入失败：作品 7606700962149989105 → 舞蹈：…"
          value={logText}
          disabled={busy || suggestingNames}
          onChange={(event) => setLogText(event.target.value)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault()
            void loadLogFile(event.dataTransfer.files?.[0])
          }}
        />
        <label className="ai-classify-option">
          <input
            type="checkbox"
            checked={createMissingFolders}
            disabled={busy || suggestingNames}
            onChange={(event) => setCreateMissingFolders(event.target.checked)}
          />
          <span>缺少的收藏夹自动在本机创建</span>
        </label>
        <button
          type="button"
          className="ai-name-regenerate"
          disabled={busy || suggestingNames || !logText.trim()}
          onClick={importLog}
        >
          从日志导入并应用
        </button>
      </details>
      {namesError && (
        <p className="task-error" role="alert">
          {namesError}
        </p>
      )}
      {createAiFolders && invalidNames.length > 0 && (
        <p className="task-error" role="alert">
          AI 收藏夹名称最多 30 个字符：{invalidNames.join('、')}
        </p>
      )}
      {!canStart && (
        <p className="task-error" role="alert">
          请至少选择一个已有收藏夹，或勾选创建并输入收藏夹名称。
        </p>
      )}
    </ConfirmDialog>
  )
}
