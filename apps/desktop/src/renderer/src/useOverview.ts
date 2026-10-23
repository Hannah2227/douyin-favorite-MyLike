import { useEffect, useState } from 'react'
import type { LibraryOverview } from '../../shared/contracts'
import { call } from './api'

/** Aggregates belong to an account, independently of the library's current filters. */
export function useOverview(accountId: string | null, revision: number, visible: boolean) {
  const [result, setResult] = useState<{ accountId: string; data?: LibraryOverview; error?: string } | null>(
    null
  )
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!accountId || !visible) return
    let current = true
    void call(window.mylike.invoke('libraryOverview', { accountId })).then(
      (data) => {
        if (current) setResult({ accountId, data })
      },
      (error) => {
        if (current) setResult({ accountId, error: error.message })
      }
    )
    return () => {
      current = false
    }
  }, [accountId, revision, visible, retry])
  const scoped = result?.accountId === accountId ? result : null
  return {
    data: scoped?.data ?? null,
    error: scoped?.error ?? '',
    retry: () => setRetry((value) => value + 1)
  }
}
