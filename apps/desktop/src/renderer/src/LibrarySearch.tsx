import { useState } from 'react'
import { Search, X } from 'lucide-react'

/**
 * 综合搜索：输入框里敲一个关键词回车，它就会被固定成一枚标签。
 * 多个标签之间取并集（同一作品只出现一次），标签直接输入的文字是实时搜索。
 */
export function LibrarySearch({
  change,
  searches,
  add,
  remove,
  clear
}: {
  change: (value: string) => void
  searches: string[]
  add: (term: string) => void
  remove: (term: string) => void
  clear: () => void
}) {
  const [draft, setDraft] = useState('')
  const submit = () => {
    const term = draft.trim()
    if (!term) return
    add(term)
    setDraft('')
  }
  return (
    <div className="search-field combined">
      <Search size={16} />
      {searches.map((term) => (
        <span className="search-chip" key={term} title={term}>
          {term}
          <button type="button" aria-label={`移除关键词 ${term}`} onClick={() => remove(term)}>
            <X size={12} />
          </button>
        </span>
      ))}
      <input
        aria-label="搜索内容"
        type="search"
        value={draft}
        placeholder={
          searches.length
            ? `再加关键词，回车合并（已 ${searches.length} 个）`
            : '搜索标题或作者；回车可加入综合搜索'
        }
        onChange={(event) => {
          setDraft(event.target.value)
          change(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            submit()
          }
        }}
      />
      {(draft || searches.length > 0) && (
        <button
          type="button"
          aria-label="清空搜索"
          onClick={() => {
            setDraft('')
            change('')
            clear()
          }}
        >
          <X size={14} />
        </button>
      )}
    </div>
  )
}
