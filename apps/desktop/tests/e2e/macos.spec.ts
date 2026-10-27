import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testTimeout } from '../helpers/test-timeout'

test('macOS hides and restores the same window, then quits with account data intact', async () => {
  test.skip(process.platform !== 'darwin', 'macOS lifecycle and native menu')
  test.setTimeout(testTimeout(60_000))
  const profile = mkdtempSync(join(tmpdir(), 'mylike-macos-'))
  let application: ElectronApplication | undefined
  const launch = async () => {
    application = await electron.launch({
      ...(process.env.MYLIKE_EXECUTABLE
        ? { executablePath: process.env.MYLIKE_EXECUTABLE, args: [] }
        : { args: [process.cwd()] }),
      env: { ...process.env, MYLIKE_HEADLESS: '1', MYLIKE_USER_DATA: profile },
      timeout: testTimeout(30_000)
    })
    const page = await application.firstWindow()
    await expect(page.getByRole('heading', { name: '喜欢的内容', exact: true })).toBeVisible()
    return page
  }
  try {
    let page = await launch()
    const created = await page.evaluate(() => window.mylike.invoke('createAccount', { name: 'Mac 本地测试' }))
    expect(created.ok).toBe(true)
    if (!created.ok) throw Error('Fixture account failed')
    const initial = await application!.evaluate(({ BrowserWindow, Menu }) => {
      const win = BrowserWindow.getAllWindows()[0]!
      return {
        id: win.id,
        menuRoles: Menu.getApplicationMenu()!.items.map((item) => item.role),
        showAccelerator: Menu.getApplicationMenu()!.getMenuItemById('show-main-window')!.accelerator
      }
    })
    expect(initial.menuRoles).toEqual(expect.arrayContaining(['appmenu', 'editmenu', 'windowmenu']))
    expect(initial.showAccelerator).toBe('Cmd+1')
    for (const event of ['activate', 'second-instance']) {
      await application!.evaluate(({ BrowserWindow }, id) => {
        const win = BrowserWindow.fromId(id)!
        win.show()
        win.close()
      }, initial.id)
      expect(
        await application!.evaluate(({ BrowserWindow }, id) => {
          const win = BrowserWindow.fromId(id)
          return { exists: !!win, visible: win?.isVisible() }
        }, initial.id)
      ).toEqual({ exists: true, visible: false })
      await application!.evaluate(({ app }, event) => app.emit(event), event)
      await expect
        .poll(() =>
          application!.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.isVisible(), initial.id)
        )
        .toBe(true)
      expect((await page.evaluate(() => window.mylike.invoke('snapshot', {}))).ok).toBe(true)
    }
    await application!.evaluate(({ BrowserWindow, Menu }, id) => {
      const win = BrowserWindow.fromId(id)!
      win.close()
      const item = Menu.getApplicationMenu()!.getMenuItemById('show-main-window')!
      item.click(item, win, {
        altKey: false,
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        triggeredByAccelerator: true
      })
    }, initial.id)
    expect(
      await application!.evaluate(
        ({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.isVisible(),
        initial.id
      )
    ).toBe(true)
    // Quitting from the Dock/menu must still flush a hidden renderer and close the database.
    await application!.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.close(), initial.id)
    await application!.close()
    application = undefined
    page = await launch()
    const snapshot = await page.evaluate(() => window.mylike.invoke('snapshot', {}))
    expect(snapshot).toMatchObject({
      ok: true,
      data: { accounts: [expect.objectContaining({ id: created.data.id, name: 'Mac 本地测试' })] }
    })
  } finally {
    await application?.close().catch(() => {})
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
