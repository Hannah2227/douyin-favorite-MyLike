const { app, BrowserWindow, session, webContents } = require('electron')
const path = require('node:path')

// Run compiled product code without Playwright, inspector or remote-debugging ports.
require(path.resolve(__dirname, '../../out/main/index.cjs'))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const started = Date.now()
const report = (label, extra = {}) =>
  console.log(
    JSON.stringify({
      label,
      elapsedMs: Date.now() - started,
      packaged: app.isPackaged,
      debugConnection: false,
      processes: app.getAppMetrics().map((p) => ({
        type: p.type,
        workingSetMB: Math.round(p.memory.workingSetSize / 1024),
        privateMB: p.memory.privateBytes == null ? null : Math.round(p.memory.privateBytes / 1024)
      })),
      webContents: webContents.getAllWebContents().map((w) => w.getType()),
      ...extra
    })
  )

void (async () => {
  await app.whenReady()
  let ui
  for (let i = 0; i < 300; i++) {
    ui = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('mylike://ui/'))
    if (ui && (await ui.webContents.executeJavaScript('Boolean(window.mylike)').catch(() => false))) break
    await pause(100)
  }
  if (!ui) throw Error('Local UI unavailable')
  const invoke = (command, input = {}) =>
    ui.webContents.executeJavaScript(
      `window.mylike.invoke(${JSON.stringify(command)},${JSON.stringify(input)})`
    )
  await pause(2000)
  report('localIdle')
  const created = await invoke('createAccount', { name: 'Anonymous benchmark' })
  if (!created.ok) throw Error(created.error.code)
  const accountId = created.data.id
  const partition = session.fromPartition('persist:mylike-' + accountId)
  const signed = []
  partition.webRequest.onSendHeaders(
    { urls: ['https://www.douyin.com/aweme/v1/web/user/profile/self/*'] },
    (details) => {
      const params = new URL(details.url).searchParams
      signed.push(['a_bogus', 'X-Bogus', '_signature'].some((key) => params.has(key)))
    }
  )
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await invoke('probe', { accountId })
    console.log(
      JSON.stringify({ attempt, result: result.ok ? 'IDENTITY_AVAILABLE' : result.error.code, signed })
    )
    if (result.ok || result.error.code !== 'CANCELLED') break
    await pause(4000)
  }
  await pause(10_000)
  report('anonymousEngine', {
    page: await BrowserWindow.getAllWindows()
      .find((w) => w !== ui)
      ?.webContents.executeJavaScript(
        '({pathname:location.pathname,media:document.querySelectorAll("video,audio").length,heapMB:Math.round(performance.memory.usedJSHeapSize/1048576),dom:document.getElementsByTagName("*").length})'
      ),
    runningServiceWorkers: Object.keys(partition.serviceWorkers.getAllRunning()).length
  })
  await invoke('releaseEngine')
  await pause(10_000)
  report('released10s', {
    runningServiceWorkers: Object.keys(partition.serviceWorkers.getAllRunning()).length
  })
  await pause(20_000)
  report('released30s', {
    runningServiceWorkers: Object.keys(partition.serviceWorkers.getAllRunning()).length
  })
  app.quit()
})().catch((error) => {
  console.error('Benchmark failed:', error instanceof Error ? error.message : 'unknown error')
  app.exit(1)
})
