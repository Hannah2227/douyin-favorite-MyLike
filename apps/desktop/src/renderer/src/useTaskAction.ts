import { useEffect, useRef, useState } from 'react'
import type { PresentableTask } from '../../shared/task-presentation'
import { CommandError, type Perform } from './api'

/** Keeps task failures beside their action instead of duplicating a global alert. */
export function useTaskAction(accountId: string | null, taskId: string | undefined, perform: Perform) {
  const scope = useRef({ accountId, taskId })
  scope.current = { accountId, taskId }
  const sequence = useRef(0)
  const [failure, setFailure] = useState<{
    accountId: string
    taskId?: string
    error: CommandError
    at: number
  } | null>(null)
  useEffect(() => setFailure(null), [accountId, taskId])
  const current = failure?.accountId === accountId && failure?.taskId === taskId ? failure.error : null
  const run = (label: string, action: () => Promise<unknown>) =>
    void perform(label, async () => {
      const owner = accountId,
        target = taskId,
        token = ++sequence.current
      setFailure(null)
      try {
        await action()
      } catch (error) {
        if (
          owner &&
          scope.current.accountId === owner &&
          scope.current.taskId === target &&
          sequence.current === token
        )
          setFailure({
            accountId: owner,
            taskId: target,
            at: Date.now(),
            error:
              error instanceof CommandError ? error : new CommandError('INTERNAL_ERROR', '任务操作未能完成。')
          })
      }
    })
  const present = (task: PresentableTask | null | undefined): PresentableTask | null | undefined =>
    current && accountId
      ? { ...task, accountId, status: 'paused', errorCode: current.code, updatedAt: failure?.at }
      : task
  return { run, present, failure: current }
}
