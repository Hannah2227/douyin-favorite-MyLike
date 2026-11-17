import { Search, X } from 'lucide-react'

/**
 * 综合搜索：输入框里用空格分隔多个关键词（例如「学习 高考 数学」），
 * 命中任意一个关键词的作品都会出现，且同一作品只显示一次。
 */
export function LibrarySearch({ value, change }: { value: string; change: (value: string) => void }) {
  const terms = value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const combined = terms.length > 1
  return (
    <div className={`search-field${combined ? ' combined' : ''}`}>
      <Search size={16} />
      <input
        aria-label="搜索内容"
        type="search"
        value={value}
        placeholder={combined ? '综合搜索中：空格分隔多个关键词' : '搜索标题或作者；用空格分隔多个关键词'}
        onChange={(event) => change(event.target.value)}
      />
      {combined && (
        <span className="search-mode" title={`综合搜索 ${terms.length} 个关键词，结果合并去重`}>
          综合搜索 · {terms.length}
        </span>
      )}
      {value && (
        <button aria-label="清空搜索" onClick={() => change('')}>
          <X size={14} />
        </button>
      )}
    </div>
  )
}
