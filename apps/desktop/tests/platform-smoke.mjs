import { _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

// Opt-in, anonymous GET requests only. This is not a real-account acceptance test.
const profile = mkdtempSync(join(tmpdir(), 'mylike-platform-smoke-'))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let application
try {
  application = await electron.launch({
    executablePath: resolve(process.argv[2] ?? 'dist/win-unpacked/MyLike.exe'),
    args: [],
    env: { ...process.env, MYLIKE_HEADLESS: '1', MYLIKE_USER_DATA: profile },
    timeout: 30_000
  })
  const page = await application.firstWindow()
  await page.waitForFunction(() => !!window.mylike)
  const invoke = (command, input = {}) =>
    page.evaluate(({ command, input }) => window.mylike.invoke(command, input), { command, input })
  const metrics = () =>
    application.evaluate(({ app, webContents }) => ({
      processes: app.getAppMetrics().map((p) => ({
        type: p.type,
        workingSetMB: Math.round(p.memory.workingSetSize / 1024),
        privateMB: p.memory.privateBytes == null ? null : Math.round(p.memory.privateBytes / 1024)
      })),
      webContents: webContents.getAllWebContents().map((w) => w.getType())
    }))
  await pause(2000)
  console.log(JSON.stringify({ localIdle: await metrics() }))
  const created = await invoke('createAccount', { name: '匿名页面能力验证' })
  if (!created.ok) throw Error(created.error.code)
  const accountId = created.data.id
  await application.evaluate(({ session }, id) => {
    globalThis.__mylikeSignatureObservations = []
    session
      .fromPartition('persist:mylike-' + id)
      .webRequest.onBeforeRequest(
        { urls: ['https://www.douyin.com/aweme/v1/web/user/profile/self/*'] },
        (details, callback) => {
          const params = new URL(details.url).searchParams
          globalThis.__mylikeSignatureObservations.push(
            ['a_bogus', 'X-Bogus', '_signature'].some((key) => params.has(key))
          )
          callback({})
        }
      )
  }, accountId)
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await invoke('probe', { accountId })
    console.log(
      JSON.stringify({
        attempt,
        result: result.ok ? 'IDENTITY_AVAILABLE' : result.error.code,
        signed: await application.evaluate(() => globalThis.__mylikeSignatureObservations)
      })
    )
    if (result.ok || result.error.code !== 'CANCELLED') break
    await pause(4000)
  }
  console.log(JSON.stringify({ anonymousEngine: await metrics() }))
  await invoke('releaseEngine')
  await pause(10_000)
  console.log(
    JSON.stringify({
      released10s: await metrics(),
      runningServiceWorkers: await application.evaluate(
        ({ session }, id) =>
          Object.keys(session.fromPartition('persist:mylike-' + id).serviceWorkers.getAllRunning()).length,
        accountId
      )
    })
  )
  await pause(20_000)
  console.log(JSON.stringify({ released30s: await metrics() }))
} finally {
  await application?.close().catch(() => {})
  if (
    dirname(resolve(profile)) !== resolve(tmpdir()) ||
    !basename(profile).startsWith('mylike-platform-smoke-')
  )
    throw Error('Unsafe profile cleanup')
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
