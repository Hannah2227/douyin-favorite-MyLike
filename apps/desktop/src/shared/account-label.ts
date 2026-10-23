import type { Account } from './contracts'

export const accountLabel = (account: Pick<Account, 'name' | 'nickname'>): string =>
  `${account.name}(${account.nickname || '未核验'})`
