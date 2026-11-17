import { Search, X } from 'lucide-react'

/**
 * 综合搜索：用空格分隔多个关键词（例如「学习 高考 数学」）。
 * 只要输入里出现空格就进入综合搜索模式；命中任意关键词的作品都会出现，同一作品只显示一次。
 */
export function LibrarySearch({ value, change }: { value: string; change: (value: string) => void }) {
  const terms = value
    .replace(/[\u3000]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  // 打了空格就算进入综合搜索模式，哪怕第二个词还没敲
  const combined = /[\s\u3000]/.test(value)
  const label = terms.length > 1 ? `综合搜索 · ${terms.length}` : '综合搜索 · 继续输入'
  return (
    <div className={`search-field${combined ? ' combined' : ''}`}>
      <Search size={16} />
      <input
        aria-label="搜索内容"
        type="search"
        value={value}
        placeholder={
          combined
            ? terms.length > 1
              ? `综合搜索中：${terms.join(' + ')}`
              : '综合搜索中：再输入下一个关键词'
            : '搜索标题或作者；用空格分隔多个关键词'
        }
        onChange={(event) => change(event.target.value)}
      />
      {combined && (
        <span className="search-mode" title="空格分隔多个关键词，结果合并去重">
          {label}
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
