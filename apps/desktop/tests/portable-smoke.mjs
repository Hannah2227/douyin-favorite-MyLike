import { chromium, expect } from '@playwright/test'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import appPackage from '../package.json' with { type: 'json' }

// NSIS does not forward Electron's inspector output to _electron.launch().
// Attach only to the renderer's localhost CDP port to exercise the real launcher.
const executable = resolve(process.argv[2] ?? `dist/MyLike-${appPackage.version}-win-x64-portable.exe`)
const profile = mkdtempSync(join(tmpdir(), 'mylike-portable-test-'))
let child, browser

async function launch() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  child = spawn(executable, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], {
    env: { ...process.env, MYLIKE_HEADLESS: '1', MYLIKE_USER_DATA: profile },
    stdio: 'ignore',
    windowsHide: true
  })
  let spawnError
  child.on('error', (error) => {
    spawnError = error
  })
  const endpoint = `http://127.0.0.1:${port}`
  await expect
    .poll(
      async () => {
        if (spawnError) throw spawnError
        return fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(1000) })
          .then((r) => r.ok)
          .catch(() => false)
      },
      { timeout: 35_000 }
    )
    .toBe(true)
  browser = await chromium.connectOverCDP(endpoint)
  // Chromium can expose its CDP endpoint before Electron creates the UI window.
  const context = browser.contexts()[0]
  const page = context.pages()[0] ?? (await context.waitForEvent('page', { timeout: 15_000 }))
  await page.waitForFunction(() => !!window.mylike)
  await expect(page.getByRole('heading', { name: '喜欢的内容' })).toBeVisible()
  return page
}

async function close(page) {
  const exited = new Promise((resolve) => child.once('exit', resolve))
  await page.close()
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(Error('Portable app did not exit')), 10_000).unref())
  ])
  await browser?.close()
  browser = null
  child = null
}

try {
  let page = await launch()
  const account = await page.evaluate(() => window.mylike.invoke('createAccount', { name: '免安装启动验证' }))
  expect(account.ok).toBe(true)
  expect((await page.evaluate(() => window.mylike.invoke('theme', { theme: 'light' }))).ok).toBe(true)
  const diagnostics = await page.evaluate(() => window.mylike.invoke('diagnostics', {}))
  expect(diagnostics.data.packaged).toBe(true)
  expect(diagnostics.data.sqlite).toMatch(/^3\./)
  expect(await page.evaluate(() => typeof window.require)).toBe('undefined')
  await close(page)
  page = await launch()
  const state = await page.evaluate(() => window.mylike.invoke('snapshot', {}))
  expect(state.data.activeAccountId).toBe(account.data.id)
  expect(state.data.theme).toBe('light')
  expect(state.data.version).toBe(appPackage.version)
  await close(page)
  console.log(
    'Portable EXE passed: extraction, local UI, SQLite, isolated account, theme, clean exit and restart persistence.'
  )
} catch (error) {
  console.error('Portable smoke failed before cleanup:', error)
  throw error
} finally {
  await browser?.close().catch(() => {})
  if (child && child.exitCode === null && child.signalCode === null) {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  }
  if (
    dirname(resolve(profile)) !== resolve(tmpdir()) ||
    !basename(profile).startsWith('mylike-portable-test-')
  )
    throw Error('Unsafe profile cleanup')
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
}
