import { expect, it } from 'vitest'
import { CommandError, call } from '../../src/renderer/src/api'
import { favoriteWriteMessage } from '../../src/renderer/src/favorite-feedback'

it('distinguishes an empty read from an uncertain favorite write without changing the original error evidence', async () => {
  const failure = await call(
    Promise.resolve({
      ok: false as const,
      error: {
        code: 'EMPTY_RESPONSE',
        message: 'signed response details are diagnostic only',
        retryAt: 12345
      }
    })
  ).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(CommandError)
  expect((failure as Error).message).toContain('暂时没有获取到更多内容')
  const message = favoriteWriteMessage(failure, 'save')
  expect(message).toContain('暂时无法确认此次收藏的完整结果')
  expect(message).toContain('重新读取后确认')
  expect(message).toContain('已确认的结果会保留')
  expect(message).not.toMatch(/更多内容|signed response|接口|SDK/)
  expect(failure).toMatchObject({
    code: 'EMPTY_RESPONSE',
    retryAt: 12345,
    diagnosticMessage: 'signed response details are diagnostic only'
  })
})

it('requires checking existing folders before attempting another creation when its result is unknown', () => {
  const message = favoriteWriteMessage(new CommandError('WRITE_UNCONFIRMED', 'raw'), 'create')
  expect(message).toContain('暂时无法确认收藏夹是否已创建')
  expect(message).toContain('重新读取收藏夹')
  expect(message).toContain('避免重复创建')
  expect(message).not.toContain('重试')
})

it('keeps authentication, verification, temporary refusal and explicit refusal distinct from unknown results', () => {
  expect(favoriteWriteMessage(new CommandError('AUTH_REQUIRED', 'raw'), 'save')).toContain(
    '登录正确的抖音账号'
  )
  expect(favoriteWriteMessage(new CommandError('VERIFICATION_REQUIRED', 'raw'), 'save')).toContain('完成验证')
  expect(favoriteWriteMessage(new CommandError('RATE_LIMITED', 'raw'), 'create')).toContain('请稍后重新读取')
  const rejected = favoriteWriteMessage(new CommandError('API_REJECTED', 'raw'), 'save')
  expect(rejected).toContain('抖音未接受这一步操作')
  expect(rejected).not.toContain('结果未确认')
})

it('preserves actionable local validation instead of incorrectly calling an existing folder an unknown creation', () => {
  expect(
    favoriteWriteMessage(new CommandError('FOLDER_EXISTS', '已有同名收藏夹，请直接选择。'), 'create')
  ).toBe('已有同名收藏夹，请直接选择。')
  expect(
    favoriteWriteMessage(new CommandError('EDITOR_EXPIRED', '收藏选择已失效，请重新读取后再保存。'), 'save')
  ).toContain('重新读取')
})

it.each(['TIMEOUT', 'NETWORK_ERROR', 'EMPTY_RESPONSE', 'INVALID_RESPONSE', 'PAGE_CHANGED', 'STORAGE_ERROR'])(
  'handles %s conservatively for a write without borrowing collection-empty wording',
  (code) => {
    expect(favoriteWriteMessage(new CommandError(code, 'raw'), 'save')).toContain(
      '暂时无法确认此次收藏的完整结果'
    )
  }
)
