import type { Account } from '../shared/contracts'
import type { Database } from './storage/client'
import type { DouyinEngine } from './douyin/engine'

export class AccountService {
  constructor(
    private readonly db: Pick<Database, 'call'>,
    private readonly engine: Pick<DouyinEngine, 'logout' | 'purgeAccount'>,
    private readonly exclusive: <T>(action: () => Promise<T>) => Promise<T>,
    private readonly active: (accountId: string) => Promise<Account>,
    private readonly quiesce: () => Promise<void>,
    private readonly changed: () => void
  ) {}
  async rename(accountId: string, name: string): Promise<Account> {
    return this.exclusive(async () => {
      await this.active(accountId)
      const account = await this.db.call('renameAccount', { accountId, name })
      this.changed()
      return account
    })
  }
  async logout(accountId: string): Promise<null> {
    await this.active(accountId)
    await this.quiesce()
    return this.exclusive(async () => {
      await this.active(accountId)
      await this.engine.logout(accountId)
      await this.db.call('clearAccountAuth', { accountId })
      this.changed()
      return null
    })
  }
  async remove(accountId: string): Promise<null> {
    await this.active(accountId)
    await this.quiesce()
    return this.exclusive(async () => {
      await this.active(accountId)
      await this.engine.purgeAccount(accountId)
      await this.db.call('removeAccount', { accountId })
      this.changed()
      return null
    })
  }
}
