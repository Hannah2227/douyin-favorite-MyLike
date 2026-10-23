import { _electron as electron, test, expect, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

test('settles an inflight write even when optional window preferences are corrupt', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'mylike-shutdown-settings-'))
  let app: ElectronApplication | undefined
  const launch = async () => {
    app = await electron.launch({
      ...(process.env.MYLIKE_EXECUTABLE
        ? { executablePath: process.env.MYLIKE_EXECUTABLE, args: [] }
        : { args: [process.cwd()] }),
      env: { ...process.env, MYLIKE_HEADLESS: '1', MYLIKE_USER_DATA: profile }
    })
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: '喜欢的内容', exact: true })).toBeVisible()
    return page
  }
  try {
    let page = await launch()
    const account = await page.evaluate(() => window.mylike.invoke('createAccount', { name: '退出恢复测试' }))
    expect(account.ok).toBe(true)
    if (!account.ok) throw Error('Fixture account failed')
    const accountId = account.data.id
    await app!.evaluate(async ({ session }, accountId) => {
      const globals = globalThis as any
      globals.__writes = 0
      await session.fromPartition(`persist:mylike-${accountId}`).protocol.handle('https', async (request) => {
        const url = new URL(request.url)
        if (url.pathname === '/user/self')
          return new Response('<html>Controlled fixture</html>', { headers: { 'content-type': 'text/html' } })
        if (url.pathname.includes('/profile/self/'))
          return Response.json({
            status_code: 0,
            user: { sec_uid: 'fixture_shutdown_identity', nickname: '受控用户' }
          })
        if (url.pathname.includes('/aweme/favorite/'))
          return Response.json({
            status_code: 0,
            aweme_list: ['1', '2'].map((id) => ({
              aweme_id: id,
              desc: `受控作品 ${id}`,
              create_time: 1700000000,
              author: { nickname: '作者' }
            })),
            max_cursor: '0',
            has_more: 0
          })
        if (url.pathname.includes('/commit/item/digg/')) {
          globals.__writes++
          await new Promise<void>((resolve) => {
            globals.__release = resolve
          })
          return Response.json({ status_code: 0 })
        }
        return new Response('', { status: 404 })
      })
    }, accountId)
    expect(
      (
        await page.evaluate(
          (accountId) => window.mylike.invoke('collectPage', { accountId, continue: false }),
          accountId
        )
      ).ok
    ).toBe(true)
    expect(
      (
        await page.evaluate(
          (accountId) =>
            window.mylike.invoke('unlikeStart', { accountId, mode: 'batch', workIds: ['1', '2'] }),
          accountId
        )
      ).ok
    ).toBe(true)
    await expect.poll(() => app!.evaluate(() => (globalThis as any).__writes)).toBe(1)
    const corrupt = new DatabaseSync(join(profile, 'mylike.sqlite'))
    try {
      corrupt
        .prepare(
          "INSERT INTO settings VALUES('application',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
        )
        .run('broken-json')
    } finally {
      corrupt.close()
    }
    await app!.evaluate(() => {
      setTimeout(() => (globalThis as any).__release(), 1200)
    })
    await app!.close()
    app = undefined
    const db = new DatabaseSync(join(profile, 'mylike.sqlite'))
    try {
      expect(db.prepare('SELECT status FROM unlike_items ORDER BY position').all()).toEqual([
        { status: 'success' },
        { status: 'pending' }
      ])
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0)
      expect(db.prepare("SELECT value FROM settings WHERE key='application'").get()?.value).toBe(
        'broken-json'
      )
      db.prepare("UPDATE settings SET value='{}' WHERE key='application'").run()
    } finally {
      db.close()
    }
    page = await launch()
    const snapshot = await page.evaluate(() => window.mylike.invoke('snapshot', {}))
    expect(snapshot).toMatchObject({
      ok: true,
      data: {
        unlike: { status: 'stopped', success: 1, pending: 1, unknown: 0 },
        engine: { status: 'stopped' }
      }
    })
  } finally {
    await app?.close().catch(() => {})
    if (
      dirname(resolve(profile)) !== resolve(tmpdir()) ||
      !basename(profile).startsWith('mylike-shutdown-settings-')
    )
      throw Error('Unsafe profile cleanup')
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
