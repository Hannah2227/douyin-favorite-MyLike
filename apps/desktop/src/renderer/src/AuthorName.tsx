type Props = {
  author: string
  authorId: string | null
  workId: string
  accountId: string | null
  openAuthor: (authorId: string | null, author: string, workId: string, accountId: string | null) => void
  copyAuthor: (author: string) => void
  className?: string
}

export function AuthorName({
  author,
  authorId,
  workId,
  accountId,
  openAuthor,
  copyAuthor,
  className
}: Props) {
  const classes = ['author-name-action', className].filter(Boolean).join(' ')
  if (!author) return <span className={className}>@未知作者</span>
  return (
    <span
      className={classes}
      role="button"
      tabIndex={0}
      aria-label={`作者 ${author}；按回车打开主页，右键复制名称`}
      title="左键打开作者主页；右键复制作者名称"
      onClick={(event) => {
        event.stopPropagation()
        openAuthor(authorId, author, workId, accountId)
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        copyAuthor(author)
      }}
      onKeyDown={(event) => {
        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
          event.preventDefault()
          event.stopPropagation()
          copyAuthor(author)
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          event.stopPropagation()
          openAuthor(authorId, author, workId, accountId)
        }
      }}
    >
      @{author}
    </span>
  )
}
