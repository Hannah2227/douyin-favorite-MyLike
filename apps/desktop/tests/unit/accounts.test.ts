import { expect, it } from 'vitest'
import { AccountService } from '../../src/main/accounts'
import type { Account } from '../../src/shared/contracts'
import type { Database } from '../../src/main/storage/client'

const owner: Account = {
  id: 'a',
  name: 'A',
  remoteId: 'remote-a',
  nickname: 'A',
  avatarUrl: null,
  createdAt: 1,
  lastVerifiedAt: 2
}
it('does not report success if backup redaction or removal fails', async () => {
  const calls: string[] = []
  const db = {
    call: async (method: string) => {
      calls.push(method)
      if (method === 'removeAccount') throw new Error('fixture full disk')
      return null
    }
  } as unknown as Database
  const service = new AccountService(
    db,
    {
      logout: async () => {},
      purgeAccount: async () => {
        calls.push('logout')
      }
    },
    async (action) => action(),
    async () => owner,
    async () => {
      calls.push('quiesce')
    },
    () => {}
  )
  await expect(service.remove('a')).rejects.toThrow(/full disk/)
  expect(calls).toEqual(['quiesce', 'logout', 'removeAccount'])
})
it('retains account records if session and cache clearing fails', async () => {
  const calls: string[] = []
  const db = {
    call: async (method: string) => {
      calls.push(method)
      return null
    }
  } as unknown as Database
  const service = new AccountService(
    db,
    {
      logout: async () => {},
      purgeAccount: async () => {
        calls.push('logout')
        throw new Error('fixture session locked')
      }
    },
    async (action) => action(),
    async () => owner,
    async () => {},
    () => {}
  )
  await expect(service.remove('a')).rejects.toThrow(/session locked/)
  expect(calls).toEqual(['logout'])
})
