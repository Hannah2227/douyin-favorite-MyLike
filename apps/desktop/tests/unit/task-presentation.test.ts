import { expect, it, vi } from 'vitest'
import { Children, isValidElement, type ReactElement } from 'react'
import { RecoveryButton } from '../../src/renderer/src/TaskRecovery'
import {
  favoriteReadOperation,
  recoveryUntil,
  taskPresentation,
  type PresentableTask
} from '../../src/shared/task-presentation'
import { CommandError, call } from '../../src/renderer/src/api'

const now = 100_000
const task: PresentableTask = { accountId: 'a', status: 'paused', updatedAt: now - 1000 }
const gate = (operation: string, accountId = 'a') => ({
  accountId,
  operation,
  code: 'RATE_LIMITED',
  retryAt: now + 30_000
})
const options = { operations: ['self', 'likes'], now }

it('shows a concrete manual retry action while a matching operation is waiting and after it expires', () => {
  const waiting = taskPresentation(
    { ...task, errorCode: 'RATE_LIMITED' },
    { ...options, recovery: [gate('likes')] }
  )
  expect(waiting).toMatchObject({ action: 'retry', waitingSeconds: 30, canStop: true })
  expect(waiting.actionLabel).toContain('30 秒')
  const elapsed = taskPresentation(
    { ...task, errorCode: 'RATE_LIMITED' },
    { ...options, now: now + 30_000, recovery: [gate('likes')] }
  )
  expect(elapsed).toMatchObject({ action: 'retry', actionLabel: '重试', waitingSeconds: 0 })
  expect(elapsed.message).not.toMatch(/已恢复|自动继续/)
})

it('isolates waits by account and actual operation, including before the first task exists', () => {
  expect(recoveryUntil('a', ['favorites'], [gate('folderItems'), gate('favorites', 'b')])).toBe(0)
  expect(taskPresentation(null, { ...options, accountId: 'a', recovery: [gate('likes')] })).toMatchObject({
    action: 'retry',
    waitingSeconds: 30
  })
  expect(taskPresentation(null, { ...options, accountId: 'b', recovery: [gate('likes')] })).toMatchObject({
    action: null,
    badge: '未开始'
  })
})

it('gives unknown results priority over completed status and ignores write-only waits for read-only checking', () => {
  const result = taskPresentation(
    { ...task, status: 'completed', unknown: 3, errorCode: 'TIMEOUT' },
    {
      operations: ['self', 'detail', 'favoriteRemove'],
      now,
      recovery: [gate('favoriteRemove')]
    }
  )
  expect(result).toMatchObject({
    badge: '待确认',
    action: 'check-result',
    actionLabel: '检查结果',
    waitingSeconds: 0,
    tone: 'attention'
  })
  expect(result.message).not.toContain('已完成')
  expect(taskPresentation({ ...task, unknown: 3 }, { ...options, recovery: [gate('detail')] })).toMatchObject(
    { action: 'check-result', waitingSeconds: 30 }
  )
})

it('keeps successful history successful even when the write endpoint is still waiting', () => {
  expect(
    taskPresentation(
      { ...task, status: 'completed', pending: 0, unknown: 0, failed: 0, errorCode: null },
      {
        operations: ['self', 'unlike'],
        now,
        recovery: [gate('unlike')]
      }
    )
  ).toMatchObject({ badge: '已完成', tone: 'success', action: null, waitingSeconds: 0 })
})

it('does not report partial or failed writes as complete, and prioritizes a needed login over retrying partial work', () => {
  expect(taskPresentation({ ...task, status: 'completed', failed: 2 }, options)).toMatchObject({
    badge: '部分完成',
    action: null,
    tone: 'attention'
  })
  expect(taskPresentation({ ...task, status: 'partial', errorCode: 'PARTIAL_SYNC' }, options)).toMatchObject({
    badge: '部分完成',
    actionLabel: '重试未完成项'
  })
  expect(taskPresentation({ ...task, status: 'partial', errorCode: 'AUTH_REQUIRED' }, options)).toMatchObject(
    { action: 'login', actionLabel: '去登录' }
  )
  expect(
    taskPresentation({ ...task, status: 'paused', errorCode: 'UPSTREAM_CHANGED' }, options)
  ).toMatchObject({ action: 'update', actionLabel: '查看更新' })
})

it('turns an old login error into manual continue only after a successful scoped access check', () => {
  const failed = { ...task, errorCode: 'AUTH_REQUIRED' }
  for (const accessChecks of [
    [],
    [{ accountId: 'b', operation: 'self', at: now }],
    [{ accountId: 'a', operation: 'detail', at: now }],
    [{ accountId: 'a', operation: 'self', at: now - 2000 }]
  ])
    expect(taskPresentation(failed, { ...options, accessChecks }).action).toBe('login')
  expect(
    taskPresentation(failed, { ...options, accessChecks: [{ accountId: 'a', operation: 'self', at: now }] })
  ).toMatchObject({ action: 'retry', actionLabel: '继续' })
})

it('offers manual verification retry after a complete access check, including after restart, without clearing rate or schema errors', () => {
  const verification = { ...task, errorCode: 'VERIFICATION_REQUIRED' }
  const self = [{ accountId: 'a', operation: 'self', at: now }]
  expect(taskPresentation(verification, { ...options, accessChecks: self }).action).toBe('retry')
  expect(
    taskPresentation(verification, {
      // After restart the old failed page request may no longer be available.
      operations: [],
      now,
      accessChecks: self
    }).action
  ).toBe('retry')
  expect(
    taskPresentation(verification, { operations: ['self', 'unlike'], now, accessChecks: self }).action
  ).toBe('retry')
  expect(
    taskPresentation(verification, {
      operations: ['self', 'detail', 'favoriteRemove'],
      now,
      accessChecks: [{ accountId: 'a', operation: 'self', at: now }]
    }).action
  ).toBe('retry')
  expect(
    taskPresentation({ ...task, errorCode: 'UPSTREAM_CHANGED' }, { ...options, accessChecks: self }).action
  ).toBe('update')
  expect(
    taskPresentation(
      { ...task, errorCode: 'RATE_LIMITED' },
      { ...options, recovery: [gate('likes')], accessChecks: self }
    ).waitingSeconds
  ).toBe(30)
})

it('offers login during result checking then returns to read-only checking after confirmation', () => {
  const checking = { ...task, unknown: 2, errorCode: 'TIMEOUT' }
  const checkOptions = { ...options, resultCheckError: { code: 'AUTH_REQUIRED', at: now } }
  expect(taskPresentation(checking, checkOptions)).toMatchObject({ action: 'login', actionLabel: '去登录' })
  expect(
    taskPresentation(checking, {
      ...checkOptions,
      accessChecks: [{ accountId: 'a', operation: 'self', at: now + 1 }]
    })
  ).toMatchObject({ action: 'check-result', actionLabel: '检查结果' })
})

it('uses the actual first read for partial favorites recovery and keeps head updates independent', () => {
  expect(
    favoriteReadOperation({ status: 'partial', stage: 'folder', incomplete: 1, foldersDeferred: 1 })
  ).toBe('favorites')
  expect(
    favoriteReadOperation({ status: 'partial', stage: 'folder', incomplete: 0, foldersDeferred: 1 })
  ).toBe('folderItems')
  expect(favoriteReadOperation({ status: 'paused', stage: 'folders' })).toBe('folders')
  expect(favoriteReadOperation({ status: 'completed', stage: 'folder' })).toBe('favorites')
  expect(
    taskPresentation(task, { operations: ['self', 'favorites'], now, recovery: [gate('folderItems')] })
      .waitingSeconds
  ).toBe(0)
})

it('keeps raw technical evidence separate from ordinary command error text and preserves actionable local validation', async () => {
  const failure = new CommandError('CURSOR_STALLED', '接口游标缺失：max_cursor', now)
  expect(failure.message).not.toMatch(/接口|游标|max_cursor|CURSOR/)
  expect(failure.diagnosticMessage).toBe('接口游标缺失：max_cursor')
  expect(new CommandError('INVALID_INPUT', '名称不能为空').message).toBe('名称不能为空')
  await expect(
    call(
      Promise.resolve({
        ok: false as const,
        error: { code: 'RATE_LIMITED', message: 'HTTP 429', retryAt: now }
      })
    )
  ).rejects.toMatchObject({ code: 'RATE_LIMITED', diagnosticMessage: 'HTTP 429', retryAt: now })
})

it.each(['BROWSER_NOT_READY', 'BROWSER_CRASHED', 'PAGE_CHANGED'])(
  'offers a direct reconnecting retry for %s instead of repeatedly opening a window',
  (errorCode) => {
    const view = taskPresentation({ ...task, errorCode }, options)
    expect(view).toMatchObject({ action: 'retry', actionLabel: '重试' })
    expect(view.message).toContain('应用会重新连接')
    expect(view.message).not.toContain('请重新打开')
  }
)

function recoveryButtons(props: Parameters<typeof RecoveryButton>[0]) {
  const output = RecoveryButton(props)
  if (!output) throw Error('Expected recovery controls')
  return Children.toArray(output.props.children).filter(isValidElement) as ReactElement<{
    children: string
    onClick: () => void
    disabled: boolean
  }>[]
}

it('keeps update as the primary action while allowing an explicit retry of unfinished reads', () => {
  const retry = vi.fn()
  const buttons = recoveryButtons({
    view: taskPresentation({ ...task, errorCode: 'UPSTREAM_CHANGED' }, options),
    retry,
    perform: async (_label, action) => {
      await action()
    }
  })
  expect(buttons.map((button) => button.props.children)).toEqual(['查看更新', '重试'])
  expect(retry).not.toHaveBeenCalled()
  buttons[1]!.props.onClick()
  expect(retry).toHaveBeenCalledOnce()
})

it('offers only the read-only check as the update fallback for an unknown write result', () => {
  const retry = vi.fn(),
    checkResults = vi.fn()
  const view = taskPresentation(
    { ...task, unknown: 1 },
    {
      ...options,
      resultCheckError: { code: 'UPSTREAM_CHANGED', at: now }
    }
  )
  const buttons = recoveryButtons({ view, retry, checkResults, perform: async () => {} })
  expect(buttons.map((button) => button.props.children)).toEqual(['查看更新', '检查结果'])
  buttons[1]!.props.onClick()
  expect(checkResults).toHaveBeenCalledOnce()
  expect(retry).not.toHaveBeenCalled()
  expect(
    recoveryButtons({ view, retry, checkResults, busy: true, perform: async () => {} }).every(
      (button) => button.props.disabled
    )
  ).toBe(true)
})
