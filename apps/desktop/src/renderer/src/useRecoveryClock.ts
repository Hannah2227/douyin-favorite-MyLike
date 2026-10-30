import { useEffect, useState } from 'react'
import type { RecoveryState } from '../../shared/recovery-state'

export function useRecoveryClock(recovery: readonly RecoveryState[] = []) {
  const [now, setNow] = useState(Date.now)
  const waiting = recovery.some((item) => item.retryAt > now)
  useEffect(() => {
    setNow(Date.now())
    if (!waiting) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [waiting])
  return now
}
