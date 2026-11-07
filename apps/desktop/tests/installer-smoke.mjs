import { _electron as electron, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import appPackage from '../package.json' with { type: 'json' }

// Run against a fresh Windows test account. The installer registers the application for that user.
const options = process.argv.slice(2)
const installer = resolve(
  options.find((option) => !option.startsWith('--')) ??
    'dist/MyLike-' + appPackage.version + '-win-x64-setup.exe'
)
const freshUser = options.includes('--fresh-user')
if (
  freshUser &&
  (!process.env.CI || !process.env.APPDATA || existsSync(join(process.env.APPDATA, 'MyLikeElectron')))
)
  throw Error('Fresh-user verification requires an unused Windows CI profile')
const temp = realpathSync(tmpdir())
const root = mkdtempSync(join(temp, 'mylike-installer-test-'))
const install = join(root, 'MyLike Custom Path')
const profile = join(root, 'profile')
const moved = join(root, 'MyLike Moved Data')
const relocated = join(root, 'MyLike Relocated Install')
const executable = join(install, 'MyLike.exe')
const uninstaller = join(install, 'Uninstall MyLike.exe')
const sentinel = join(install, 'unrelated.txt')
const cookieUrl = 'https://www.douyin.com'
const shortcutName = options.find((option) => option.startsWith('--shortcut-name='))?.slice(16) ?? 'MyLike'
const shortcutPaths = ['DesktopDirectory', 'Programs'].map((folder) => {
  const path = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Environment]::GetFolderPath('${folder}')`
    ],
    { encoding: 'utf8', windowsHide: true }
  ).trim()
  if (!path) throw Error('Missing Windows shortcut folder: ' + folder)
  return join(path, shortcutName + '.lnk')
})

function run(file, args) {
  execFileSync(file, args, { windowsHide: true, windowsVerbatimArguments: true, timeout: 120_000 })
}

async function withApp(test, legacyProfile = true) {
  const env = { ...process.env, MYLIKE_HEADLESS: '1' }
  if (legacyProfile) env.MYLIKE_USER_DATA = profile
  else delete env.MYLIKE_USER_DATA
  const app = await electron.launch({ executablePath: executable, env })
  let closed = false
  app.once('close', () => {
    closed = true
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: '喜欢的内容' })).toBeVisible()
    return await test(page, app)
  } finally {
    if (!closed) await app.close()
  }
}

try {
  // NSIS requires /D=path to be last and unquoted, even when the path contains spaces.
  const args = ['/S', '/currentuser', '/D=' + install]
  mkdirSync(install)
  writeFileSync(sentinel, 'keep this file')
  expect(() => run(installer, args)).toThrow()
  expect(readFileSync(sentinel, 'utf8')).toBe('keep this file')
  renameSync(sentinel, join(root, 'untouched.txt'))
  run(installer, args)
  expect(existsSync(executable)).toBe(true)
  expect(existsSync(uninstaller)).toBe(true)
  expect(shortcutPaths.map(existsSync)).toEqual([true, true])
  const accountId = await withApp(async (page, app) => {
    const account = await page.evaluate(() => window.mylike.invoke('createAccount', { name: '安装启动验证' }))
    expect(account.ok).toBe(true)
    expect((await page.evaluate(() => window.mylike.invoke('theme', { theme: 'light' }))).ok).toBe(true)
    const diagnostics = await page.evaluate(() => window.mylike.invoke('diagnostics', {}))
    expect(diagnostics.data.packaged).toBe(true)
    expect(diagnostics.data.sqlite).toMatch(/^3\./)
    expect(await page.evaluate(() => typeof window.require)).toBe('undefined')
    await app.evaluate(
      async ({ session }, { id, url }) => {
        const cookies = session.fromPartition('persist:mylike-' + id).cookies
        await cookies.set({
          url,
          name: 'migration-test',
          value: 'persisted',
          expirationDate: Date.now() / 1000 + 600
        })
        await cookies.flushStore()
      },
      { id: account.data.id, url: cookieUrl }
    )
    return account.data.id
  })
  mkdirSync(moved)
  await withApp(async (page, app) => {
    expect(
      (await page.evaluate(() => window.mylike.invoke('dataInfo', { accountId: null }))).data.folder
    ).toBe(profile)
    await app.evaluate(({ app, dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
      // Playwright owns the process. Launch the next instance from the test to attach to it.
      app.relaunch = () => {}
    }, moved)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '数据与存储', exact: true }).click()
    const closed = app.waitForEvent('close', { timeout: 30_000 })
    await page.getByRole('button', { name: '更改目录', exact: true }).click()
    await closed
  })
  await withApp(async (page, app) => {
    const state = await page.evaluate(() => window.mylike.invoke('snapshot', {}))
    expect(state.data.activeAccountId).toBe(accountId)
    expect(state.data.theme).toBe('light')
    expect(state.data.version).toBe(appPackage.version)
    const info = (await page.evaluate(() => window.mylike.invoke('dataInfo', { accountId: null }))).data
    expect(info.folder, info.warning ?? 'expected migrated profile without warnings').toBe(moved)
    const cookies = await app.evaluate(
      ({ session }, { id, url }) =>
        session.fromPartition('persist:mylike-' + id).cookies.get({ url, name: 'migration-test' }),
      { id: accountId, url: cookieUrl }
    )
    expect(cookies).toEqual([expect.objectContaining({ value: 'persisted' })])
  })
  if (freshUser) {
    await withApp(async (page) => {
      const info = await page.evaluate(() => window.mylike.invoke('dataInfo', { accountId: null }))
      expect(info.data.folder).toBe(install + ' 数据')
    }, false)
  }
  run(installer, ['--no-desktop-shortcut', '/S', '/currentuser', '/D=' + relocated])
  expect(existsSync(executable)).toBe(false)
  expect(existsSync(join(relocated, 'MyLike.exe'))).toBe(true)
  expect(shortcutPaths.map(existsSync)).toEqual([false, true])
  run(join(relocated, 'Uninstall MyLike.exe'), ['/S', '/currentuser', '_?=' + relocated])
  expect(existsSync(join(relocated, 'MyLike.exe'))).toBe(false)
  expect(shortcutPaths.map(existsSync)).toEqual([false, false])
  expect(existsSync(join(moved, 'mylike.sqlite'))).toBe(true)
  if (freshUser) expect(existsSync(join(install + ' 数据', 'mylike.sqlite'))).toBe(true)
} finally {
  for (const folder of [install, relocated]) {
    if (existsSync(join(folder, 'MyLike.exe')) && existsSync(join(folder, 'Uninstall MyLike.exe')))
      run(join(folder, 'Uninstall MyLike.exe'), ['/S', '/currentuser', '_?=' + folder])
  }
  if (dirname(realpathSync(root)) !== temp || !basename(root).startsWith('mylike-installer-test-'))
    throw Error('Unsafe test directory cleanup')
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
}

console.log('Windows installer passed: path protection, migration, login cookies, restart and uninstall.')
