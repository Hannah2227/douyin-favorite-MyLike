const { app, BrowserWindow, session, webContents } = require('electron')
const { DatabaseSync } = require('node:sqlite')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const started = Date.now(),
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let ui
require(path.join(__dirname, 'out/main/index.cjs'))
const output = (value) => console.log('MYLIKE_BENCHMARK ' + JSON.stringify(value))
const report = (label, extra = {}) =>
  output({
    label,
    elapsedMs: Date.now() - started,
    packaged: app.isPackaged,
    debugConnection: false,
    processes: app.getAppMetrics().map((p) => ({
      type: p.type,
      workingSetMiB: Math.round(p.memory.workingSetSize / 1024),
      privateMiB: Math.round(p.memory.privateBytes / 1024)
    })),
    webContents: webContents.getAllWebContents().map((w) => w.getType()),
    ...extra
  })
async function until(test, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await test()) return
    await pause(100)
  }
  throw Error('Benchmark condition timed out')
}
const raw = (command, input = {}) =>
  ui.webContents.executeJavaScript(
    `window.mylike.invoke(${JSON.stringify(command)},${JSON.stringify(input)})`
  )
async function invoke(command, input = {}) {
  const result = await raw(command, input)
  if (!result.ok) throw Error(result.error.code)
  return result.data
}
async function fixture(accountId) {
  const part = session.fromPartition('persist:mylike-' + accountId),
    video = readFileSync(path.join(__dirname, 'fixture.mp4'))
  await part.protocol.handle('https', (request) => {
    const url = new URL(request.url)
    if (url.pathname === '/user/self')
      return new Response('<!doctype html><body>Controlled SDK page</body>', {
        headers: { 'content-type': 'text/html' }
      })
    if (url.pathname.includes('/profile/self/'))
      return Response.json({
        status_code: 0,
        user: { sec_uid: 'fixture_benchmark_identity', nickname: 'Benchmark' }
      })
    if (url.pathname.includes('/aweme/favorite/')) {
      const cursor = Number(url.searchParams.get('max_cursor')),
        end = cursor + 18
      return Response.json({
        status_code: 0,
        aweme_list: Array.from({ length: 18 }, (_, index) => ({
          aweme_id: String(7000000000000000000n + BigInt(cursor + index + 1)),
          desc: '受控内容',
          create_time: 1700000000,
          author: { nickname: 'Benchmark' }
        })),
        has_more: end < 180 ? 1 : 0,
        max_cursor: String(end)
      })
    }
    if (url.pathname.includes('/aweme/detail/'))
      return Response.json({
        status_code: 0,
        aweme_detail: {
          aweme_id: url.searchParams.get('aweme_id'),
          desc: '受控视频',
          create_time: 1700000000,
          author: { nickname: 'Benchmark' },
          video: { play_addr_h264: { url_list: ['https://fixture.douyinvod.com/fixture.mp4'] } }
        }
      })
    return new Response('No writes allowed in benchmark', { status: 403 })
  })
  await session.fromPartition('persist:mylike-ui').protocol.handle('https', (request) => {
    if (new URL(request.url).hostname !== 'fixture.douyinvod.com')
      return new Response('Blocked', { status: 403 })
    const match = request.headers.get('range')?.match(/^bytes=(\d+)-(\d*)$/),
      headers = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes' }
    if (!match)
      return new Response(video, { headers: { ...headers, 'content-length': String(video.length) } })
    const start = Number(match[1]),
      end = match[2] ? Math.min(video.length - 1, Number(match[2])) : video.length - 1
    if (start > end || start >= video.length) return new Response(null, { status: 416 })
    return new Response(video.slice(start, end + 1), {
      status: 206,
      headers: {
        ...headers,
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${video.length}`
      }
    })
  })
}
void (async () => {
  await app.whenReady()
  await until(async () => {
    ui = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('mylike://ui/'))
    return ui && (await ui.webContents.executeJavaScript('Boolean(window.mylike)').catch(() => false))
  })
  ui.webContents.setAudioMuted(true)
  ui.webContents.setBackgroundThrottling(false)
  await pause(2000)
  report('localIdle')
  const account = await invoke('createAccount', { name: 'Controlled benchmark' }),
    accountId = account.id
  await fixture(accountId)
  await invoke('collectPage', { accountId, continue: false })
  const db = new DatabaseSync(path.join(app.getPath('userData'), 'mylike.sqlite'))
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE')
    const work = db.prepare('INSERT OR IGNORE INTO works VALUES(?,?,?,?,?,?,?)'),
      member = db.prepare(
        'INSERT OR IGNORE INTO account_items(accountId,workId,firstSeen,platformSeen) VALUES(?,?,?,1)'
      )
    for (let i = 1; i <= 50000; i++) {
      const id = String(7000000000000000000n + BigInt(i))
      work.run(id, '受控内容 ' + i, 'Benchmark', 1700000000 + i, null, 'video', 0)
      member.run(accountId, id, 1700000000000 + i)
    }
    db.exec('COMMIT')
  } finally {
    db.close()
  }
  ui.webContents.reload()
  await until(() =>
    ui.webContents
      .executeJavaScript('document.querySelector(".list-caption")?.textContent.includes("50000 条内容")')
      .catch(() => false)
  )
  await pause(2000)
  report('library50k', {
    cards: await ui.webContents.executeJavaScript('document.querySelectorAll(".work-card").length')
  })
  await invoke('collectionStart', { accountId, mode: 'full' })
  await until(async () => (await invoke('snapshot')).collection?.pages >= 4)
  report('controlledCollecting')
  await until(async () => (await invoke('snapshot')).collection?.status === 'completed', 90000)
  await invoke('releaseEngine')
  await pause(3000)
  await ui.webContents.executeJavaScript(
    'Array.from(document.querySelectorAll("button")).find(b => b.textContent.trim() === "顺序播放").click()',
    true
  )
  await until(() =>
    ui.webContents
      .executeJavaScript('Boolean(document.querySelector("video")?.readyState >= 2)')
      .catch(() => false)
  )
  const soakStart = Date.now(),
    deadline = soakStart + Number(process.env.MYLIKE_BENCHMARK_MINUTES) * 60000
  let previousIndex = -1,
    lastProgress = Date.now(),
    advances = 0,
    samples = 0
  while (Date.now() < deadline) {
    const state = await invoke('snapshot'),
      media = await ui.webContents.executeJavaScript(
        '(() => { const v=document.querySelector("video");return v ? {ready:v.readyState,error:v.error?.code??null,paused:v.paused,frames:v.getVideoPlaybackQuality().totalVideoFrames} : null })()'
      )
    if (state.playback?.index > previousIndex) {
      advances++
      lastProgress = Date.now()
    }
    previousIndex = state.playback?.index ?? -1
    if (media?.error) throw Error('Controlled media decoding failed')
    if (samples > 1 && (!media || state.playback?.completed)) throw Error('Playback stopped during soak')
    if (Date.now() - lastProgress > 90000) throw Error('Playback made no progress for 90 seconds')
    const nodes = await ui.webContents.executeJavaScript(
      '({cards:document.querySelectorAll(".work-card").length,video:document.querySelectorAll("video").length,audio:document.querySelectorAll("audio").length})'
    )
    if (nodes.cards > 150 || nodes.video > 1 || nodes.audio > 1)
      throw Error('Playback DOM exceeded its resource bounds')
    report('controlledPlayback', {
      soakMs: Date.now() - soakStart,
      index: previousIndex,
      queueTotal: state.playback?.total,
      media,
      nodes,
      samples: ++samples
    })
    await pause(Math.min(30000, Math.max(0, deadline - Date.now())))
  }
  if (advances < 2) throw Error('Playback did not advance')
  await ui.webContents.executeJavaScript('document.querySelector("button[aria-label=返回内容库]").click()')
  await until(() => ui.webContents.executeJavaScript('!document.querySelector("video,audio")'))
  await invoke('releaseEngine')
  await pause(10000)
  report('afterPlaybackRelease')
  const anonymous = await invoke('createAccount', { name: 'Anonymous readonly benchmark' })
  const part = session.fromPartition('persist:mylike-' + anonymous.id)
  part.webRequest.onBeforeRequest(
    { urls: ['https://www.douyin.com/aweme/v1/web/commit/*'] },
    (_details, callback) => callback({ cancel: true })
  )
  const probe = await raw('probe', { accountId: anonymous.id })
  output({ label: 'anonymousProbe', result: probe.ok ? 'IDENTITY_AVAILABLE' : probe.error.code })
  await pause(10000)
  report('anonymousPlatformEngine', {
    serviceWorkers: Object.keys(part.serviceWorkers.getAllRunning()).length
  })
  await invoke('releaseEngine')
  await pause(10000)
  report('anonymousReleased10s', { serviceWorkers: Object.keys(part.serviceWorkers.getAllRunning()).length })
  await pause(20000)
  report('anonymousReleased30s', { serviceWorkers: Object.keys(part.serviceWorkers.getAllRunning()).length })
  output({ label: 'complete', durationMs: Date.now() - started, playbackAdvancesObserved: advances })
  app.quit()
})().catch((error) => {
  console.error('Benchmark failed:', error instanceof Error ? error.message : 'unknown error')
  app.exit(1)
})
