import { Search, X } from 'lucide-react'

export function LibrarySearch({ value, change }: { value: string; change: (value: string) => void }) {
  return (
    <div className="search-field">
      <Search size={16} />
      <input
        aria-label="搜索内容"
        type="search"
        value={value}
        placeholder="搜索标题或作者"
        onChange={(event) => change(event.target.value)}
      />
      {value && (
        <button aria-label="清空搜索" onClick={() => change('')}>
          <X size={14} />
        </button>
      )}
    </div>
  )
}
