import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { Command } from '../../src/shared/contracts'
import { testTimeout } from '../helpers/test-timeout'

// Deliberately opt in with an actual released executable, rather than silently
// substituting current sources for the historical application in CI.
test('opens the same library in released v2.0.2 and the new package, preserving writes and the v7 format', async () => {
  test.skip(
    !process.env.MYLIKE_LEGACY_EXECUTABLE || !process.env.MYLIKE_EXECUTABLE,
    'Supply both actual Windows packages to test a version handoff'
  )
  test.setTimeout(testTimeout(120000))
  const profile = mkdtempSync(join(tmpdir(), 'mylike-version-ui-'))
  let app: ElectronApplication | undefined, page: Page
  const launch = async (executablePath: string) => {
    app = await electron.launch({
      executablePath,
      args: [],
      env: { ...process.env, MYLIKE_HEADLESS: '1', MYLIKE_USER_DATA: profile },
      timeout: testTimeout(30000)
    })
    page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: '喜欢的内容', exact: true })).toBeVisible()
  }
  const invoke = async (command: Command, input: any = {}) =>
    page.evaluate(({ command, input }) => window.mylike.invoke(command, input), {
      command,
      input
    }) as Promise<any>
  try {
    await launch(process.env.MYLIKE_LEGACY_EXECUTABLE!)
    expect((await invoke('createAccount', { name: '兼容账号' })).ok).toBe(true)
    const accountId = (await invoke('snapshot')).data.activeAccountId
    await app!.evaluate(({ app }, accountId) => {
      const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
      const { join } = process.getBuiltinModule('node:path') as typeof import('node:path')
      const db = new DatabaseSync(join(app.getPath('userData'), 'mylike.sqlite'))
      try {
        db.exec('PRAGMA foreign_keys=ON;BEGIN IMMEDIATE')
        for (const id of ['7381234567890123456', '7381234567890123457']) {
          db.prepare('INSERT INTO works VALUES(?,?,?,?,?,?,?)').run(
            id,
            `兼容作品 ${id.slice(-1)}`,
            '测试作者',
            1700000000,
            null,
            'video',
            0
          )
          db.prepare('INSERT INTO account_items VALUES(?,?,?,?)').run(accountId, id, Date.now(), 1)
          db.prepare('INSERT INTO saved_items VALUES(?,?,?)').run(accountId, id, Date.now())
        }
        db.prepare('INSERT INTO saved_folders VALUES(?,?,?,?,?)').run(
          accountId,
          '8',
          '兼容收藏夹',
          2,
          'manual'
        )
        for (const id of ['7381234567890123456', '7381234567890123457'])
          db.prepare('INSERT INTO saved_members VALUES(?,?,?,?)').run(accountId, '8', id, 'manual')
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      } finally {
        db.close()
      }
    }, accountId)
    await app!.close()
    app = undefined
    await launch(process.env.MYLIKE_EXECUTABLE!)
    await expect(page!.locator('.list-caption')).toContainText('2 条内容')
    await page!.getByRole('button', { name: '收藏的内容', exact: true }).click()
    await expect(page!.locator('.list-caption')).toContainText('2 条内容')
    expect((await invoke('renameAccount', { accountId, name: '新版改名' })).ok).toBe(true)
    await app!.close()
    app = undefined
    await launch(process.env.MYLIKE_LEGACY_EXECUTABLE!)
    expect((await invoke('snapshot')).data.accounts.find((a: any) => a.id === accountId).name).toBe(
      '新版改名'
    )
    await expect(page!.locator('.list-caption')).toContainText('2 条内容')
    await page!.getByRole('button', { name: '收藏的内容', exact: true }).click()
    await expect(page!.locator('.list-caption')).toContainText('2 条内容')
    expect((await invoke('renameAccount', { accountId, name: '旧版改名' })).ok).toBe(true)
    await app!.close()
    app = undefined
    await launch(process.env.MYLIKE_EXECUTABLE!)
    expect((await invoke('snapshot')).data.accounts.find((a: any) => a.id === accountId).name).toBe(
      '旧版改名'
    )
    await expect(page!.locator('.list-caption')).toContainText('2 条内容')
    const version = await app!.evaluate(({ app }) => {
      const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
      const { join } = process.getBuiltinModule('node:path') as typeof import('node:path')
      const db = new DatabaseSync(join(app.getPath('userData'), 'mylike.sqlite'), { readOnly: true })
      try {
        return {
          version: db.prepare('PRAGMA user_version').get()?.user_version,
          errors: db.prepare('PRAGMA foreign_key_check').all()
        }
      } finally {
        db.close()
      }
    })
    expect(version).toEqual({ version: 7, errors: [] })
  } finally {
    if (app) await app.close()
    if (
      dirname(resolve(profile)) !== resolve(tmpdir()) ||
      !basename(profile).startsWith('mylike-version-ui-')
    )
      throw Error('Unsafe cleanup')
    rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})
