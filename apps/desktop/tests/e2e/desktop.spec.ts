import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { Command, QueueState } from '../../src/shared/contracts'
import { version } from '../../package.json'
import { CHANNEL } from '../../src/shared/channels'
import { terminateApp } from '../helpers/terminate-app'
import { testTimeout } from '../helpers/test-timeout'

// Use the image decoder already bundled with Playwright; no application dependency.
const { PNG } = require(
  require.resolve('playwright-core/lib/utilsBundle', {
    paths: [require.resolve('playwright', { paths: [require.resolve('@playwright/test')] })]
  })
) as { PNG: { sync: { read(value: Buffer): { width: number; height: number; data: Buffer } } } }
function changedPixels(before: Buffer, after: Buffer): number {
  const a = PNG.sync.read(before),
    b = PNG.sync.read(after)
  expect({ width: b.width, height: b.height }).toEqual({ width: a.width, height: a.height })
  let changed = 0
  for (let i = 0; i < a.data.length; i += 4)
    if (a.data.subarray(i, i + 4).some((value, channel) => Math.abs(value - b.data[i + channel]!) > 4))
      changed++
  return changed / (a.width * a.height)
}

let app: ElectronApplication, page: Page, profile: string
// flower.mp4: MDN CC0 media sample; https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4
// portrait.webm: project-generated Canvas/MediaRecorder geometry sample. Fixtures are not distributed.
const workId = '7381234567890123456'

async function launch(heading = '喜欢的内容') {
  app = await electron.launch({
    ...(process.env.MYLIKE_EXECUTABLE
      ? { executablePath: process.env.MYLIKE_EXECUTABLE, args: [] }
      : { args: [process.cwd()] }),
    env: { ...process.env, MYLIKE_HEADLESS: '1', MYLIKE_USER_DATA: profile },
    timeout: testTimeout(30_000)
  })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.webContents.setBackgroundThrottling(false)
  )
  await expect(page.getByRole('heading', { name: heading })).toBeVisible()
}
async function invoke(command: Command, input: unknown = {}): Promise<any> {
  return page.evaluate(
    async ({ command, input }) => {
      const api = window.mylike as { invoke(command: string, input: unknown): Promise<any> }
      return api.invoke(command, input)
    },
    { command, input }
  )
}
async function screenshot(path: string) {
  // A never-shown Windows window may have no compositor frame, or return an old one.
  const windowId = await app.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith('mylike://ui/'))!.id
  )
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.showInactive(), windowId)
  try {
    await page.screenshot({ path, animations: 'disabled', timeout: 10_000 })
    const native = await app.evaluate(async ({ BrowserWindow }, id) => {
      const win = BrowserWindow.fromId(id)!
      return win.webContents.getZoomFactor() === 1
        ? null
        : (await win.webContents.capturePage()).toPNG().toString('base64')
    }, windowId)
    if (native) writeFileSync(path, Buffer.from(native, 'base64'))
  } finally {
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.hide(), windowId)
  }
}
async function chooseOption(label: string, option: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}
async function addAccount() {
  await page.getByRole('button', { name: '添加抖音账号', exact: true }).click()
  await page.getByRole('textbox', { name: '账号名称' }).fill('我的测试账号')
  await page.getByRole('button', { name: '创建账号' }).click()
  await expect(page.getByLabel('当前账号')).toBeVisible()
  return (await invoke('snapshot')).data.activeAccountId as string
}
async function remoteChallenge(accountId: string, mode: 'visible' | 'hidden' | 'none') {
  await app.evaluate(
    async ({ BrowserWindow, session }, { accountId, mode }) => {
      const win = BrowserWindow.getAllWindows().find(
        (win) => win.webContents.session === session.fromPartition(`persist:mylike-${accountId}`)
      )!
      await win.webContents.executeJavaScript(`(() => {
      document.querySelector('#secsdk-Captcha-container')?.remove();
      if (${JSON.stringify(mode)} !== 'none') {
        const node = document.createElement('div'); node.id = 'secsdk-Captcha-container';
        node.textContent = '请拖动滑块完成安全验证';
        node.style.cssText = 'position:fixed;left:30px;top:30px;width:350px;height:200px;background:white;z-index:99999;' +
          (${JSON.stringify(mode)} === 'hidden' ? 'display:none' : '');
        document.body.append(node);
      }
      const caption = document.createElement('p'); caption.textContent = '用户文案：安全验证教学'; document.body.append(caption);
      history.replaceState(null, '', '/user/self?showTab=like&verifyFp=normal-fingerprint');
    })()`)
    },
    { accountId, mode }
  )
}
async function closeRemoteWindow(accountId: string) {
  await app.evaluate(({ BrowserWindow, session }, accountId) => {
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.session === session.fromPartition(`persist:mylike-${accountId}`))!
      .close()
  }, accountId)
}
async function installPlatform(accountId: string, slow?: 'identity' | 'page') {
  await app.evaluate(
    async ({ session }, { accountId, slow, workId }) => {
      const calls: string[] = []
      ;(globalThis as any).__mylikeTestCalls = calls
      await session.fromPartition(`persist:mylike-${accountId}`).protocol.handle('https', async (request) => {
        const url = new URL(request.url)
        calls.push(request.url)
        if (url.pathname === '/fixture-delayed-resource') {
          await new Promise<void>((resolve) => {
            ;(globalThis as any).__releaseLoginResource = resolve
          })
          return new Response('image unavailable', { status: 404 })
        }
        const sdkWrapper =
          'const originalFetch = window.fetch.bind(window); window.fetch = (input, options) => { const url = new URL(input); url.searchParams.set("_fixture_sdk", "page-main-world"); return originalFetch(url, options); };'
        if (url.pathname === '/fixture-delayed-sdk.js') {
          await new Promise<void>((resolve) => {
            ;(globalThis as any).__releasePageSdk = resolve
          })
          return new Response(sdkWrapper, { headers: { 'content-type': 'application/javascript' } })
        }
        if (url.pathname === '/user/self' || url.pathname === '/fixture-login-redirect') {
          if (slow === 'page')
            await new Promise<void>((resolve) => {
              ;(globalThis as any).__mylikeReleasePage = resolve
            })
          return new Response(
            `<!doctype html><html><head>${(globalThis as any).__mylikeSlowPageSdk ? '<script async src="/fixture-delayed-sdk.js"></script>' : `<script>${sdkWrapper}</script>`}</head><body>受控抖音测试页；不连接真实账号。
        ${(globalThis as any).__mylikeLoginMarkup ?? ''}
        ${(globalThis as any).__mylikeSlowLoginResource ? '<img src="/fixture-delayed-resource">' : ''}
        ${(globalThis as any).__mylikeRedirectLogin && url.pathname === '/user/self' ? '<script>location.replace("/fixture-login-redirect")</script>' : ''}
        </body></html>`,
            { headers: { 'content-type': 'text/html; charset=utf-8' } }
          )
        }
        let body: unknown
        if (url.pathname.startsWith('/video/'))
          return new Response('<html><body>受控作品原页；没有真实评论操作。</body></html>', {
            headers: { 'content-type': 'text/html; charset=utf-8' }
          })
        if (url.pathname.includes('/profile/self/')) {
          if (slow === 'identity') await new Promise((resolve) => setTimeout(resolve, 25_000))
          if ((globalThis as any).__mylikeSlowFirstIdentity) {
            ;(globalThis as any).__mylikeSlowFirstIdentity = false
            await new Promise((resolve) => setTimeout(resolve, (globalThis as any).__identityDelayMs ?? 1500))
          }
          body = { status_code: 0, user: { sec_uid: 'MS4wLjAB_fixture_identity_1', nickname: '测试用户' } }
          if ((globalThis as any).__mylikeOtherIdentity)
            body = { status_code: 0, user: { sec_uid: 'MS4wLjAB_fixture_identity_2', nickname: '其他用户' } }
          if ((globalThis as any).__mylikeAuthLost) body = { status_code: 0, user: {} }
          if ((globalThis as any).__mylikeIdentityRejected) body = { status_code: 8 }
        } else if (url.pathname.includes('/aweme/favorite/')) {
          if (url.searchParams.get('max_cursor') === (globalThis as any).__mylikeHoldLikesAt)
            await new Promise<void>((resolve) => {
              ;(globalThis as any).__mylikeReleaseLikes = resolve
            })
          const challenge = (globalThis as any).__mylikeChallengeResponse
          if (challenge === 'html')
            return new Response('<html>安全验证</html>', { headers: { 'content-type': 'text/html' } })
          if (challenge === 'json') return new Response('{"status_code":9,"status_msg":"请完成安全验证"}')
          if (challenge === 'empty') return new Response('')
          if ((globalThis as any).__mylikeRateLimited) return new Response('{}', { status: 429 })
          body =
            url.searchParams.get('max_cursor') !== '7381234567890123459'
              ? {
                  status_code: 0,
                  aweme_list: [
                    {
                      aweme_id: workId,
                      desc: '测试视频：喜欢的日常',
                      create_time: 1_700_000_000,
                      author: { nickname: '测试作者' }
                    }
                  ],
                  max_cursor:
                    url.searchParams.get('max_cursor') === '0'
                      ? '7381234567890123457'
                      : '7381234567890123459',
                  has_more: 1
                }
              : { status_code: 0, aweme_list: [], max_cursor: '0', has_more: 0 }
          if ((globalThis as any).__mylikeLongCollection || (globalThis as any).__mylikeReplayCollection)
            body = {
              status_code: 0,
              aweme_list: [
                {
                  aweme_id: (globalThis as any).__mylikeReplayCollection
                    ? workId
                    : String(BigInt(workId) + BigInt(url.searchParams.get('max_cursor')!)),
                  desc: url.searchParams.get('max_cursor') === '0' ? '测试视频：喜欢的日常' : '后续采集作品',
                  create_time: 1_700_000_000 - Number(BigInt(url.searchParams.get('max_cursor')!) % 100000n),
                  author: { nickname: '测试作者' }
                }
              ],
              max_cursor: String(BigInt(url.searchParams.get('max_cursor')!) + 1n),
              has_more: 1
            }
          if ((globalThis as any).__mylikeEndCollection)
            body = { status_code: 0, aweme_list: [], max_cursor: '0', has_more: 0 }
          if ((globalThis as any).__mylikeQueueWorks)
            body = {
              status_code: 0,
              aweme_list: ((globalThis as any).__mylikeQueueWorks as string[]).map((id, i) => ({
                aweme_id: id,
                desc: (globalThis as any).__mylikeLongCaption || `队列作品 ${i + 1}`,
                create_time: 1700000000 + i,
                author: { nickname: '测试作者' }
              })),
              max_cursor: '0',
              has_more: 0
            }
          if ((globalThis as any).__mylikeLikedPages) {
            const entry = (globalThis as any).__mylikeLikedPages[url.searchParams.get('max_cursor')!]
            body = Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry
          }
        } else if (
          url.pathname.includes('/aweme/listcollection/') ||
          url.pathname.includes('/collects/list/') ||
          url.pathname.includes('/collects/video/list/')
        ) {
          const globals = globalThis as any
          const parameters =
            request.method === 'POST' ? new URLSearchParams(await request.text()) : url.searchParams
          const cursor = parameters.get('cursor') ?? '0'
          globals.__favoriteRequests ??= []
          globals.__favoriteRequests.push({
            path: url.pathname,
            method: request.method,
            cursor,
            folderId: parameters.get('collects_id'),
            sdk: url.searchParams.get('_fixture_sdk')
          })
          if (globals.__favoriteChallengeFolder && url.pathname.includes('/collects/list/'))
            return new Response('<html>安全验证</html>')
          if (globals.__favoriteRateLimited) return new Response('{}', { status: 429 })
          const ids = [workId, String(BigInt(workId) + 10n), String(BigInt(workId) + 11n)]
          const items = (indexes: number[]) =>
            indexes.map((index) => ({
              aweme_id: ids[index],
              desc: '收藏作品 ' + (index + 1),
              create_time: 1700000000 + index,
              author: { nickname: '收藏作者' }
            }))
          if (globals.__favoriteReplayPage && url.pathname.includes('/aweme/listcollection/'))
            body = {
              status_code: 0,
              aweme_list: items([0]),
              cursor: String(BigInt(cursor) + 1n),
              has_more: 1
            }
          else if (url.pathname.includes('/aweme/listcollection/'))
            body = {
              status_code: 0,
              aweme_list: items(cursor === '0' ? [0, 1] : [2]),
              cursor: cursor === '0' ? '9007199254740993988' : '0',
              has_more: cursor === '0' ? 1 : 0
            }
          else if (url.pathname.includes('/collects/video/list/')) {
            if (globals.__favoriteHold && cursor === '9007199254740993977')
              await new Promise<void>((resolve) => {
                globals.__releaseFavorite = resolve
              })
            const first = parameters.get('collects_id') === '9007199254740993999'
            body = {
              status_code: 0,
              aweme_list: items(first ? (cursor === '0' ? [0] : [1]) : [2]),
              cursor: first && cursor === '0' ? '9007199254740993977' : '0',
              has_more: first && cursor === '0' ? 1 : 0
            }
            if (globals.__favoriteNullTerminals && !first)
              body = {
                status_code: 0,
                cursor: '0',
                has_more: 0,
                ...(parameters.get('collects_id') === '8' ? { aweme_list: null } : {})
              }
          } else if (globals.__favoriteNullTerminals)
            body = {
              status_code: 0,
              collects_list: [
                { collects_id: '9007199254740993999', collects_name: '旅行', aweme_count: 2 },
                { collects_id: '8', collects_name: '空收藏夹', aweme_count: 0 },
                { collects_id: '9', collects_name: '另一个空收藏夹', aweme_count: 0 }
              ],
              cursor: '0',
              has_more: 0
            }
          else if (globals.__favoriteWriteFixture)
            body = {
              status_code: 0,
              collects_list: [
                {
                  collects_id_str: '9007199254740993999',
                  collects_name: '旅行',
                  total_number: 12,
                  status: 0
                },
                { collects_id_str: '8', collects_name: '音乐', total_number: 0, status: 1 },
                ...(globals.__favoriteCreatedFolders ?? [])
              ],
              cursor: '0',
              has_more: 0
            }
          else
            body = {
              status_code: 0,
              collects_list:
                cursor === '0'
                  ? [{ collects_id: '9007199254740993999', collects_name: '旅行', aweme_count: 2 }]
                  : [{ collects_id: '8', collects_name: '音乐', aweme_count: 1 }],
              cursor: cursor === '0' ? '9' : '0',
              has_more: cursor === '0' ? 1 : 0
            }
        } else if (url.pathname.includes('/aweme/detail/')) {
          const detailId = url.searchParams.get('aweme_id') ?? workId
          if ((globalThis as any).__mylikeHoldDetailOnce === detailId) {
            ;(globalThis as any).__mylikeHoldDetailOnce = null
            await new Promise<void>((resolve) => {
              ;(globalThis as any).__releaseHeldDetail = resolve
            })
          }
          if ((globalThis as any).__mylikeDelayDetail === detailId)
            await new Promise((resolve) =>
              setTimeout(resolve, (globalThis as any).__mylikeDetailDelayMs ?? 2000)
            )
          body = {
            status_code: 0,
            aweme_detail: {
              aweme_id: detailId,
              collect_stat: (globalThis as any).__favoriteCollectedWorks?.includes(detailId) ? 1 : 0,
              desc: '测试视频：喜欢的日常',
              create_time: 1_700_000_000,
              author: { nickname: '测试作者' },
              video: {
                play_addr_h264: { url_list: [`https://fixture.douyinvod.com/video-${detailId}.mp4`] }
              },
              ...((globalThis as any).__mylikeGallery
                ? {
                    images: [
                      {
                        url_list: [
                          (globalThis as any).__mylikeMissingPhoto
                            ? 'https://fixture.douyinpic.com/missing.svg'
                            : 'https://fixture.douyinpic.com/1.svg'
                        ],
                        video: { play_addr: { url_list: ['https://fixture.douyinvod.com/live.mp4'] } }
                      },
                      { url_list: ['https://fixture.douyinpic.com/2.svg'] }
                    ],
                    music: { play_url: { url_list: ['https://sf11-cdn-tos.douyinstatic.com/music.mp4'] } }
                  }
                : {})
            }
          }
        } else if (
          ['/aweme/collect/', '/collects/video/move/', '/collects/maintain/'].some((path) =>
            url.pathname.includes(path)
          )
        ) {
          const globals = globalThis as any
          const form = new URLSearchParams(await request.text())
          const operation = url.pathname.includes('/aweme/collect/')
            ? form.get('action') === '0'
              ? 'favoriteRemove'
              : 'favoriteAdd'
            : url.pathname.includes('/video/move/')
              ? 'favoriteFolderAdd'
              : 'favoriteFolderCreate'
          ;(globals.__favoriteWrites ??= []).push({
            operation,
            method: request.method,
            params: Object.fromEntries(url.searchParams),
            body: Object.fromEntries(form)
          })
          if (globals.__favoriteWriteFailure === operation) return new Response('')
          if (globals.__favoriteWriteHold === operation)
            await new Promise<void>((resolve) => {
              globals.__releaseFavoriteWrite = resolve
            })
          if (operation === 'favoriteAdd')
            (globals.__favoriteCollectedWorks ??= []).push(form.get('aweme_id'))
          if (operation === 'favoriteRemove')
            globals.__favoriteCollectedWorks = (globals.__favoriteCollectedWorks ?? []).filter(
              (id: string) => id !== form.get('aweme_id')
            )
          body = { status_code: 0 }
          if (operation === 'favoriteFolderCreate') {
            const folder = {
              collects_id_str: '9',
              collects_name: url.searchParams.get('collects_name'),
              total_number: 0,
              status: url.searchParams.get('secret') === '1' ? 0 : 1
            }
            ;(globals.__favoriteCreatedFolders ??= []).push(folder)
            body = { status_code: 0, collects_info: folder }
          }
        } else if (url.pathname.includes('/commit/item/digg/')) {
          ;(globalThis as any).__mylikeUnlikeCount = ((globalThis as any).__mylikeUnlikeCount ?? 0) + 1
          ;(globalThis as any).__mylikeUnlikeBody = await request.text()
          if ((globalThis as any).__mylikeHoldUnlike)
            await new Promise<void>((resolve) => {
              ;(globalThis as any).__mylikeReleaseUnlike = resolve
            })
          body = { status_code: 0 }
        } else return new Response('not found', { status: 404 })
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
      })
    },
    { accountId, slow, workId }
  )
}

async function installMedia(portrait = false) {
  const video = Array.from(
    readFileSync(join(process.cwd(), 'tests/fixtures', portrait ? 'portrait.webm' : 'flower.mp4'))
  )
  await app.evaluate(
    async ({ session }, { bytes, portrait }) => {
      const data = new Uint8Array(bytes)
      await session.fromPartition('persist:mylike-ui').protocol.handle('https', async (request) => {
        ;((globalThis as any).__mediaRequests ??= []).push(request.url)
        const delay = (globalThis as any).__mediaResponseDelayMs ?? 0
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
        if (request.url.endsWith('/missing.svg')) return new Response('', { status: 404 })
        if (request.url.endsWith('.svg'))
          return new Response(
            portrait
              ? '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><rect width="1080" height="1920" fill="#152035"/><rect x="20" y="20" width="1040" height="1880" fill="none" stroke="#ff6683" stroke-width="16"/><circle cx="540" cy="960" r="300" fill="none" stroke="#6fd9c7" stroke-width="16"/></svg>'
              : '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="960"><rect width="640" height="960" fill="#d4b8b1"/></svg>',
            { headers: { 'content-type': 'image/svg+xml' } }
          )
        const range = request.headers.get('range'),
          match = range?.match(/^bytes=(\d*)-(\d*)$/)
        const headers: Record<string, string> = {
          'content-type': portrait ? 'video/webm' : 'video/mp4',
          'accept-ranges': 'bytes'
        }
        if (!match) {
          headers['content-length'] = String(data.length)
          return new Response(data, { headers })
        }
        const start = match[1] ? Number(match[1]) : Math.max(0, data.length - Number(match[2])),
          end = match[2] && match[1] ? Math.min(data.length - 1, Number(match[2])) : data.length - 1
        if (start > end || start >= data.length)
          return new Response(null, { status: 416, headers: { 'content-range': `bytes */${data.length}` } })
        headers['content-range'] = `bytes ${start}-${end}/${data.length}`
        headers['content-length'] = String(end - start + 1)
        return new Response(data.slice(start, end + 1), { status: 206, headers })
      })
    },
    { bytes: video, portrait }
  )
}

async function prepareQueue(count = 3, gallery = false, portrait = false, caption = '') {
  const accountId = await addAccount()
  await installPlatform(accountId)
  await installMedia(portrait)
  const ids = Array.from({ length: count }, (_, i) => String(BigInt(workId) + BigInt(i)))
  await app.evaluate(
    (_electron, { ids, gallery, caption }) => {
      ;(globalThis as any).__mylikeQueueWorks = ids
      ;(globalThis as any).__mylikeGallery = gallery
      ;(globalThis as any).__mylikeLongCaption = caption
    },
    { ids, gallery, caption }
  )
  expect((await invoke('collectPage', { accountId, continue: false })).ok).toBe(true)
  await expect(page.locator('.list-caption')).toContainText(`${count} 条内容`)
  return { accountId, ids }
}
async function readyVideo(expectedIndex?: number) {
  // A click can finish before queue IPC does. Match the intended track, rendered
  // queue position and decoded metadata together; an old ready video is insufficient.
  await expect
    .poll(
      async () => {
        const queue = (await invoke('snapshot')).data.playback as QueueState | null
        if (!queue || (expectedIndex !== undefined && queue.index !== expectedIndex)) return false
        return page.evaluate(({ index, total, work }) => {
          const videos = document.querySelectorAll('video'),
            video = videos[0]
          return (
            videos.length === 1 &&
            !!video &&
            document.querySelector('.player-queue-position')?.textContent === `${index + 1} / ${total}` &&
            (video.getAttribute('src') === `https://fixture.douyinvod.com/video-${work.id}.mp4` ||
              video.getAttribute('src') === 'https://fixture.douyinvod.com/live.mp4') &&
            video.readyState >= 2 &&
            Number.isFinite(video.duration) &&
            video.duration > 0 &&
            video.videoWidth > 0 &&
            video.videoHeight > 0
          )
        }, queue)
      },
      { message: `Expected decoded video for queue index ${expectedIndex ?? 'current'}` }
    )
    .toBe(true)
}
async function seekVideo(position: number | { fromEnd: number }, play = false) {
  // Recheck metadata and seek in one renderer operation, avoiding a remount
  // between the ready check and currentTime assignment (duration would be NaN).
  await expect
    .poll(() =>
      page.locator('video').evaluateAll(
        (nodes, { position, play }) => {
          const video = nodes[0] as HTMLVideoElement | undefined
          if (
            nodes.length !== 1 ||
            !video ||
            video.readyState < 2 ||
            !Number.isFinite(video.duration) ||
            video.duration <= 0
          )
            return false
          video.currentTime = typeof position === 'number' ? position : video.duration - position.fromEnd
          if (play) void video.play()
          return true
        },
        { position, play }
      )
    )
    .toBe(true)
}
async function changeVideo(action: () => Promise<unknown>, expectedIndex: number) {
  const previous = await page.locator('video').elementHandle()
  expect(previous).not.toBeNull()
  try {
    await action()
    await expect.poll(() => previous!.evaluate((node) => !node.isConnected)).toBe(true)
    await readyVideo(expectedIndex)
  } finally {
    await previous?.dispose()
  }
}
async function delayPlaybackTransitions() {
  // Exercise both gaps deterministically: backend queue committed while the UI
  // still shows the old clip, and the new clip mounted before metadata arrives.
  await app.evaluate(({ ipcMain }, channel) => {
    const handler = (ipcMain as any)._invokeHandlers.get(channel)
    if (!handler) throw new Error('Missing test IPC handler')
    ;(globalThis as any).__mediaResponseDelayMs = 250
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, command, input) => {
      const result = await handler(event, command, input)
      if (['queueMove', 'queueEnd', 'queueReplay'].includes(command))
        await new Promise((resolve) => setTimeout(resolve, 750))
      return result
    })
  }, CHANNEL)
}

async function prepareScrollableLibrary(splitTypes = false) {
  const { accountId, ids } = await prepareQueue(145)
  await app.evaluate(
    ({ app }, { accountId, ids, splitTypes }) => {
      const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
      const { join } = process.getBuiltinModule('node:path') as typeof import('node:path')
      const db = new DatabaseSync(join(app.getPath('userData'), 'mylike.sqlite'))
      try {
        db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;')
        db.prepare(
          'INSERT INTO saved_items SELECT accountId,workId,firstSeen FROM account_items WHERE accountId=?'
        ).run(accountId)
        const folder = db.prepare('INSERT INTO saved_folders VALUES(?,?,?,?,?)')
        folder.run(accountId, '9007199254740993999', '大收藏夹', 125, 'scroll-fixture')
        folder.run(accountId, '9007199254740993988', '小收藏夹', 7, 'scroll-fixture')
        const member = db.prepare('INSERT INTO saved_members VALUES(?,?,?,?)')
        for (const [index, id] of ids.entries()) {
          if (index < 125) member.run(accountId, '9007199254740993999', id, 'scroll-fixture')
          if (index < 7) member.run(accountId, '9007199254740993988', id, 'scroll-fixture')
          if (splitTypes && index % 2) db.prepare("UPDATE works SET mediaType='gallery' WHERE id=?").run(id)
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      } finally {
        db.close()
      }
    },
    { accountId, ids, splitTypes }
  )
  await app.evaluate(
    ({ ipcMain }, { channel, accountId }) => {
      const handler = (ipcMain as any)._invokeHandlers.get(channel)
      if (!handler) throw new Error('Missing test IPC handler')
      ;(globalThis as any).__libraryQueries = []
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, command, input) => {
        if (command !== 'query' || input?.accountId !== accountId) return handler(event, command, input)
        const row = { ...input, source: input.source ?? 'likes' }
        ;(globalThis as any).__libraryQueries.push(row)
        if (input.offset > 0 && (globalThis as any).__failLibraryMore)
          return { ok: false, error: { code: 'READ_FAILED', message: '受控下一页读取失败' } }
        const response = await handler(event, command, input)
        if (response.ok) row.ids = response.data.items.map((work: { id: string }) => work.id)
        if (
          input.offset === 60 &&
          row.source === 'likes' &&
          input.mediaType === 'all' &&
          (globalThis as any).__holdLibraryMore
        )
          await new Promise<void>((resolve) => {
            ;(globalThis as any).__releaseLibraryPage = resolve
          })
        return response
      })
    },
    { channel: CHANNEL, accountId }
  )
  await page.reload()
  await expect(page.locator('.list-caption')).toContainText('145 条内容')
  await expect(page.locator('.work-card').first()).toBeVisible()
  return { accountId, ids }
}

async function scrollLibraryToEnd() {
  await page.locator('.library-scroll').evaluate((node) => {
    node.scrollTop = node.scrollHeight
  })
}

test.beforeEach(async () => {
  profile = mkdtempSync(join(tmpdir(), 'mylike-e2e-'))
  await launch()
})
test.afterEach(async () => {
  await app?.close().catch(() => {})
  if (dirname(resolve(profile)) !== resolve(tmpdir()) || !basename(profile).startsWith('mylike-e2e-'))
    throw new Error('Unsafe test profile cleanup')
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('creates an isolated SQLite profile, persists accounts and theme, and loads without Node in UI', async ({}, info) => {
  const accountId = await addAccount()
  expect((await invoke('snapshot')).data.version).toBe(version)
  await screenshot(info.outputPath('library-dark.png'))
  expect(await page.evaluate(() => typeof (window as any).require)).toBe('undefined')
  expect(
    await page.evaluate(async () => (await navigator.permissions.query({ name: 'geolocation' })).state)
  ).toBe('denied')
  expect((await invoke('diagnostics')).data.sqlite).toMatch(/^3\./)
  await page.getByRole('button', { name: '切换主题' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await screenshot(info.outputPath('library-light.png'))
  console.log('Initial runtime metrics:', JSON.stringify((await invoke('diagnostics')).data))
  await app.close()
  await launch()
  expect((await invoke('snapshot')).data.activeAccountId).toBe(accountId)
  await expect(page.getByRole('combobox', { name: '当前账号', exact: true })).toContainText('我的测试账号')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
})

test('executes main-world requests in a hidden account session, saves pages and continues with the exact cursor', async ({}, info) => {
  const accountId = await addAccount()
  await installPlatform(accountId)
  await page.getByRole('button', { name: '连接与任务', exact: true }).click()
  await page.getByRole('button', { name: '核验登录', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('已核验：测试用户')
  await page.getByText('诊断与运行记录', { exact: true }).click()
  await page.getByRole('button', { name: '采集一页', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('新增 1 条')
  await page.getByRole('button', { name: '继续下一页', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('新增 0 条')
  await page.getByRole('button', { name: '采集一页', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('新增 0 条')
  await page.getByRole('button', { name: '继续下一页', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('已到末尾')
  const calls = await app.evaluate(() => (globalThis as any).__mylikeTestCalls as string[])
  const likes = calls.filter((value) => value.includes('/aweme/favorite/')).map((value) => new URL(value))
  expect(likes.map((url) => url.searchParams.get('max_cursor'))).toEqual([
    '0',
    '7381234567890123457',
    '0',
    '7381234567890123459'
  ])
  expect(likes.every((url) => url.searchParams.get('_fixture_sdk') === 'page-main-world')).toBe(true)
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((win) => win.webContents.getURL().startsWith('https://www.douyin.com/'))
        .map((win) => win.isVisible())
    )
  ).toEqual([false])
  await page.getByRole('button', { name: '喜欢的内容', exact: true }).click()
  await expect(page.getByRole('button', { name: /测试视频：喜欢的日常/ })).toBeVisible()
  await screenshot(info.outputPath('library-with-content.png'))
  await installMedia()
  await page.getByRole('button', { name: /测试视频：喜欢的日常/ }).click()
  await expect(page.getByRole('region', { name: '播放器' })).toBeVisible()
  await expect
    .poll(() => page.locator('video').evaluate((video) => (video as HTMLVideoElement).readyState))
    .toBeGreaterThanOrEqual(2)
  await screenshot(info.outputPath('player.png'))
  await page.getByRole('button', { name: '返回内容库' }).click()
  await expect(page.locator('video')).toHaveCount(0)
  expect((await invoke('query', { accountId })).data.total).toBe(1)
  await app.close()
  await launch()
  expect((await invoke('query', { accountId })).data.items[0].id).toBe(workId)
})

test('rejects hostile command parameters and calls from another renderer', async () => {
  const accountId = await addAccount()
  const result = await invoke('media', { accountId, workId: "');process.exit();//" })
  expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  const preload = join(await app.evaluate(({ app }) => app.getAppPath()), 'out/preload/index.cjs')
  const foreign = await app.evaluate(async ({ BrowserWindow }, preload) => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    try {
      await win.loadURL('data:text/html,<html><body>untrusted</body></html>')
      return await win.webContents.executeJavaScript("window.mylike.invoke('snapshot', {})")
    } finally {
      win.destroy()
    }
  }, preload)
  expect(foreign).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
})

test('automatically collects, pauses, restores its task after restart and plays during collection', async ({}, info) => {
  const accountId = await addAccount()
  await installPlatform(accountId)
  await installMedia()
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeLongCollection = true
  })
  await page.getByRole('button', { name: '自动采集', exact: true }).click()
  await expect.poll(async () => (await invoke('snapshot')).data.collection?.pages).toBeGreaterThanOrEqual(1)
  await page
    .getByRole('button', { name: /测试视频：喜欢的日常/ })
    .first()
    .click()
  await expect.poll(async () => page.locator('video').count()).toBe(1)
  await expect
    .poll(() => page.locator('video').evaluate((video) => (video as HTMLVideoElement).readyState))
    .toBeGreaterThanOrEqual(2)
  await page.getByRole('button', { name: '返回内容库' }).click()
  await page.getByRole('button', { name: '连接与任务', exact: true }).click()
  await page.getByRole('button', { name: '暂停采集', exact: true }).click()
  await expect.poll(async () => (await invoke('snapshot')).data.collection?.status).toBe('paused')
  const paused = (await invoke('snapshot')).data.collection
  await screenshot(info.outputPath('collection-paused.png'))
  expect(paused.pages).toBeGreaterThanOrEqual(1)
  expect((await invoke('query', { accountId })).data.total).toBe(paused.added)
  await app.close()
  await launch()
  expect((await invoke('snapshot')).data.collection).toMatchObject({
    id: paused.id,
    status: 'paused',
    pages: paused.pages,
    cursor: paused.cursor
  })
  expect((await invoke('snapshot')).data.engine.status).toBe('stopped')
  await installPlatform(accountId)
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeEndCollection = true
  })
  await page.getByRole('button', { name: '连接与任务', exact: true }).click()
  await page
    .getByRole('region', { name: '自动采集任务' })
    .getByRole('button', { name: '继续采集', exact: true })
    .click()
  await expect
    .poll(async () => (await invoke('snapshot')).data.collection?.status, { timeout: 20000 })
    .toBe('completed')
  expect((await invoke('snapshot')).data.collection).toMatchObject({
    pages: paused.pages + 1,
    added: paused.added,
    received: paused.received
  })
  await expect(page.getByRole('region', { name: '自动采集任务' })).toContainText('平台已返回列表末尾')
})

test('recovers the committed collection cursor after a forced process exit and waits for explicit resume', async () => {
  const accountId = await addAccount()
  await installPlatform(accountId)
  const cursor = '7381234567890123457'
  await app.evaluate((_electron, cursor) => {
    ;(globalThis as any).__mylikeHoldLikesAt = cursor
  }, cursor)
  const start = await invoke('collectionStart', { accountId, mode: 'update' })
  expect(start.ok).toBe(true)
  await expect.poll(() => app.evaluate(() => !!(globalThis as any).__mylikeReleaseLikes)).toBe(true)
  expect((await invoke('snapshot')).data.collection).toMatchObject({ pages: 1, cursor, status: 'running' })
  await terminateApp(app, profile)
  await launch()
  await installPlatform(accountId)
  expect((await invoke('snapshot')).data).toMatchObject({
    busy: false,
    collection: { id: start.data.id, pages: 1, cursor, status: 'paused', errorCode: 'INTERRUPTED' },
    engine: { status: 'stopped' }
  })
  expect((await invoke('query', { accountId })).data.total).toBe(1)
  expect(await app.evaluate(() => (globalThis as any).__mylikeTestCalls.length)).toBe(0)
  expect((await invoke('collectionControl', { accountId, taskId: start.data.id, action: 'resume' })).ok).toBe(
    true
  )
  await expect.poll(async () => (await invoke('snapshot')).data.collection?.status).toBe('completed')
  expect((await invoke('snapshot')).data.collection).toMatchObject({ pages: 3, received: 2, added: 1 })
  const firstCursor = await app.evaluate(() => {
    const likes = ((globalThis as any).__mylikeTestCalls as string[]).find((url) =>
      url.includes('/aweme/favorite/')
    )!
    return new URL(likes).searchParams.get('max_cursor')
  })
  expect(firstCursor).toBe(cursor)
})

test('pauses with an engine crash reason and resumes collection from its committed cursor', async () => {
  const accountId = await addAccount()
  await installPlatform(accountId)
  const cursor = '7381234567890123457'
  await app.evaluate((_electron, cursor) => {
    ;(globalThis as any).__mylikeHoldLikesAt = cursor
  }, cursor)
  const start = await invoke('collectionStart', { accountId, mode: 'update' })
  expect(start.ok).toBe(true)
  await expect.poll(() => app.evaluate(() => !!(globalThis as any).__mylikeReleaseLikes)).toBe(true)
  await app.evaluate(async ({ BrowserWindow, session }, accountId) => {
    const partition = session.fromPartition(`persist:mylike-${accountId}`)
    const engine = BrowserWindow.getAllWindows().find((win) => win.webContents.session === partition)!
    await new Promise<void>((resolve) => {
      engine.webContents.once('render-process-gone', () => resolve())
      engine.webContents.forcefullyCrashRenderer()
    })
  }, accountId)
  await expect.poll(async () => (await invoke('snapshot')).data.collection?.status).toBe('paused')
  expect((await invoke('snapshot')).data).toMatchObject({
    busy: false,
    collection: { pages: 1, cursor, errorCode: 'BROWSER_CRASHED' },
    engine: { status: 'failed' }
  })
  expect((await invoke('query', { accountId })).data.total).toBe(1)
  await app.evaluate(({ BrowserWindow, session }, accountId) => {
    const partition = session.fromPartition(`persist:mylike-${accountId}`)
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.session === partition)!
      .close()
  }, accountId)
  expect((await invoke('snapshot')).data.engine.status).toBe('failed')
  await app.evaluate(() => {
    delete (globalThis as any).__mylikeHoldLikesAt
    ;(globalThis as any).__mylikeReleaseLikes()
  })
  expect((await invoke('collectionControl', { accountId, taskId: start.data.id, action: 'resume' })).ok).toBe(
    true
  )
  await expect.poll(async () => (await invoke('snapshot')).data.collection?.status).toBe('completed')
  expect((await invoke('snapshot')).data.collection).toMatchObject({ pages: 3, received: 2, added: 1 })
})

test('stops an in-flight request without binding identity or advancing the cursor', async () => {
  const accountId = await addAccount()
  const other = (await invoke('createAccount', { name: '另一个测试账号' })).data.id
  expect((await invoke('switchAccount', { accountId })).ok).toBe(true)
  await installPlatform(accountId, 'identity')
  const request = invoke('probe', { accountId })
  await expect.poll(async () => (await invoke('snapshot')).data.busy).toBe(true)
  await expect
    .poll(async () =>
      (await app.evaluate(() => (globalThis as any).__mylikeTestCalls as string[])).some((value) =>
        value.includes('/profile/self/')
      )
    )
    .toBe(true)
  expect(await invoke('switchAccount', { accountId: other })).toMatchObject({
    ok: false,
    error: { code: 'BUSY' }
  })
  await invoke('stopRequest')
  expect(await request).toMatchObject({ ok: false, error: { code: 'CANCELLED' } })
  const state = (await invoke('snapshot')).data
  expect(state.busy).toBe(false)
  expect(state.accounts[0].remoteId).toBeNull()
  expect((await invoke('query', { accountId })).data.total).toBe(0)
  expect((await invoke('switchAccount', { accountId: other })).ok).toBe(true)
  expect((await invoke('snapshot')).data.activeAccountId).toBe(other)
})

test('opens the login window when identity is missing and persists a rate-limit pause without retrying', async () => {
  test.setTimeout(testTimeout(120000))
  const accountId = await addAccount()
  await installPlatform(accountId)
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeAuthLost = true
  })
  const task = (await invoke('collectionStart', { accountId, mode: 'update' })).data
  // A cold engine may take 35s to initialize plus one bounded identity request.
  await expect
    .poll(
      async () => {
        const state = (await invoke('snapshot')).data
        return { error: state.collection?.errorCode, engine: state.engine.status }
      },
      { timeout: 50000 }
    )
    .toMatchObject({ error: 'AUTH_REQUIRED' })
  await expect.poll(async () => (await invoke('snapshot')).data.engine.status).toBe('visible')
  await expect.poll(async () => (await invoke('snapshot')).data.collectionActivity).toBeNull()
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeAuthLost = false
    ;(globalThis as any).__mylikeRateLimited = true
  })
  await expect.poll(async () => (await invoke('snapshot')).data.authentication).toBeNull()
  await expect.poll(async () => (await invoke('snapshot')).data.engine.status).toBe('ready')
  expect((await invoke('collectionControl', { accountId, taskId: task.id, action: 'resume' })).ok).toBe(true)
  await expect.poll(async () => (await invoke('snapshot')).data.collection?.errorCode).toBe('RATE_LIMITED')
  await expect.poll(async () => (await invoke('snapshot')).data.collectionActivity).toBeNull()
  const calls = await app.evaluate(() => (globalThis as any).__mylikeTestCalls as string[])
  expect(calls.filter((url) => url.includes('/aweme/favorite/'))).toHaveLength(1)
  expect((await invoke('query', { accountId })).data.total).toBe(0)
  await app.close()
  await launch()
  expect((await invoke('snapshot')).data.collection).toMatchObject({
    id: task.id,
    status: 'paused',
    errorCode: 'RATE_LIMITED',
    pages: 0,
    cursor: '0'
  })
  expect((await invoke('snapshot')).data.engine.status).toBe('stopped')
  await installPlatform(accountId)
  await invoke('collectionControl', { accountId, taskId: task.id, action: 'resume' })
  await expect
    .poll(async () => (await invoke('snapshot')).data.collection.status, { timeout: 20000 })
    .toBe('completed')
})

test('stops while the page is loading before issuing any identity request', async () => {
  const accountId = await addAccount()
  await installPlatform(accountId, 'page')
  const request = invoke('probe', { accountId })
  await expect.poll(() => app.evaluate(() => typeof (globalThis as any).__mylikeReleasePage)).toBe('function')
  await invoke('stopRequest')
  expect(await request).toMatchObject({ ok: false, error: { code: 'CANCELLED' } })
  expect((await invoke('snapshot')).data.busy).toBe(false)
  await app.evaluate(() => (globalThis as any).__mylikeReleasePage())
  await expect.poll(async () => (await invoke('snapshot')).data.engine.status).toBe('ready')
  expect(await app.evaluate(() => (globalThis as any).__mylikeTestCalls)).toEqual([
    'https://www.douyin.com/user/self?showTab=like'
  ])
  expect((await invoke('snapshot')).data.accounts[0].remoteId).toBeNull()
})

test('keeps gallery music while changing slides and releases media when leaving playback', async () => {
  const accountId = await addAccount()
  await installPlatform(accountId)
  await installMedia()
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeGallery = true
  })
  expect((await invoke('collectPage', { accountId, continue: false })).ok).toBe(true)
  await page.getByRole('button', { name: /测试视频：喜欢的日常/ }).click()
  await expect
    .poll(() => page.locator('video').evaluate((node) => (node as HTMLVideoElement).readyState))
    .toBeGreaterThanOrEqual(2)
  await expect
    .poll(() => page.locator('audio').evaluate((node) => (node as HTMLAudioElement).readyState))
    .toBeGreaterThanOrEqual(2)
  await page.evaluate(() => {
    ;(window as any).__mediaBeforeExit = [...document.querySelectorAll('video, audio')]
  })
  await page.getByRole('button', { name: '下一张', exact: true }).click()
  await expect(page.getByAltText('图集第 2 张')).toBeVisible()
  await expect(page.locator('video')).toHaveCount(0)
  await expect(page.locator('audio')).toHaveAttribute(
    'src',
    'https://sf11-cdn-tos.douyinstatic.com/music.mp4'
  )
  expect(
    await page.locator('audio').evaluate((node) => (node as HTMLAudioElement).readyState)
  ).toBeGreaterThanOrEqual(2)
  await page.getByRole('button', { name: '返回内容库' }).click()
  await expect(page.locator('video, audio')).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__mediaBeforeExit.every(
          (node: HTMLMediaElement) => !node.isConnected && node.paused && !node.hasAttribute('src')
        )
      )
    )
    .toBe(true)
})

test('releases and recreates the engine while keeping account cookies across app restart', async () => {
  const accountId = await addAccount()
  await installPlatform(accountId)
  await app.evaluate(async ({ session }, accountId) => {
    await session.fromPartition(`persist:mylike-${accountId}`).cookies.set({
      url: 'https://www.douyin.com/',
      name: 'mylike_fixture_login',
      value: 'controlled-session-only',
      secure: true,
      httpOnly: true,
      expirationDate: Math.floor(Date.now() / 1000) + 3600
    })
  }, accountId)
  expect((await invoke('probe', { accountId })).ok).toBe(true)
  const engineId = await app.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((win) =>
        win.webContents.getURL().startsWith('https://www.douyin.com/')
      )!.id
  )
  expect((await invoke('releaseEngine')).ok).toBe(true)
  expect((await invoke('snapshot')).data.engine.status).toBe('stopped')
  expect(
    await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter((win) =>
          win.webContents.getURL().startsWith('https://www.douyin.com/')
        ).length
    )
  ).toBe(0)
  expect((await invoke('probe', { accountId })).ok).toBe(true)
  expect(
    await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().find((win) =>
          win.webContents.getURL().startsWith('https://www.douyin.com/')
        )!.id
    )
  ).not.toBe(engineId)
  await app.close()
  await launch()
  expect((await invoke('snapshot')).data.activeAccountId).toBe(accountId)
  expect(
    await app.evaluate(async ({ session }, accountId) => {
      const cookies = await session
        .fromPartition(`persist:mylike-${accountId}`)
        .cookies.get({ name: 'mylike_fixture_login' })
      return cookies.some((cookie) => cookie.value === 'controlled-session-only')
    }, accountId)
  ).toBe(true)
  await installPlatform(accountId)
  expect((await invoke('probe', { accountId })).ok).toBe(true)
})

test('retries a page navigation during collection without treating it as a user stop', async () => {
  const accountId = await addAccount()
  await installPlatform(accountId)
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeSlowFirstIdentity = true
  })
  await invoke('collectionStart', { accountId, mode: 'update' })
  await expect
    .poll(() =>
      app.evaluate(() =>
        ((globalThis as any).__mylikeTestCalls as string[]).some((url) => url.includes('/profile/self/'))
      )
    )
    .toBe(true)
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().startsWith('https://www.douyin.com/'))!
      .webContents.reload()
  })
  await expect
    .poll(async () => (await invoke('snapshot')).data.collection?.status, { timeout: 25000 })
    .toBe('completed')
  expect((await invoke('snapshot')).data.collection).toMatchObject({ pages: 3, added: 1, errorCode: null })
})

test('keeps a 50k library virtualized and deletes exactly the selected snapshot while preserving other accounts', async ({}, info) => {
  test.setTimeout(testTimeout(60000))
  const accountId = await addAccount(),
    other = (await invoke('createAccount', { name: '隔离测试账号' })).data.id
  await invoke('switchAccount', { accountId })
  await app.evaluate(
    async ({ app }, { accountId, other }) => {
      const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite'),
        { join } = process.getBuiltinModule('node:path') as typeof import('node:path')
      const db = new DatabaseSync(join(app.getPath('userData'), 'mylike.sqlite'))
      db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;')
      try {
        const work = db.prepare('INSERT INTO works VALUES(?,?,?,?,?,?,?)'),
          member = db.prepare('INSERT INTO account_items(accountId,workId,firstSeen) VALUES(?,?,?)')
        for (let i = 0; i < 50000; i++) {
          const id = String(8000000000000000n + BigInt(i))
          work.run(
            id,
            `第 ${i} 条 · ${i % 10 === 0 ? '旅行' : '日常'}`,
            '示例作者',
            +new Date(2024, i % 12, 1) / 1000,
            null,
            i % 2 ? 'gallery' : 'video',
            0
          )
          member.run(accountId, id, i)
        }
        member.run(other, '8000000000000000', 0)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      } finally {
        db.close()
      }
    },
    { accountId, other }
  )
  const firstQueryStart = performance.now()
  expect((await invoke('query', { accountId })).data.total).toBe(50000)
  console.log('50k first worker + IPC query ms:', Math.round(performance.now() - firstQueryStart))
  await page.reload()
  await expect(page.locator('.list-caption')).toContainText('50000 条内容')
  expect(await page.locator('.work-card').count()).toBeLessThan(100)
  const durations: number[] = []
  for (let i = 0; i < 20; i++) {
    const begin = performance.now()
    expect(
      (
        await invoke('query', {
          accountId,
          search: i % 2 ? '旅行' : '',
          sort: i % 2 ? 'collected' : 'published'
        })
      ).ok
    ).toBe(true)
    durations.push(performance.now() - begin)
  }
  console.log('50k worker + IPC query p95 ms:', Math.round(durations.sort((a, b) => a - b)[18]!))
  await chooseOption('月份筛选', '2 月')
  await expect(page.locator('.list-caption')).toContainText('4167 条内容')
  await chooseOption('月份筛选', '全部月份')
  await expect(page.getByLabel('内容排序')).toHaveCount(0)
  await expect(page.locator('.list-caption')).toContainText('50000 条内容')
  await page.getByRole('button', { name: '批量选择', exact: true }).click()
  await page.getByRole('button', { name: '选择全部筛选结果', exact: true }).click()
  await expect(page.getByText('已选 50000 条', { exact: true })).toBeVisible()
  await installPlatform(accountId)
  expect((await invoke('collectPage', { accountId, continue: false })).ok).toBe(true)
  await expect(page.getByText('内容有更新，清空选择后刷新。')).toBeVisible()
  await expect(page.getByText('已选 50000 条', { exact: true })).toBeVisible()
  await expect(page.locator('.list-caption')).toContainText('50000 条内容')
  const frozenHeight = await page
    .locator('.virtual-grid')
    .evaluate((node) => node.getBoundingClientRect().height)
  await scrollLibraryToEnd()
  await expect(page.locator('.library-load-status')).toContainText('清空选择后继续加载')
  await page.waitForTimeout(250)
  expect(await page.locator('.virtual-grid').evaluate((node) => node.getBoundingClientRect().height)).toBe(
    frozenHeight
  )
  await screenshot(info.outputPath('library-selection-50k.png'))
  await installMedia()
  await page.getByRole('button', { name: '播放所选', exact: true }).click()
  await expect.poll(async () => (await invoke('snapshot')).data.playback?.total).toBe(50000)
  await page.getByRole('button', { name: '显示播放队列', exact: true }).click()
  await expect(page.getByRole('button', { name: '播放队列第 1 条', exact: true })).toBeVisible()
  expect(await page.locator('.queue-row').count()).toBeLessThan(100)
  const tail = (
    await invoke('queueItems', {
      accountId,
      queueId: (await invoke('snapshot')).data.playback.queueId,
      offset: 49950,
      limit: 50
    })
  ).data
  expect(tail.items).toHaveLength(50)
  expect(tail.items.some((item: any) => item.work.id === workId)).toBe(false)
  await page.getByRole('button', { name: '返回内容库', exact: true }).click()
  await expect(page.getByText('已选 50000 条', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '删除本地条目', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '删除本地条目' })).toContainText('50000 条记录')
  await screenshot(info.outputPath('local-delete-confirm.png'))
  await page.getByRole('button', { name: '确认删除本地条目', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.list-caption')).toContainText('1 条内容')
  expect((await invoke('query', { accountId: other })).data.total).toBe(1)
  expect((await invoke('query', { accountId })).data.items[0].id).toBe(workId)
})

test('persists playback position and preferences across restart and suppresses resume after natural completion', async () => {
  test.setTimeout(testTimeout(60000))
  const { accountId } = await prepareQueue(1)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('自动连播').uncheck()
  await chooseOption('播放 / 暂停快捷键', 'K')
  await expect
    .poll(async () => (await invoke('snapshot')).data.playbackPreferences.shortcuts.playPause)
    .toBe('KeyK')
  await page.getByRole('button', { name: '喜欢的内容', exact: true }).click()
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await readyVideo()
  await page.keyboard.press('k')
  await expect
    .poll(() => page.locator('video').evaluate((node) => (node as HTMLVideoElement).paused))
    .toBe(true)
  await page.getByLabel('音量').focus()
  await page.keyboard.press('ArrowRight')
  await page.getByRole('button', { name: '倍速', exact: true }).click()
  await page.getByRole('menuitemradio', { name: '1.5x', exact: true }).click()
  await expect.poll(async () => (await invoke('snapshot')).data.playbackPreferences.volume).toBeCloseTo(0.75)
  await seekVideo(2.25)
  await expect
    .poll(() => page.locator('video').evaluate((node) => (node as HTMLVideoElement).currentTime))
    .toBeCloseTo(2.25, 1)
  await page.getByRole('button', { name: '返回内容库', exact: true }).click()
  await expect(page.getByRole('button', { name: '继续回看', exact: true })).toBeVisible()
  const saved = (await invoke('snapshot')).data.playback
  expect(saved.position.seconds).toBeCloseTo(2.25, 1)
  await app.close()
  await launch()
  expect((await invoke('snapshot')).data).toMatchObject({
    activeAccountId: accountId,
    playback: { queueId: saved.queueId, index: 0, completed: false },
    playbackPreferences: { volume: 0.75, speed: 1.5 }
  })
  expect((await invoke('snapshot')).data.playback.position.seconds).toBeCloseTo(2.25, 1)
  expect((await invoke('snapshot')).data.engine.status).toBe('stopped')
  await installPlatform(accountId)
  await installMedia()
  await page.getByRole('button', { name: '继续回看', exact: true }).click()
  await readyVideo()
  await expect
    .poll(() => page.locator('video').evaluate((node) => (node as HTMLVideoElement).currentTime))
    .toBeGreaterThan(2)
  // Pause through the configured shortcut before the short fixture can finish
  // while navigation is animating; pause-button interaction is covered separately.
  await page.keyboard.press('k')
  await expect
    .poll(() => page.locator('video').evaluate((node) => (node as HTMLVideoElement).paused))
    .toBe(true)
  await seekVideo(2.75)
  await expect
    .poll(() => page.locator('video').evaluate((node) => (node as HTMLVideoElement).seeking))
    .toBe(false)
  await app.close()
  await launch()
  expect((await invoke('snapshot')).data.playback.position.seconds).toBeCloseTo(2.75, 1)
  const preferences = (await invoke('snapshot')).data.playbackPreferences
  await invoke('playbackPreferences', { preferences: { ...preferences, continuous: true } })
  await installPlatform(accountId)
  await installMedia()
  await page.getByRole('button', { name: '继续回看', exact: true }).click()
  await readyVideo()
  await seekVideo({ fromEnd: 0.1 }, true)
  await expect.poll(async () => (await invoke('snapshot')).data.playback.completed).toBe(true)
  await page.getByRole('button', { name: '返回内容库', exact: true }).click()
  await expect(page.getByRole('button', { name: '继续回看', exact: true })).toHaveCount(0)
  await app.close()
  await launch()
  expect((await invoke('snapshot')).data.playback.completed).toBe(true)
  await expect(page.getByRole('button', { name: '继续回看', exact: true })).toHaveCount(0)
})

test('promotes the pending next-item prefetch without cancelling or repeating its detail request', async () => {
  const { ids } = await prepareQueue(3)
  await app.evaluate((_electron, id) => {
    ;(globalThis as any).__mylikeHoldDetailOnce = id
  }, ids[1]!)
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await readyVideo()
  const count = () =>
    app.evaluate(
      (_electron, id) =>
        ((globalThis as any).__mylikeTestCalls as string[]).filter(
          (url) => url.includes('/aweme/detail/') && new URL(url).searchParams.get('aweme_id') === id
        ).length,
      ids[1]!
    )
  await expect.poll(count).toBe(1)
  await page.getByRole('button', { name: '下一条', exact: true }).click()
  await expect(page.locator('.player-queue-position')).toHaveText('2 / 3')
  await app.evaluate(() => {
    ;(globalThis as any).__releaseHeldDetail?.()
  })
  await readyVideo(1)
  expect(await count()).toBe(1)
  await expect(page.getByRole('region', { name: '播放器' })).not.toContainText('暂时无法播放')
})

test('promotes a queued next-item read when advancing while a different media read owns the lane', async () => {
  const { accountId, ids } = await prepareQueue(3)
  const queue = (await invoke('queueCreate', { accountId, source: { type: 'ids', ids }, mode: 'sequence' }))
    .data
  await app.evaluate((_electron, id) => {
    ;(globalThis as any).__mylikeHoldDetailOnce = id
  }, queue.work.id)
  const first = invoke('media', {
    accountId,
    workId: queue.work.id,
    playback: { queueId: queue.queueId, revision: queue.revision }
  })
  await expect.poll(() => app.evaluate(() => typeof (globalThis as any).__releaseHeldDetail)).toBe('function')
  const pending = invoke('media', {
    accountId,
    workId: queue.next.id,
    playback: { queueId: queue.queueId, revision: queue.revision }
  })
  await invoke('queueMove', { accountId, queueId: queue.queueId, target: 'next' })
  await app.evaluate(() => {
    ;(globalThis as any).__releaseHeldDetail?.()
  })
  expect((await first).error.code).toBe('CANCELLED')
  expect((await pending).data.work.id).toBe(queue.next.id)
  expect((await invoke('snapshot')).data.playback.work.id).toBe(queue.next.id)
})

test('reuses the decoded next video without a second CDN request and releases detached warmups on exit', async ({}, info) => {
  test.setTimeout(testTimeout(60000))
  const { ids } = await prepareQueue(3)
  const preferences = (await invoke('snapshot')).data.playbackPreferences
  await invoke('playbackPreferences', { preferences: { ...preferences, continuous: false } })
  await app.evaluate(() => {
    ;(globalThis as any).__mediaResponseDelayMs = 900
  })
  await page.evaluate(() => {
    const create = document.createElement.bind(document)
    ;(window as any).__createdVideos = []
    ;(document as any).createElement = (tag: string, ...args: unknown[]) => {
      const node = (create as any)(tag, ...args)
      if (tag === 'video') (window as any).__createdVideos.push(node)
      return node
    }
  })
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await readyVideo(0)
  await page.getByRole('button', { name: '暂停播放', exact: true }).click()
  const source = `https://fixture.douyinvod.com/video-${ids[1]}.mp4`
  await expect
    .poll(() =>
      page.evaluate((source) => {
        const node = (window as any).__createdVideos.find((v: HTMLVideoElement) => v.src === source)
        if (node?.readyState >= 2) (window as any).__preparedNext = node
        return (
          !!node &&
          !node.isConnected &&
          node.paused &&
          node.muted &&
          node.volume === 0 &&
          node.readyState >= 2
        )
      }, source)
    )
    .toBe(true)
  const count = () =>
    app.evaluate(
      (_electron, source) =>
        ((globalThis as any).__mediaRequests as string[]).filter((url) => url === source).length,
      source
    )
  const before = await count()
  // Measure an actual visible compositor, not Chromium's hidden-window frame throttle.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().startsWith('mylike://ui/'))!
      .showInactive()
  })
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  )
  await page.evaluate(() => {
    const node = (window as any).__preparedNext as HTMLVideoElement
    const at = performance.now()
    const observer = new MutationObserver(() => {
      if (!node.isConnected) return
      ;(window as any).__nextFrame = { ready: node.readyState, mountedMs: performance.now() - at }
      node.requestVideoFrameCallback(() => {
        ;(window as any).__nextFrame.paintedMs = performance.now() - at
      })
      observer.disconnect()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    document.querySelector<HTMLButtonElement>('[aria-label="下一条"]')!.click()
  })
  await readyVideo(1)
  await expect.poll(() => page.evaluate(() => (window as any).__nextFrame?.paintedMs ?? 0)).toBeGreaterThan(0)
  const frame = await page.evaluate(() => (window as any).__nextFrame)
  console.log('Prepared next frame:', JSON.stringify(frame))
  expect(frame.ready).toBeGreaterThanOrEqual(2)
  expect(frame.mountedMs).toBeLessThan(process.env.CI ? 750 : 300)
  expect(frame.paintedMs).toBeLessThan(process.env.CI ? 1000 : 400)
  expect(await count()).toBe(before)
  expect(await page.evaluate(() => document.querySelector('video') === (window as any).__preparedNext)).toBe(
    true
  )
  expect(
    await page
      .locator('video')
      .evaluate((v) => ({ muted: (v as HTMLVideoElement).muted, volume: (v as HTMLVideoElement).volume }))
  ).toEqual({ muted: false, volume: preferences.volume })
  await screenshot(info.outputPath('prepared-next.png'))
  await page.getByRole('button', { name: '返回内容库', exact: true }).click()
  // Leaving playback hides the accessible region before IPC flush and unmount.
  // Wait for disposal itself, rather than treating aria-hidden as completion.
  await expect(page.locator('.player-view')).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__createdVideos.every(
          (v: HTMLVideoElement) => !v.isConnected && v.paused && !v.getAttribute('src')
        )
      )
    )
    .toBe(true)
})

test('keeps clean screen across tracks and restores the queue, layout and fullscreen without resizing controls', async ({}, info) => {
  await prepareQueue(3)
  const preferences = (await invoke('snapshot')).data.playbackPreferences
  await invoke('playbackPreferences', {
    preferences: { ...preferences, continuous: false, shortcuts: { ...preferences.shortcuts, clean: 'KeyB' } }
  })
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await readyVideo(0)
  await page.getByRole('button', { name: '暂停播放', exact: true }).click()
  await page.getByRole('button', { name: '显示播放队列', exact: true }).click()
  const original = await page.locator('.player-footer').evaluate((node) => {
    const controls = document.querySelector('.playback-controls')!.getBoundingClientRect()
    const box = node.getBoundingClientRect()
    return {
      height: box.height,
      clearance: box.bottom - controls.bottom,
      buttonHeight: document.querySelector('[aria-label="下一条"]')!.getBoundingClientRect().height
    }
  })
  expect(original.clearance).toBeGreaterThanOrEqual(8)
  expect(original.buttonHeight).toBe(26)
  await page.getByRole('checkbox', { name: '清屏', exact: true }).check()
  for (const selector of ['.player-footer', '.player-heading', '.media-caption', '.queue-panel'])
    await expect(page.locator(selector)).toBeHidden()
  await expect(page.getByRole('region', { name: '播放器', exact: true }).getByRole('button')).toHaveCount(0)
  await page.keyboard.press('ArrowDown')
  await readyVideo(1)
  await expect(page.getByRole('region', { name: '播放器', exact: true }).getByRole('button')).toHaveCount(0)
  await expect(page.locator('.player-footer')).toBeHidden()
  await screenshot(info.outputPath('clean-screen.png'))
  await page.keyboard.press('Escape')
  await expect(page.getByRole('complementary', { name: '播放队列' })).toBeVisible()
  expect(await page.locator('.player-footer').evaluate((node) => node.getBoundingClientRect().height)).toBe(
    original.height
  )
  await page.keyboard.press('f')
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true)
  await page.keyboard.press('b')
  await expect(page.locator('.player-footer')).toBeHidden()
  await page.keyboard.press('Escape')
  await expect(page.locator('.player-footer')).toBeVisible()
  expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(true)
  await page.keyboard.press('Escape')
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false)
  await page.keyboard.press('b')
  await page.keyboard.press('b')
  await expect(page.locator('.player-footer')).toBeVisible()
})

test('mixes live original audio with gallery music and controls both through pause, mute and speed', async () => {
  await prepareQueue(2, true)
  const preferences = (await invoke('snapshot')).data.playbackPreferences
  await invoke('playbackPreferences', { preferences: { ...preferences, continuous: false } })
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await readyVideo(0)
  const sound = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('video,audio')).map((v) => ({
        volume: (v as HTMLMediaElement).volume,
        muted: (v as HTMLMediaElement).muted,
        paused: (v as HTMLMediaElement).paused,
        rate: (v as HTMLMediaElement).playbackRate
      }))
    )
  await expect.poll(sound).toEqual([
    { volume: preferences.volume, muted: false, paused: false, rate: 1 },
    { volume: preferences.volume, muted: false, paused: false, rate: 1 }
  ])
  await page.keyboard.press('n')
  await expect.poll(async () => (await sound()).map((v) => v.volume)).toEqual([0, 0])
  await page.keyboard.press('n')
  await page.getByRole('button', { name: '倍速', exact: true }).click()
  await page.getByRole('menuitemradio', { name: '1.5x', exact: true }).click()
  await expect.poll(async () => (await sound()).map((v) => v.rate)).toEqual([1.5, 1.5])
  await page.getByRole('button', { name: '暂停播放', exact: true }).click()
  await expect.poll(async () => (await sound()).map((v) => v.paused)).toEqual([true, true])
  await page.getByRole('button', { name: '开始播放', exact: true }).click()
  await expect.poll(async () => (await sound()).map((v) => v.paused)).toEqual([false, false])
})

test('keeps the latest track during rapid moves and opens comments externally while preserving paused playback', async ({}, info) => {
  test.setTimeout(testTimeout(60000))
  const { accountId, ids } = await prepareQueue(5)
  const preferences = (await invoke('snapshot')).data.playbackPreferences
  await invoke('playbackPreferences', { preferences: { ...preferences, continuous: false } })
  await app.evaluate((_electron, id) => {
    ;(globalThis as any).__mylikeDelayDetail = id
  }, ids[3]!)
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await readyVideo()
  await page.getByRole('button', { name: '下一条', exact: true }).click()
  await page.getByRole('button', { name: '下一条', exact: true }).click()
  await expect.poll(async () => (await invoke('snapshot')).data.playback.index).toBe(2)
  await readyVideo(2)
  await expect(page.locator('video')).toHaveAttribute(
    'src',
    `https://fixture.douyinvod.com/video-${ids[2]}.mp4`
  )
  await page.evaluate(() => {
    ;(window as any).__oldQueueMedia = [...document.querySelectorAll('video,audio')]
  })
  await app.evaluate(({ shell }) => {
    ;(globalThis as any).__externalUrls = []
    shell.openExternal = async (url) => {
      ;(globalThis as any).__externalUrls.push(url)
    }
  })
  await page.getByRole('button', { name: '打开原页', exact: true }).click()
  await expect
    .poll(() => app.evaluate(() => (globalThis as any).__externalUrls))
    .toEqual(['https://www.douyin.com/video/' + ids[2]])
  expect(
    await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter((win) => win.webContents.getURL().includes('/video/')).length
    )
  ).toBe(0)
  await expect
    .poll(() => page.locator('video').evaluate((node) => (node as HTMLVideoElement).paused))
    .toBe(true)
  const saved = (await invoke('snapshot')).data.playback.position.seconds
  expect(saved).toBeGreaterThanOrEqual(0)
  await page.getByRole('button', { name: '开始播放', exact: true }).click()
  await expect
    .poll(() => page.locator('video').evaluate((node) => (node as HTMLVideoElement).paused))
    .toBe(false)
  await page.getByRole('button', { name: '打开原页', exact: true }).click()
  await expect.poll(() => app.evaluate(() => (globalThis as any).__externalUrls.length)).toBe(2)
  await page.getByRole('button', { name: '下一条', exact: true }).click()
  await readyVideo(3)
  await page.getByRole('button', { name: '暂停播放', exact: true }).click()
  expect(
    (
      await invoke('original', {
        accountId,
        workId: ids[2],
        playback: { queueId: '00000000-0000-4000-8000-000000000000', revision: 0 }
      })
    ).error.code
  ).toBe('QUEUE_CHANGED')
  expect((await invoke('original', { accountId, workId: 'file:///tmp/test' })).error.code).toBe(
    'INVALID_INPUT'
  )
  expect(await app.evaluate(() => (globalThis as any).__externalUrls.length)).toBe(2)
  await app.evaluate(({ shell }) => {
    shell.openExternal = async () => {
      throw Error('no handler')
    }
  })
  await page.getByRole('button', { name: '打开原页', exact: true }).click()
  await expect(page.getByRole('region', { name: '播放器', exact: true })).toContainText(
    '无法打开系统默认浏览器'
  )
  await expect(page.locator('video')).toHaveAttribute(
    'src',
    `https://fixture.douyinvod.com/video-${ids[1]}.mp4`
  )
  expect(await page.locator('video').evaluate((node) => (node as HTMLVideoElement).paused)).toBe(true)
  expect(
    await page.evaluate(() =>
      (window as any).__oldQueueMedia.every(
        (node: HTMLMediaElement) => node.paused && !node.getAttribute('src')
      )
    )
  ).toBe(true)
  await page.getByRole('button', { name: '显示播放队列', exact: true }).click()
  await expect(page.getByRole('complementary', { name: '播放队列', exact: true })).toBeVisible()
  await screenshot(info.outputPath('playback-queue.png'))
  const mainId = await app.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith('mylike://ui/'))!.id
  )
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.showInactive(), mainId)
  try {
    await page.getByRole('button', { name: '全屏', exact: true }).click()
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true)
    await page.keyboard.press('Escape')
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false)
    await expect(page.getByRole('region', { name: '播放器', exact: true })).toBeVisible()
  } finally {
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.hide(), mainId)
  }
})

test('resumes a gallery slide and music position, then automatically advances without restarting music between slides', async () => {
  test.setTimeout(testTimeout(60000))
  await prepareQueue(2, true)
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await readyVideo()
  await page.evaluate(() => {
    ;(window as any).__galleryMusic = document.querySelector('audio')
  })
  await expect(page.getByAltText('图集第 2 张')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__galleryMusic === document.querySelector('audio'))).toBe(
    true
  )
  await page.getByRole('button', { name: '返回内容库', exact: true }).click()
  const saved = (await invoke('snapshot')).data.playback
  expect(saved.position.slide).toBe(1)
  expect(saved.position.musicSeconds).toBeGreaterThan(0)
  await page.getByRole('button', { name: '继续回看', exact: true }).click()
  await expect(page.getByAltText('图集第 2 张')).toBeVisible()
  await expect
    .poll(() => page.locator('audio').evaluate((node) => (node as HTMLAudioElement).currentTime))
    .toBeGreaterThanOrEqual(Math.max(0, saved.position.musicSeconds - 0.2))
  await expect.poll(async () => (await invoke('snapshot')).data.playback.index, { timeout: 20000 }).toBe(1)
  await readyVideo(1)
  await page.getByRole('button', { name: '暂停播放', exact: true }).click()
})

test('loops the current video and keeps the queue open across next, jump, wheel and automatic advance', async () => {
  test.setTimeout(testTimeout(60000))
  await prepareQueue(6)
  await delayPlaybackTransitions()
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await readyVideo(0)
  await page.getByRole('checkbox', { name: '连播', exact: true }).uncheck()
  const before = (await invoke('snapshot')).data.playback
  await page.getByRole('button', { name: '显示播放队列', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '播放队列', exact: true })
  await page.locator('video').evaluate((node) => {
    ;(window as any).__loopVideo = node
  })
  await seekVideo({ fromEnd: 0.15 }, true)
  await expect
    .poll(() => page.locator('video').evaluate((node) => (node as HTMLVideoElement).currentTime))
    .toBeLessThan(1.5)
  expect((await invoke('snapshot')).data.playback).toMatchObject({
    queueId: before.queueId,
    revision: before.revision,
    index: 0,
    completed: false
  })
  expect(await page.evaluate(() => document.querySelector('video') === (window as any).__loopVideo)).toBe(
    true
  )
  await expect(panel).toBeVisible()
  await changeVideo(() => page.getByRole('button', { name: '下一条', exact: true }).click(), 1)
  await expect(panel).toBeVisible()
  await changeVideo(() => panel.getByRole('button', { name: '播放队列第 3 条', exact: true }).click(), 2)
  await expect(panel).toBeVisible()
  await page.locator('.stage').hover({ position: { x: 100, y: 100 } })
  await changeVideo(() => page.mouse.wheel(0, 240), 3)
  await expect(panel).toBeVisible()
  await page.getByRole('checkbox', { name: '连播', exact: true }).check()
  await changeVideo(() => seekVideo({ fromEnd: 0.1 }, true), 4)
  await expect(panel).toBeVisible()
  await page.getByRole('button', { name: '收起播放队列', exact: true }).click()
  await expect(panel).toHaveCount(0)
})

test('keeps the same fullscreen container through buttons, queue jumps, wheel, automatic advance and replay', async () => {
  test.setTimeout(testTimeout(90000))
  await prepareQueue(6)
  await delayPlaybackTransitions()
  const preferences = (await invoke('snapshot')).data.playbackPreferences
  await invoke('playbackPreferences', { preferences: { ...preferences, continuous: false } })
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await readyVideo(0)
  const id = await app.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith('mylike://ui/'))!.id
  )
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.showInactive(), id)
  try {
    await page.getByRole('button', { name: '全屏', exact: true }).click()
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement?.className))
      .toContain('player-shell')
    await page.evaluate(() => {
      ;(window as any).__fullscreenNode = document.fullscreenElement
    })
    const stillFullscreen = async () => {
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              !!document.fullscreenElement && document.fullscreenElement === (window as any).__fullscreenNode
          )
        )
        .toBe(true)
      await expect(page.getByRole('button', { name: '退出全屏', exact: true })).toBeVisible()
    }
    await changeVideo(() => page.getByRole('button', { name: '下一条', exact: true }).click(), 1)
    await stillFullscreen()
    await changeVideo(() => page.getByRole('button', { name: '上一条', exact: true }).click(), 0)
    await stillFullscreen()
    await page.getByRole('button', { name: '显示播放队列', exact: true }).click()
    await changeVideo(() => page.getByRole('button', { name: '播放队列第 3 条', exact: true }).click(), 2)
    await stillFullscreen()
    await page.locator('.stage').hover({ position: { x: 100, y: 100 } })
    await changeVideo(() => page.mouse.wheel(0, 240), 3)
    await stillFullscreen()
    await page.getByRole('checkbox', { name: '连播', exact: true }).check()
    await changeVideo(() => seekVideo({ fromEnd: 0.1 }, true), 4)
    await stillFullscreen()
    await changeVideo(() => page.getByRole('button', { name: '播放队列第 6 条', exact: true }).click(), 5)
    await seekVideo({ fromEnd: 0.1 }, true)
    await expect.poll(async () => (await invoke('snapshot')).data.playback.completed).toBe(true)
    await expect(page.getByRole('button', { name: '重新播放当前作品', exact: true })).toBeVisible()
    await readyVideo(5)
    await stillFullscreen()
    await changeVideo(() => page.getByRole('button', { name: '重新播放当前作品', exact: true }).click(), 5)
    await stillFullscreen()
    await page.getByRole('button', { name: '返回内容库', exact: true }).click()
    await expect(page.getByRole('heading', { name: '喜欢的内容', exact: true })).toBeVisible()
    expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(false)
    await expect(page.locator('video,audio')).toHaveCount(0)
  } finally {
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.hide(), id)
  }
})

test('puts search above playback actions, removes decorative copy and returns smoothly without rebuilding or moving the library', async ({}, info) => {
  test.setTimeout(testTimeout(60000))
  await prepareQueue(80)
  await page.getByLabel('搜索内容', { exact: true }).fill('队列作品')
  await chooseOption('年份筛选', '2023 年')
  await chooseOption('月份筛选', '11 月')
  await expect(page.locator('.list-caption')).toContainText('80 条内容')
  await expect(page.getByLabel('内容排序')).toHaveCount(0)
  expect(await page.getByLabel('搜索内容').evaluate((node) => !!node.closest('.page-header'))).toBe(true)
  for (const name of ['顺序播放', '洗牌播放'])
    expect(
      await page.getByRole('button', { name, exact: true }).evaluate((node) => !!node.closest('.filter-bar'))
    ).toBe(true)
  await expect(page.locator('main')).not.toContainText(
    /YOUR COLLECTION|把喜欢整理好|重新遇见|个人喜欢内容管理|本地数据就绪/
  )
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const id = await app.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith('mylike://ui/'))!.id
  )
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.showInactive(), id)
  try {
    await page.locator('.library-scroll').evaluate((node) => {
      node.scrollTop = 600
      ;(window as any).__libraryNode = node
    })
    await expect.poll(() => page.locator('.library-scroll').evaluate((node) => node.scrollTop)).toBe(600)
    await screenshot(info.outputPath('library-clean.png'))
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.showInactive(), id)
    await page.getByRole('button', { name: '顺序播放', exact: true }).click()
    await readyVideo()
    await expect
      .poll(() => page.locator('.player-shell').evaluate((node) => getComputedStyle(node).opacity))
      .toBe('1')
    await page.evaluate(() => {
      const samples: { width: number; opacity: number }[] = []
      ;(window as any).__returnFrames = samples
      const frame = document.querySelector('.player-shell')!
      const until = performance.now() + 650
      const sample = () => {
        samples.push({
          width: frame.getBoundingClientRect().width,
          opacity: Number(getComputedStyle(frame).opacity)
        })
        if (performance.now() < until) requestAnimationFrame(sample)
      }
      sample()
    })
    await page.getByRole('button', { name: '返回内容库', exact: true }).click()
    await expect(page.getByRole('heading', { name: '喜欢的内容', exact: true })).toBeVisible()
    const samples = await page.evaluate(
      () => (window as any).__returnFrames as { width: number; opacity: number }[]
    )
    expect(samples.some((sample) => sample.opacity > 0.05 && sample.opacity < 0.95)).toBe(true)
    expect(
      Math.max(...samples.map((sample) => sample.width)) - Math.min(...samples.map((sample) => sample.width))
    ).toBeLessThan(1)
    expect(
      await page.locator('.library-scroll').evaluate((node) => node === (window as any).__libraryNode)
    ).toBe(true)
    await expect.poll(() => page.locator('.library-scroll').evaluate((node) => node.scrollTop)).toBe(600)
    await expect(page.getByLabel('搜索内容')).toHaveValue('队列作品')
    await expect(page.getByRole('combobox', { name: '年份筛选', exact: true })).toHaveText('2023 年')
    await expect(page.getByRole('combobox', { name: '月份筛选', exact: true })).toHaveText('11 月')
    await expect(page.locator('video,audio')).toHaveCount(0)
    await screenshot(info.outputPath('library-return.png'))
  } finally {
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.hide(), id)
  }
})

test('cycles galleries with live holds and three-second static images, looping music and pinning manual changes', async ({}, info) => {
  test.setTimeout(testTimeout(60000))
  await prepareQueue(2, true)
  const preferences = (await invoke('snapshot')).data.playbackPreferences
  await invoke('playbackPreferences', { preferences: { ...preferences, continuous: false, speed: 2 } })
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await readyVideo()
  const first = Date.now()
  await expect(page.getByAltText('图集第 2 张')).toBeVisible()
  expect(Date.now() - first).toBeGreaterThan(2000) // slideshow timing is independent of music speed
  await readyVideo() // wraps from second image to the first live image
  expect((await invoke('snapshot')).data.playback).toMatchObject({ index: 0, completed: false })
  expect(await page.locator('audio').evaluate((node) => (node as HTMLAudioElement).loop)).toBe(true)
  await page.getByRole('button', { name: '下一张', exact: true }).click()
  await expect(page.getByAltText('图集第 2 张')).toBeVisible()
  await page.getByRole('checkbox', { name: '连播', exact: true }).check()
  await page.waitForTimeout(6500) // longer than both image dwell and music duration
  await expect(page.getByAltText('图集第 2 张')).toBeVisible()
  expect((await invoke('snapshot')).data.playback).toMatchObject({ index: 0, completed: false })
  const arrows = await page.evaluate(() => ({
    previous: document.querySelector('.previous-image')!.getBoundingClientRect().x,
    next: document.querySelector('.next-image')!.getBoundingClientRect().right,
    width: document.querySelector('.stage')!.getBoundingClientRect().width
  }))
  expect(arrows.previous).toBeLessThan(50)
  expect(arrows.next).toBeGreaterThan(arrows.width - 50)
  await screenshot(info.outputPath('gallery-pinned.png'))
  await page.getByRole('button', { name: '恢复轮播', exact: true }).click()
  await expect.poll(async () => (await invoke('snapshot')).data.playback.index, { timeout: 15000 }).toBe(1)
})

test('shows the matching still photo for two seconds after a live clip, pauses the rest and cancels it on manual navigation', async ({}, info) => {
  test.setTimeout(testTimeout(60000))
  await prepareQueue(2, true, true)
  const preferences = (await invoke('snapshot')).data.playbackPreferences
  await invoke('playbackPreferences', { preferences: { ...preferences, continuous: false, speed: 2 } })
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await readyVideo()
  await page.locator('video').evaluate((node) => {
    const timing = { ended: 0, changed: 0 }
    ;(window as any).__autoLiveTiming = timing
    node.addEventListener(
      'ended',
      () => {
        timing.ended = performance.now()
      },
      { once: true }
    )
    const observer = new MutationObserver(() => {
      if (document.querySelector('.gallery-image')) {
        timing.changed = performance.now()
        observer.disconnect()
      }
    })
    observer.observe(document.querySelector('.stage')!, { childList: true, subtree: true })
  })
  await expect(page.getByAltText('图集第 2 张')).toBeVisible()
  const automaticHold = await page.evaluate(
    () => (window as any).__autoLiveTiming as { ended: number; changed: number }
  )
  expect(automaticHold.ended).toBeGreaterThan(0)
  expect(automaticHold.changed - automaticHold.ended).toBeGreaterThanOrEqual(1950)
  await page.getByRole('button', { name: '上一张', exact: true }).click()
  await readyVideo()
  await page.locator('video').evaluate((node) => {
    const v = node as HTMLVideoElement
    ;(window as any).__liveEvents = []
    ;(window as any).__liveMusic = document.querySelector('audio')
    v.addEventListener('ended', () =>
      (window as any).__liveEvents.push({ type: 'ended', at: performance.now() })
    )
    v.addEventListener('playing', () =>
      (window as any).__liveEvents.push({ type: 'playing', at: performance.now() })
    )
  })
  await seekVideo({ fromEnd: 0.1 })
  await expect
    .poll(() => page.locator('video').evaluate((node) => (node as HTMLVideoElement).ended))
    .toBe(true)
  await expect(page.locator('video')).toHaveClass('live-resting')
  await expect
    .poll(() => page.locator('.live-poster').evaluate((node) => getComputedStyle(node).opacity))
    .toBe('1')
  expect(await page.locator('.live-poster').getAttribute('src')).toBe('https://fixture.douyinpic.com/1.svg')
  await expect(page.getByRole('button', { name: '暂停播放', exact: true })).toBeVisible()
  expect(await page.locator('audio').evaluate((node) => (node as HTMLAudioElement).paused)).toBe(false)
  await expect
    .poll(() =>
      page.evaluate(() => {
        const events = (window as any).__liveEvents as { type: string; at: number }[]
        const ended = events.find((event) => event.type === 'ended')
        return !!ended && events.some((event) => event.type === 'playing' && event.at > ended.at)
      })
    )
    .toBe(true)
  const hold = await page.evaluate(() => {
    const events = (window as any).__liveEvents as { type: string; at: number }[]
    const ended = events.find((event) => event.type === 'ended')!
    return events.find((event) => event.type === 'playing' && event.at > ended.at)!.at - ended.at
  })
  expect(hold).toBeGreaterThanOrEqual(1950)
  expect(hold).toBeLessThan(3200)
  expect(await page.evaluate(() => document.querySelector('audio') === (window as any).__liveMusic)).toBe(
    true
  )
  await seekVideo({ fromEnd: 0.1 })
  await expect
    .poll(() => page.locator('video').evaluate((node) => (node as HTMLVideoElement).ended))
    .toBe(true)
  await page.getByRole('button', { name: '暂停播放', exact: true }).click()
  await page.waitForTimeout(2200)
  expect(await page.locator('video').evaluate((node) => (node as HTMLVideoElement).ended)).toBe(true)
  await expect(page.locator('video')).toHaveClass('live-resting')
  expect(await page.locator('audio').evaluate((node) => (node as HTMLAudioElement).paused)).toBe(true)
  await screenshot(info.outputPath('live-hold.png'))
  await page.getByRole('button', { name: '开始播放', exact: true }).click()
  await expect
    .poll(() => page.locator('video').evaluate((node) => (node as HTMLVideoElement).ended))
    .toBe(false)
  await seekVideo({ fromEnd: 0.1 })
  await expect
    .poll(() => page.locator('video').evaluate((node) => (node as HTMLVideoElement).ended))
    .toBe(true)
  await page.getByRole('button', { name: '下一张', exact: true }).click()
  await page.waitForTimeout(2300)
  await expect(page.getByAltText('图集第 2 张')).toBeVisible()
  expect((await invoke('snapshot')).data.playback).toMatchObject({ index: 0, completed: false })
})

test('uses the first motion frame when the still photo fails, keeping the live rest bounded and playable', async () => {
  await prepareQueue(1, true, true)
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeMissingPhoto = true
  })
  const preferences = (await invoke('snapshot')).data.playbackPreferences
  await invoke('playbackPreferences', { preferences: { ...preferences, continuous: false, speed: 2 } })
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await readyVideo()
  await page.getByRole('button', { name: '下一张', exact: true }).click()
  await page.getByRole('button', { name: '上一张', exact: true }).click()
  await readyVideo()
  await page.locator('video').evaluate((node) => {
    const v = node as HTMLVideoElement,
      timing = { ended: 0, resumed: 0 }
    ;(window as any).__fallbackTiming = timing
    v.addEventListener(
      'ended',
      () => {
        timing.ended = performance.now()
      },
      { once: true }
    )
    v.addEventListener('playing', () => {
      if (timing.ended && !timing.resumed) timing.resumed = performance.now()
    })
  })
  await seekVideo({ fromEnd: 0.1 })
  await expect.poll(() => page.evaluate(() => (window as any).__fallbackTiming.ended > 0)).toBe(true)
  await expect
    .poll(() =>
      page.locator('video').evaluate((node) => {
        const v = node as HTMLVideoElement
        return v.paused && v.currentTime < 0.1 && getComputedStyle(v).opacity === '1'
      })
    )
    .toBe(true)
  await expect(page.getByRole('button', { name: '暂停播放', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (window as any).__fallbackTiming.resumed > 0)).toBe(true)
  const timing = await page.evaluate(
    () => (window as any).__fallbackTiming as { ended: number; resumed: number }
  )
  expect(timing.resumed - timing.ended).toBeGreaterThanOrEqual(1950)
  expect((await invoke('snapshot')).data.playback.completed).toBe(false)
})

test('overlays expandable captions, selects speeds with a popup and highlights the seek rail without moving the layout', async ({}, info) => {
  test.setTimeout(testTimeout(60000))
  await prepareQueue(2, false, false, '这是用于验证超长文案展开和滚动的测试内容。'.repeat(130))
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await readyVideo()
  await page.getByRole('button', { name: '暂停播放', exact: true }).click()
  const geometry = await page.evaluate(() => {
    const stage = document.querySelector('.stage')!.getBoundingClientRect(),
      caption = document.querySelector('.media-caption')!.getBoundingClientRect(),
      footer = document.querySelector('.player-footer')!.getBoundingClientRect()
    return { stageBottom: stage.bottom, captionBottom: caption.bottom, footerTop: footer.top }
  })
  expect(geometry.captionBottom).toBeLessThanOrEqual(geometry.stageBottom + 0.5)
  expect(geometry.footerTop).toBeGreaterThanOrEqual(geometry.captionBottom - 0.5)
  await expect(page.locator('.caption-author')).toContainText('@测试作者')
  await expect(page.locator('.caption-author time')).toHaveAttribute('datetime', /2023-/)
  await page.getByRole('button', { name: '展开', exact: true }).click()
  await expect(page.locator('.caption-text')).toHaveClass(/expanded/)
  await page.locator('.caption-text p').hover()
  await page.mouse.wheel(0, 240)
  await expect
    .poll(() => page.locator('.caption-text p').evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0)
  expect((await invoke('snapshot')).data.playback.index).toBe(0)
  await page.getByRole('button', { name: '收起', exact: true }).click()
  await expect.poll(() => page.locator('.caption-text p').evaluate((node) => node.scrollTop)).toBe(0)
  const speed = page.getByRole('button', { name: '倍速', exact: true })
  await speed.click()
  await expect(page.getByRole('menuitemradio')).toHaveText([
    '0.75x',
    '1.0x',
    '1.25x',
    '1.5x',
    '1.75x',
    '2.0x',
    '3.0x'
  ])
  await page.getByRole('menuitemradio', { name: '1.75x', exact: true }).click()
  await expect
    .poll(() => page.locator('video').evaluate((node) => (node as HTMLVideoElement).playbackRate))
    .toBe(1.75)
  await expect.poll(async () => (await invoke('snapshot')).data.playbackPreferences.speed).toBe(1.75)
  await speed.click()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(speed).toHaveText('2.0x')
  await speed.click()
  await screenshot(info.outputPath('speed-menu.png'))
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.getByRole('region', { name: '播放器', exact: true })).toBeVisible()
  await page.locator('.stage').hover({ position: { x: 100, y: 100 } })
  await expect
    .poll(() => page.locator('.seek-track').evaluate((node) => node.getBoundingClientRect().height))
    .toBe(2)
  await screenshot(info.outputPath('seek-idle.png'))
  const slider = page.getByRole('slider', { name: '视频进度', exact: true }),
    box = (await slider.boundingBox())!
  await slider.hover()
  await expect
    .poll(() => page.locator('.seek-track').evaluate((node) => node.getBoundingClientRect().height))
    .toBe(6)
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect
    .poll(() =>
      page
        .locator('video')
        .evaluate((node) => (node as HTMLVideoElement).currentTime / (node as HTMLVideoElement).duration)
    )
    .toBeGreaterThan(0.65)
  await screenshot(info.outputPath('seek-hover.png'))
  await page.locator('.stage').hover({ position: { x: 100, y: 100 } })
  await expect
    .poll(() => page.locator('.seek-track').evaluate((node) => node.getBoundingClientRect().height))
    .toBe(2)
  expect(await page.locator('.player-footer').evaluate((node) => node.getBoundingClientRect().top)).toBe(
    geometry.footerTop
  )
  await expect(page.getByRole('button', { name: '展开左栏', exact: true })).toHaveCount(0)
  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((win) =>
      win.webContents.getURL().startsWith('mylike://ui/')
    )!
    main.setSize(920, 640)
    main.webContents.setZoomFactor(1.5)
  })
  await speed.click()
  const menu = await page.getByRole('menu', { name: '播放倍速' }).boundingBox()
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  expect(menu!.x).toBeGreaterThanOrEqual(0)
  expect(menu!.y).toBeGreaterThanOrEqual(0)
  expect(menu!.x + menu!.width).toBeLessThanOrEqual(viewport.width + 1)
  expect(menu!.y + menu!.height).toBeLessThanOrEqual(viewport.height + 1)
  await page.keyboard.press('Home')
  await page.keyboard.press('Enter')
  await expect(speed).toHaveText('0.75x')
})

test('confirms a single unlike from playback, pauses media and retains the fixed queue metadata', async () => {
  const { accountId } = await prepareQueue()
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await readyVideo()
  await page.getByRole('button', { name: '取消当前点赞', exact: true }).click()
  expect(await page.locator('video').evaluate((node) => (node as HTMLVideoElement).paused)).toBe(true)
  const before = (await invoke('snapshot')).data.playback
  const modal = page.getByRole('dialog', { name: '取消抖音点赞' })
  await expect(modal).toContainText('1 条作品')
  await modal.getByRole('button', { name: '确认取消抖音点赞', exact: true }).click()
  await expect.poll(async () => (await invoke('snapshot')).data.unlike?.status).toBe('completed')
  const after = (await invoke('snapshot')).data
  expect(after.unlike).toMatchObject({ success: 1, unknown: 0, mode: 'single' })
  expect(after.playback).toMatchObject({ queueId: before.queueId, total: 3 })
  expect(after.playback.work.id).toBe(before.work.id)
  expect((await invoke('query', { accountId })).data.total).toBe(2)
  expect(
    new URLSearchParams(await app.evaluate(() => (globalThis as any).__mylikeUnlikeBody)).get('aweme_id')
  ).toBe(before.work.id)
  await expect(page.getByRole('button', { name: /点赞任务/ })).toHaveCount(0)
  await page.getByRole('button', { name: '返回内容库', exact: true }).click()
  await page.getByRole('button', { name: '连接与任务', exact: true }).click()
  await expect(page.getByRole('heading', { name: '连接与任务' })).toBeVisible()
  await expect(page.getByLabel('取消点赞任务')).toContainText('成功 1')
  expect(await page.locator('video,audio').count()).toBe(0)
})

test('fills the app with media, collapses navigation without reloading video, and keeps controls below it at small window sizes', async ({}, info) => {
  await prepareQueue(6)
  const prefs = (await invoke('snapshot')).data.playbackPreferences
  await invoke('playbackPreferences', { preferences: { ...prefs, continuous: false } })
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await readyVideo()
  await expect
    .poll(() => page.locator('.sidebar-region').evaluate((node) => node.getBoundingClientRect().width))
    .toBeLessThan(1)
  await page.evaluate(() => {
    ;(window as any).__layoutVideo = document.querySelector('video')
  })
  for (const [width, height] of [
    [1280, 880],
    [920, 640]
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL().startsWith('mylike://ui/'))!
          .setSize(size[0]!, size[1]!),
      [width, height]
    )
    await expect
      .poll(async () =>
        page.locator('.player-view').evaluate((node) => Math.round(node.getBoundingClientRect().width))
      )
      .toBeLessThanOrEqual(width!)
    const layout = await page.evaluate(() => {
      const player = document.querySelector('.player-view')!.getBoundingClientRect(),
        media = document.querySelector('.stage')!.getBoundingClientRect(),
        footer = document.querySelector('.player-footer')!.getBoundingClientRect()
      return {
        playerX: player.x,
        playerWidth: player.width,
        viewport: innerWidth,
        mediaRatio: media.height / player.height,
        stageTop: media.top,
        footerHeight: footer.height,
        headingHeight: document.querySelector('.player-heading')!.getBoundingClientRect().height,
        footerTop: footer.top,
        stageBottom: media.bottom,
        overflow: document.documentElement.scrollWidth > innerWidth
      }
    })
    expect(layout.playerX).toBeLessThan(1)
    expect(layout.playerWidth).toBeGreaterThanOrEqual(layout.viewport - 1)
    expect(layout.mediaRatio).toBeGreaterThan(0.93)
    expect(layout.stageTop).toBeLessThan(1)
    expect(layout.headingHeight).toBeLessThanOrEqual(30)
    expect(layout.footerHeight).toBeLessThanOrEqual(38)
    expect(layout.footerTop).toBeGreaterThanOrEqual(layout.stageBottom - 1)
    expect(layout.overflow).toBe(false)
    for (const label of ['显示播放队列', '打开原页', '取消当前点赞', '全屏'])
      expect(
        (await page.getByRole('button', { name: label, exact: true }).boundingBox())!.y
      ).toBeGreaterThanOrEqual(layout.footerTop)
  }
  await screenshot(info.outputPath('player-full-width-small.png'))
  await expect(page.getByRole('button', { name: '展开左栏', exact: true })).toHaveCount(0)
  await expect
    .poll(() => page.locator('.sidebar-region').evaluate((node) => node.getBoundingClientRect().width))
    .toBeLessThan(1)
  expect(await page.evaluate(() => document.querySelector('video') === (window as any).__layoutVideo)).toBe(
    true
  )
  await expect(page.locator('.sidebar-region')).toHaveAttribute('inert', '')
  await expect
    .poll(() => page.locator('.sidebar-region').evaluate((node) => node.getBoundingClientRect().width))
    .toBeLessThan(1)
  if (await page.getByRole('button', { name: '暂停播放', exact: true }).count())
    await page.getByRole('button', { name: '暂停播放', exact: true }).click()
  await page.getByLabel('视频进度', { exact: true }).focus()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  await expect
    .poll(() => page.locator('video').evaluate((node) => (node as HTMLVideoElement).currentTime))
    .toBeGreaterThan(0)
  await page.locator('.stage').hover()
  await page.mouse.wheel(0, 240)
  await page.mouse.wheel(0, 240)
  await expect.poll(async () => (await invoke('snapshot')).data.playback.index).toBe(1)
  await page.getByRole('button', { name: '返回内容库', exact: true }).click()
  await expect
    .poll(() => page.locator('.sidebar-region').evaluate((node) => node.getBoundingClientRect().width))
    .toBeGreaterThan(150)
})

for (const kind of ['video', 'image', 'live'] as const) {
  test(`contains portrait ${kind} within the viewport while resizing, opening navigation and zooming`, async ({}, info) => {
    test.setTimeout(testTimeout(60000))
    await prepareQueue(1, kind !== 'video', true)
    await page.getByRole('button', { name: '顺序播放', exact: true }).click()
    if (kind === 'image') {
      await readyVideo()
      await page.getByRole('button', { name: '下一张', exact: true }).click()
      await expect
        .poll(() =>
          page.locator('.gallery-image').evaluate((node) => (node as HTMLImageElement).naturalHeight)
        )
        .toBe(1920)
    } else {
      await readyVideo()
      expect(await page.locator('video').evaluate((node) => (node as HTMLVideoElement).videoHeight)).toBe(
        1920
      )
    }
    await page.evaluate(() => {
      const v = document.querySelector('video')
      if (v) {
        v.pause()
        v.loop = true
      }
    })
    const check = async () =>
      expect(async () => {
        const layout = await page.evaluate(() => {
          const selectors = [
            '.player-shell',
            '.player-view',
            '.player-body',
            '.stage',
            '.player-footer',
            'video,.gallery-image'
          ]
          return {
            width: innerWidth,
            height: innerHeight,
            scrollWidth: document.documentElement.scrollWidth,
            scrollHeight: document.documentElement.scrollHeight,
            boxes: selectors.map((selector) => {
              const node = document.querySelector(selector)!
              const r = node.getBoundingClientRect()
              return {
                selector,
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                right: r.right,
                bottom: r.bottom
              }
            }),
            fit: getComputedStyle(document.querySelector('video,.gallery-image')!).objectFit,
            controls: Array.from(
              document.querySelectorAll(
                '.playback-controls button,.playback-controls select,.playback-controls input'
              )
            )
              .filter((node) => !(node as HTMLInputElement).disabled)
              .map((node) => {
                const r = node.getBoundingClientRect()
                return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }
              })
          }
        })
        expect(layout.scrollHeight, 'portrait content must not expand the app row').toBeLessThanOrEqual(
          layout.height + 1
        )
        expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1)
        for (const box of [...layout.boxes, ...layout.controls]) {
          expect(box.x).toBeGreaterThanOrEqual(-1)
          expect(box.y).toBeGreaterThanOrEqual(-1)
          expect(box.right).toBeLessThanOrEqual(layout.width + 1)
          expect(box.bottom, JSON.stringify(box)).toBeLessThanOrEqual(layout.height + 1)
        }
        const media = layout.boxes.at(-1)!,
          area = layout.boxes.find((box) => box.selector === '.stage')!
        expect(media.x).toBeCloseTo(area.x, 0)
        expect(media.y).toBeCloseTo(area.y, 0)
        expect(media.width).toBeCloseTo(area.width, 0)
        expect(media.height).toBeCloseTo(area.height, 0)
        expect(area.height).toBeGreaterThan(100)
        expect(layout.fit).toBe('contain')
      }).toPass({ timeout: testTimeout(5000) })
    for (const zoom of [1, 1.25, 1.5]) {
      await app.evaluate(({ BrowserWindow }, zoom) => {
        const win = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().startsWith('mylike://ui/')
        )!
        win.setSize(920, 640)
        win.webContents.setZoomFactor(zoom)
      }, zoom)
      await check()
      await expect(page.getByRole('button', { name: '展开左栏', exact: true })).toHaveCount(0)
      await expect
        .poll(() => page.locator('.sidebar-region').evaluate((node) => node.getBoundingClientRect().width))
        .toBeLessThan(1)
      await check()
      await expect(page.locator('.sidebar-region')).toHaveAttribute('inert', '')
      await expect
        .poll(() => page.locator('.sidebar-region').evaluate((node) => node.getBoundingClientRect().width))
        .toBeLessThan(1)
    }
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().startsWith('mylike://ui/')
      )!
      win.webContents.setZoomFactor(1)
      win.setSize(1280, 880)
      win.showInactive()
    })
    await check()
    await page.getByRole('button', { name: '全屏', exact: true }).click()
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true)
    await check()
    await page.keyboard.press('Escape')
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false)
    await screenshot(info.outputPath(`portrait-${kind}.png`))
  })
}

test('allows starting and changing playback during a background unlike without cancelling its pending write', async () => {
  const { accountId, ids } = await prepareQueue(6)
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeHoldUnlike = true
  })
  expect((await invoke('unlikeStart', { accountId, workIds: ids.slice(0, 2), mode: 'batch' })).ok).toBe(true)
  await expect.poll(() => app.evaluate(() => (globalThis as any).__mylikeUnlikeCount)).toBe(1)
  await expect(page.getByRole('button', { name: '顺序播放', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await expect(page.getByRole('region', { name: '播放器', exact: true })).toBeVisible()
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeReleaseUnlike()
  })
  await readyVideo()
  await expect.poll(() => app.evaluate(() => (globalThis as any).__mylikeUnlikeCount)).toBe(2)
  await page.getByRole('button', { name: '下一条', exact: true }).click()
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeHoldUnlike = false
    ;(globalThis as any).__mylikeReleaseUnlike()
  })
  await readyVideo(1)
  await expect.poll(async () => (await invoke('snapshot')).data.unlike.status).toBe('completed')
  const state = (await invoke('snapshot')).data
  expect(state.unlike).toMatchObject({ success: 2, unknown: 0 })
  expect(state.playback.total).toBe(6)
  expect(state.playback.index).toBeGreaterThanOrEqual(1)
  expect((await invoke('query', { accountId })).data.total).toBe(4)
  expect(
    await page.locator('video').evaluate((node) => (node as HTMLVideoElement).error?.code ?? null)
  ).toBeNull()
})

test('cancels an unfinished media request when leaving playback without waiting for the platform timeout', async () => {
  const { ids } = await prepareQueue()
  await app.evaluate((_electron, id) => {
    ;(globalThis as any).__mylikeDelayDetail = id
    ;(globalThis as any).__mylikeDetailDelayMs = 25000
  }, ids[2]!)
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await expect
    .poll(() =>
      app.evaluate(() =>
        ((globalThis as any).__mylikeTestCalls as string[]).some((url) => url.includes('/aweme/detail/'))
      )
    )
    .toBe(true)
  await page.getByRole('button', { name: '返回内容库', exact: true }).click()
  await expect(page.getByRole('heading', { name: '喜欢的内容' })).toBeVisible()
  await expect.poll(async () => (await invoke('snapshot')).data.busy, { timeout: 3000 }).toBe(false)
  await expect(page.locator('video,audio')).toHaveCount(0)
})

test('keeps dashboard totals independent of filters, plays the whole account and clears data on account switch', async ({}, info) => {
  const { accountId } = await prepareQueue(6)
  await page.getByLabel('搜索内容').fill('队列作品 1')
  await expect(page.locator('.list-caption')).toContainText('1 条内容')
  await page.getByRole('button', { name: '仪表盘', exact: true }).click()
  await expect(page.getByRole('heading', { name: '仪表盘', exact: true })).toBeVisible()
  await expect(page.getByRole('group', { name: '本地内容', exact: true })).toContainText('6')
  await expect(page.getByRole('group', { name: '视频', exact: true })).toContainText('6')
  await expect(page.locator('.recent-work')).toHaveCount(4)
  await screenshot(info.outputPath('dashboard-dark.png'))
  await page.getByRole('button', { name: '洗牌回看', exact: true }).click()
  await readyVideo()
  expect((await invoke('snapshot')).data.playback).toMatchObject({ total: 6, mode: 'shuffle' })
  await page.getByRole('button', { name: '返回内容库', exact: true }).click()
  await expect(page.getByRole('heading', { name: '仪表盘', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '继续播放', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '浏览内容', exact: true }).click()
  await expect(page.getByLabel('搜索内容')).toHaveValue('队列作品 1')
  await expect(page.locator('.list-caption')).toContainText('1 条内容')
  await page.getByLabel('搜索内容').fill('')
  await expect(page.locator('.list-caption')).toContainText('6 条内容')
  await screenshot(info.outputPath('library-refresh.png'))
  await page.getByRole('button', { name: '仪表盘', exact: true }).click()
  const second = await invoke('createAccount', { name: '空账号' })
  expect(second.ok).toBe(true)
  await expect(page.getByRole('combobox', { name: '当前账号', exact: true })).toHaveText('空账号(未核验)')
  await expect(page.getByRole('group', { name: '本地内容', exact: true })).toContainText('0')
  await expect(page.locator('.recent-work')).toHaveCount(0)
  expect((await invoke('libraryOverview', { accountId })).error.code).toBe('ACCOUNT_CHANGED')
  await page.getByRole('button', { name: '切换主题', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(920, 640))
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  await screenshot(info.outputPath('dashboard-light-small.png'))
})

test('shows a concise dashboard onboarding entry without starting a browser or task', async ({}, info) => {
  await page.getByRole('button', { name: '仪表盘', exact: true }).click()
  await expect(page.getByRole('heading', { name: '开始整理你的喜欢', exact: true })).toBeVisible()
  expect((await invoke('snapshot')).data.engine.status).toBe('stopped')
  await screenshot(info.outputPath('dashboard-empty.png'))
  await page.locator('.dashboard-welcome').getByRole('button', { name: '添加账号', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
})

test('matches native caption colors to light mode and playback, scopes collection to the library and shows real metadata usage', async ({}, info) => {
  test.setTimeout(testTimeout(60000))
  const { accountId } = await prepareQueue(3)
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((win) =>
      win.webContents.getURL().startsWith('mylike://ui/')
    )!
    const original = win.setTitleBarOverlay.bind(win)
    ;(globalThis as any).__captionStyles = []
    win.setTitleBarOverlay = (options) => {
      ;(globalThis as any).__captionStyles.push(options)
      original(options)
    }
  })
  const caption = () => app.evaluate(() => (globalThis as any).__captionStyles.at(-1))
  const theme = page.getByRole('button', { name: '切换主题', exact: true })
  expect(await theme.evaluate((node) => !!node.closest('.sidebar-account-area'))).toBe(true)
  await theme.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect.poll(caption).toMatchObject({ color: '#f7f8fb', symbolColor: '#202436' })
  expect(
    await theme.evaluate(
      (node) =>
        node.getBoundingClientRect().bottom <=
        document.querySelector('.account-section')!.getBoundingClientRect().top
    )
  ).toBe(true)
  for (const tab of ['仪表盘', '连接与任务', '设置']) {
    await page.getByRole('button', { name: tab, exact: true }).click()
    await expect(page.locator('.page-header .primary')).toHaveCount(0)
  }
  await page.getByRole('button', { name: '仪表盘', exact: true }).click()
  const overview = (await invoke('libraryOverview', { accountId })).data
  expect(overview.metadataBytes).toBeGreaterThan(0)
  expect(overview.metadataBytes).toBe((await invoke('dataInfo', { accountId })).data.metadataBytes)
  await expect(page.getByRole('group', { name: '数据占用', exact: true })).toContainText(/MB/)
  await expect(page.getByRole('group', { name: '其中实况', exact: true })).toHaveCount(0)
  await screenshot(info.outputPath('dashboard-usage-light.png'))
  await page.getByRole('button', { name: '喜欢的内容', exact: true }).click()
  await expect(page.locator('.page-header .primary')).toBeVisible()
  await screenshot(info.outputPath('library-light.png'))
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await readyVideo()
  await expect.poll(caption).toMatchObject({ color: '#111113', symbolColor: '#ececf2' })
  await page.mouse.move(400, 150)
  expect(
    await page
      .getByRole('button', { name: '暂停播放', exact: true })
      .evaluate((node) => getComputedStyle(node).backgroundColor)
  ).toBe('rgba(0, 0, 0, 0)')
  await screenshot(info.outputPath('player-plain-controls.png'))
  await page.getByRole('button', { name: '返回内容库', exact: true }).click()
  await expect.poll(caption).toMatchObject({ color: '#f7f8fb', symbolColor: '#202436' })
  await app.close()
  await launch()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((win) => win.webContents.getURL().startsWith('mylike://ui/'))!
        .getBackgroundColor()
        .toLowerCase()
    )
  ).toBe('#f7f8fb')
})

test('uses themed dropdowns with keyboard selection, disabled options and bounded popovers at small sizes', async ({}, info) => {
  await prepareQueue(4)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().startsWith('mylike://ui/'))!
      .setSize(920, 640)
  )
  const month = page.getByRole('combobox', { name: '月份筛选', exact: true })
  await month.focus()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('listbox', { name: '月份筛选', exact: true })).toBeVisible()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await expect(month).toHaveText('12 月')
  await chooseOption('月份筛选', '全部月份')
  await expect(page.locator('.list-caption')).toContainText('4 条内容')
  await month.click()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Escape')
  await expect(month).toHaveText('全部月份')
  await expect(month).toBeFocused()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('combobox', { name: '播放 / 暂停快捷键', exact: true }).click()
  const disabled = page.getByRole('option', { name: '←', exact: true })
  await expect(disabled).toHaveAttribute('aria-disabled', 'true')
  await disabled.click({ force: true })
  expect((await invoke('snapshot')).data.playbackPreferences.shortcuts.playPause).toBe('Space')
  await page.keyboard.press('Escape')
  await chooseOption('外观主题', '白天模式')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  const account = page.getByRole('combobox', { name: '当前账号', exact: true })
  for (const zoom of [1, 1.5]) {
    await app.evaluate(
      ({ BrowserWindow }, zoom) =>
        BrowserWindow.getAllWindows()
          .find((win) => win.webContents.getURL().startsWith('mylike://ui/'))!
          .webContents.setZoomFactor(zoom),
      zoom
    )
    await account.click()
    const popup = page.getByRole('listbox', { name: '当前账号', exact: true })
    await expect(popup).toBeVisible()
    const bounds = await popup.evaluate((node) => {
      const box = node.getBoundingClientRect()
      return {
        top: box.top,
        bottom: box.bottom,
        left: box.left,
        right: box.right,
        width: innerWidth,
        height: innerHeight
      }
    })
    expect(bounds.top).toBeGreaterThanOrEqual(0)
    expect(bounds.left).toBeGreaterThanOrEqual(0)
    expect(bounds.right).toBeLessThanOrEqual(bounds.width)
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.height)
    await page.keyboard.press('Escape')
  }
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().startsWith('mylike://ui/'))!
      .webContents.setZoomFactor(1)
  )
  await page.getByRole('button', { name: '喜欢的内容', exact: true }).click()
  await month.click()
  await screenshot(info.outputPath('dropdown-light.png'))
  await page.getByRole('heading', { name: '喜欢的内容', exact: true }).click()
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await expect(page.locator('select')).toHaveCount(0)
})

test('keeps the playlist clear of native window controls while resizing, maximizing, zooming and fullscreen', async ({}, info) => {
  test.setTimeout(testTimeout(75000))
  await prepareQueue(6)
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await readyVideo()
  await page.getByRole('button', { name: '显示播放队列', exact: true }).click()
  const windowId = await app.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith('mylike://ui/'))!.id
  )
  const check = async () => {
    const bounds = await page.evaluate(() => {
      const native = (navigator as any).windowControlsOverlay
      const panel = document.querySelector('.queue-panel')!.getBoundingClientRect()
      const close = document.querySelector('[aria-label="收起播放队列"]')!.getBoundingClientRect()
      // Windows may retain WCO geometry while HTML fullscreen hides its caption controls.
      const nativeBottom =
        !document.fullscreenElement && native?.visible ? native.getTitlebarAreaRect().bottom : 0
      return {
        top: panel.top,
        right: panel.right,
        bottom: panel.bottom,
        closeTop: close.top,
        nativeBottom,
        width: innerWidth,
        height: innerHeight
      }
    })
    expect(bounds.top).toBeGreaterThanOrEqual(bounds.nativeBottom + 6)
    expect(bounds.closeTop).toBeGreaterThan(bounds.nativeBottom)
    expect(bounds.right).toBeLessThanOrEqual(bounds.width)
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.height)
    await expect(page.getByRole('button', { name: '收起播放队列', exact: true })).toBeVisible()
  }
  try {
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.showInactive(), windowId)
    for (const zoom of [1, 1.25, 1.5]) {
      await app.evaluate(
        ({ BrowserWindow }, { id, zoom }) => {
          const win = BrowserWindow.fromId(id)!
          win.setSize(920, 640)
          win.webContents.setZoomFactor(zoom)
        },
        { id: windowId, zoom }
      )
      await expect(check).toPass({ timeout: 3000 })
      if (zoom === 1) await screenshot(info.outputPath('playlist-window-safe.png'))
    }
    await app.evaluate(({ BrowserWindow }, id) => {
      const win = BrowserWindow.fromId(id)!
      win.webContents.setZoomFactor(1)
      win.maximize()
    }, windowId)
    await expect(check).toPass({ timeout: 3000 })
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.showInactive(), windowId)
    await page.getByRole('button', { name: '全屏', exact: true }).click()
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true)
    await check()
    expect(
      await page.locator('.queue-panel').evaluate((node) => node.getBoundingClientRect().top)
    ).toBeLessThan(20)
    await page.getByRole('button', { name: '下一条', exact: true }).click()
    await expect(page.getByRole('complementary', { name: '播放队列', exact: true })).toBeVisible()
    expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(true)
    await page.getByRole('button', { name: '收起播放队列', exact: true }).click()
    await expect(page.locator('.queue-panel')).toHaveCount(0)
  } finally {
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.hide(), windowId)
  }
})

test('provides readable collection actions and resume banner, unified help links and direct account renaming', async ({}, info) => {
  const { accountId } = await prepareQueue(3)
  const collect = page.locator('.header-actions .primary')
  const box = await collect.boundingBox()
  expect(box!.width).toBeGreaterThanOrEqual(144)
  expect(box!.height).toBeGreaterThanOrEqual(44)
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await readyVideo()
  await page.getByRole('button', { name: '返回内容库', exact: true }).click()
  expect(
    await page.locator('.resume-banner').evaluate((node) => node.getBoundingClientRect().height)
  ).toBeGreaterThanOrEqual(96)
  expect(
    await page.locator('.resume-banner').evaluate((node) => parseFloat(getComputedStyle(node).fontSize))
  ).toBeGreaterThanOrEqual(16)
  await expect(page.locator('.sidebar-bottom')).toHaveCount(0)
  await screenshot(info.outputPath('readable-library.png'))
  await page.getByRole('button', { name: '常见问题', exact: true }).click()
  await expect(page.getByRole('heading', { name: '常见问题', exact: true }).first()).toBeVisible()
  await page.getByText('需要一直登录吗？', { exact: true }).click()
  await expect(page.locator('details[open]')).toContainText('核验账号')
  await page.getByRole('button', { name: '使用教程', exact: true }).click()
  await expect(page.getByRole('heading', { name: '开始使用 MyLike', exact: true })).toBeVisible()
  await app.evaluate(({ shell }) => {
    ;(globalThis as any).__projectUrls = []
    shell.openExternal = async (url) => {
      ;(globalThis as any).__projectUrls.push(url)
    }
  })
  await page.getByRole('button', { name: '项目地址', exact: true }).click()
  await expect
    .poll(() => app.evaluate(() => (globalThis as any).__projectUrls))
    .toEqual(['https://github.com/Hannah2227/douyin-favorite-MyLike'])
  await page.getByRole('button', { name: '修改账号名称', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '修改账号名称', exact: true })
  await dialog.getByRole('textbox', { name: '本地账号名称', exact: true }).fill('自定义名称')
  await dialog.getByRole('button', { name: '保存名称', exact: true }).click()
  await expect(page.getByRole('combobox', { name: '当前账号', exact: true })).toHaveText(
    '自定义名称(测试用户)'
  )
  expect((await invoke('snapshot')).data.accounts.find((a: any) => a.id === accountId)).toMatchObject({
    name: '自定义名称',
    nickname: '测试用户'
  })
  await page.getByRole('button', { name: '喜欢的内容', exact: true }).click()
})

test('synchronizes favorite folders through the page SDK, restores folder cursors after restart and plays only the chosen folder', async ({}, info) => {
  test.setTimeout(testTimeout(120000))
  const { accountId } = await prepareQueue(3)
  await page.getByRole('button', { name: '收藏的内容', exact: true }).click()
  await expect(page.locator('.page-header .primary')).toHaveCount(0)
  await app.evaluate(() => {
    ;(globalThis as any).__favoriteHold = true
  })
  await page.getByRole('button', { name: '同步收藏', exact: true }).click()
  await expect
    .poll(async () => (await invoke('snapshot')).data.favorites, { timeout: 30000 })
    .toMatchObject({
      stage: 'folder',
      folderId: '9007199254740993999',
      cursor: '9007199254740993977',
      status: 'running'
    })
  expect((await invoke('collectionStart', { accountId, mode: 'update' })).error.code).toBe('BUSY')
  const task = (await invoke('snapshot')).data.favorites
  expect((await invoke('favoritesControl', { accountId, taskId: task.id, action: 'pause' })).ok).toBe(true)
  await app.evaluate(() => {
    ;(globalThis as any).__favoriteHold = false
    ;(globalThis as any).__releaseFavorite?.()
  })
  await app.close()
  await launch()
  await installPlatform(accountId)
  await installMedia()
  expect((await invoke('snapshot')).data.favorites).toMatchObject({
    stage: 'folder',
    cursor: '9007199254740993977',
    status: 'paused'
  })
  expect(await app.evaluate(() => (globalThis as any).__favoriteRequests?.length ?? 0)).toBe(0)
  await page.getByRole('button', { name: '收藏的内容', exact: true }).click()
  await page.getByRole('button', { name: '继续同步收藏', exact: true }).click()
  await expect
    .poll(async () => (await invoke('snapshot')).data.favorites, { timeout: 20000 })
    .toMatchObject({ status: 'completed', foldersDone: 2, foldersTotal: 2 })
  const calls = await app.evaluate(() => (globalThis as any).__favoriteRequests)
  expect(calls[0]).toMatchObject({
    cursor: '9007199254740993977',
    folderId: '9007199254740993999',
    sdk: 'page-main-world'
  })
  await expect(page.locator('.list-caption')).toContainText('3 条内容')
  await chooseOption('收藏夹筛选', '旅行 · 2')
  await expect(page.locator('.list-caption')).toContainText('2 条内容')
  await screenshot(info.outputPath('favorite-folder.png'))
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await readyVideo()
  expect((await invoke('snapshot')).data.playback).toMatchObject({ source: 'favorites', total: 2 })
  await expect(page.getByRole('button', { name: '取消当前点赞', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '返回内容库', exact: true }).click()
  await chooseOption('收藏夹筛选', '音乐 · 1')
  await expect(page.locator('.list-caption')).toContainText('1 条内容')
  await page.getByRole('button', { name: '喜欢的内容', exact: true }).click()
  await expect(page.locator('.list-caption')).toContainText('3 条内容')
  expect((await invoke('libraryOverview', { accountId })).data.total).toBe(5)
})

test('pauses favorite sync on rate limits without changing likes or blindly retrying', async () => {
  const { accountId } = await prepareQueue(2)
  await app.evaluate(() => {
    ;(globalThis as any).__favoriteRateLimited = true
  })
  expect((await invoke('favoritesStart', { accountId })).ok).toBe(true)
  await expect
    .poll(async () => (await invoke('snapshot')).data.favorites)
    .toMatchObject({ status: 'paused', errorCode: 'RATE_LIMITED', cursor: '0', pages: 0 })
  expect(await app.evaluate(() => (globalThis as any).__favoriteRequests.length)).toBe(1)
  expect((await invoke('query', { accountId })).data.total).toBe(2)
  expect((await invoke('query', { accountId, source: 'favorites' })).data.total).toBe(0)
})

test('persists general and playback settings, restores a visible window, and provides simplified storage and redacted diagnostics', async ({}, info) => {
  test.setTimeout(testTimeout(90000))
  await addAccount()
  await app.evaluate(({ clipboard, shell }) => {
    ;(globalThis as any).__copied = []
    ;(globalThis as any).__external = []
    clipboard.writeText = async (value: string) => {
      ;(globalThis as any).__copied.push(value)
    }
    shell.openExternal = async (url: string) => {
      ;(globalThis as any).__external.push(url)
    }
  })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('textbox', { name: '搜索设置' }).fill('不存在的设置')
  await expect(page.getByText('没有找到相关设置', { exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '搜索设置' }).fill('缩放')
  await expect(page.getByRole('heading', { name: '通用', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '播放偏好', exact: true })).toBeHidden()
  await page.getByRole('button', { name: '清空设置搜索' }).click()
  await chooseOption('启动时打开', '仪表盘')
  await chooseOption('界面缩放', '110%')
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor())
    )
    .toBeCloseTo(1.1)
  await chooseOption('界面动画', '减少动画')
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce')
  const geometry = await page.evaluate(() => {
    const root = document.querySelector('.settings-scroll')!
    return {
      width: root.clientWidth,
      scroll: root.scrollWidth,
      contentRight: document.querySelector('.settings-content')!.getBoundingClientRect().right,
      viewport: innerWidth
    }
  })
  expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1)
  expect(geometry.contentRight).toBeLessThanOrEqual(geometry.viewport + 1)
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!
    win.setBounds({ width: 920, height: 640 })
    win.webContents.setZoomFactor(1.5)
  })
  await expect
    .poll(() => page.locator('.settings-scroll').evaluate((node) => node.scrollWidth - node.clientWidth))
    .toBeLessThanOrEqual(1)
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!
    win.setBounds({ width: 1320, height: 880 })
    win.webContents.setZoomFactor(1.1)
  })
  await page.getByLabel('进入作品自动播放', { exact: true }).uncheck()
  await page.getByLabel('滚轮切换作品', { exact: true }).uncheck()
  await page.getByLabel('失焦时暂停', { exact: true }).check()
  await chooseOption('快进后退步长', '30 秒')
  await page.getByRole('button', { name: '数据与存储', exact: true }).click()
  await expect(page.getByRole('heading', { name: '数据与备份', exact: true })).toBeVisible()
  for (const name of ['立即备份数据库', '检查数据库完整性', '清理页面缓存'])
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0)
  await expect(page.getByText('当前页面缓存', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '导入元数据', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '导出全部本地内容', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '打开备份目录', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '刷新占用', exact: true }).click()
  await page.getByRole('button', { name: '关于', exact: true }).click()
  await page.getByRole('button', { name: '复制诊断信息', exact: true }).click()
  const diagnostics = JSON.parse(await app.evaluate(() => (globalThis as any).__copied.at(-1)))
  expect(diagnostics).toMatchObject({ application: 'MyLike', version })
  expect(JSON.stringify(diagnostics)).not.toMatch(/Cookie|remoteId|测试账号|mylike\.sqlite|https:\/\//i)
  await page.getByRole('button', { name: '查看发布记录', exact: true }).click()
  expect(await app.evaluate(() => (globalThis as any).__external)).toEqual([
    'https://github.com/Hannah2227/douyin-favorite-MyLike/releases'
  ])
  await chooseOption('播放 / 暂停快捷键', 'K')
  await expect
    .poll(async () => (await invoke('snapshot')).data.playbackPreferences.shortcuts.playPause)
    .toBe('KeyK')
  await page.getByTitle('恢复默认快捷键', { exact: true }).click()
  await page
    .getByRole('dialog', { name: '恢复默认快捷键', exact: true })
    .getByRole('button', { name: '恢复默认', exact: true })
    .click()
  await expect
    .poll(async () => (await invoke('snapshot')).data.playbackPreferences.shortcuts.playPause)
    .toBe('Space')
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '通用', exact: true })
    .click()
  await screenshot(info.outputPath('settings-general.png'))
  const workArea = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
  const width = Math.min(1100, Math.max(920, workArea.width - 120))
  const height = Math.min(780, Math.max(640, workArea.height - 100))
  await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0]!.setBounds(bounds), {
    x: workArea.x + Math.floor(Math.max(0, workArea.width - width) / 2),
    y: workArea.y + Math.floor(Math.max(0, workArea.height - height) / 2),
    width,
    height
  })
  const bounds = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.getNormalBounds()
  )
  await expect.poll(async () => (await invoke('snapshot')).data.playbackPreferences.seekStep).toBe(30)
  await app.close()
  await launch('仪表盘')
  expect((await invoke('snapshot')).data).toMatchObject({
    appPreferences: { startupPage: 'dashboard', zoom: 1.1, motion: 'reduce' },
    playbackPreferences: { autoplay: false, wheelNavigation: false, pauseOnBlur: true, seekStep: 30 }
  })
  const restored = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.getNormalBounds()
  )
  console.info('Window restore geometry:', JSON.stringify({ workArea, saved: bounds, restored }))
  expect(restored.x).toBe(bounds.x)
  expect(restored.y).toBe(bounds.y)
  // Windows rounds non-client borders at fractional display scales.
  expect(Math.abs(restored.width - bounds.width)).toBeLessThanOrEqual(8)
  expect(Math.abs(restored.height - bounds.height)).toBeLessThanOrEqual(8)
  expect((await invoke('snapshot')).data.engine.status).toBe('stopped')
})

test('uses focused player shortcuts and keeps inputs and unlike confirmation protected', async ({}, info) => {
  test.setTimeout(testTimeout(90000))
  await prepareQueue(3)
  const preferences = (await invoke('snapshot')).data.playbackPreferences
  await invoke('playbackPreferences', {
    preferences: {
      ...preferences,
      shortcuts: { ...preferences.shortcuts, rateCycle: 'KeyV', original: 'KeyC' }
    }
  })
  await app.evaluate(({ shell }) => {
    ;(globalThis as any).__opened = []
    shell.openExternal = async (url: string) => {
      ;(globalThis as any).__opened.push(url)
    }
  })
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await readyVideo()
  await page.getByRole('button', { name: '暂停播放', exact: true }).click()
  for (const name of ['复制作品链接', '播放器快捷键帮助', '展开左栏'])
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0)
  await page.keyboard.press('q')
  await expect(page.getByRole('complementary', { name: '播放队列' })).toBeVisible()
  await page.keyboard.press('q')
  await expect(page.getByRole('complementary', { name: '播放队列' })).toBeHidden()
  await page.keyboard.press('n')
  await expect.poll(async () => (await invoke('snapshot')).data.playbackPreferences.volume).toBe(0)
  expect((await invoke('snapshot')).data.playback.index).toBe(0)
  await page.keyboard.press('n')
  await page.keyboard.press('v')
  await expect(page.getByRole('button', { name: '倍速', exact: true })).toHaveText('1.25x')
  for (let i = 0; i < 4; i++) await page.keyboard.press('v')
  await expect(page.getByRole('button', { name: '倍速', exact: true })).toHaveText('0.75x')
  await page.keyboard.press('a')
  await expect(page.locator('.continuous-control input')).not.toBeChecked()
  await page.keyboard.press('ArrowDown')
  await expect.poll(async () => (await invoke('snapshot')).data.playback.index).toBe(1)
  await readyVideo(1)
  await page.keyboard.press('PageDown')
  await expect.poll(async () => (await invoke('snapshot')).data.playback.index).toBe(2)
  await readyVideo(2)
  await page.keyboard.press('PageUp')
  await expect.poll(async () => (await invoke('snapshot')).data.playback.index).toBe(1)
  await readyVideo(1)
  await page.keyboard.press('ArrowUp')
  await expect.poll(async () => (await invoke('snapshot')).data.playback.index).toBe(0)
  await readyVideo(0)
  await page.keyboard.press('c')
  await expect.poll(() => app.evaluate(() => (globalThis as any).__opened.length)).toBe(1)
  await expect(page.getByRole('button', { name: '开始播放', exact: true })).toBeVisible()
  for (const key of ['b', 'y', 't', 'u']) await page.keyboard.press(key)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect
    .poll(() => page.locator('.sidebar-region').evaluate((node) => node.getBoundingClientRect().width))
    .toBeLessThan(1)
  await page.getByRole('slider', { name: '音量', exact: true }).focus()
  await page.keyboard.press('q')
  await expect(page.getByRole('complementary', { name: '播放队列' })).toBeHidden()
  await page.locator('.player-time').click()
  await page.keyboard.press('z')
  await expect(page.getByRole('dialog', { name: '取消抖音点赞', exact: true })).toBeVisible()
  expect((await invoke('snapshot')).data.unlike).toBeNull()
  await page.keyboard.press('ArrowDown')
  expect((await invoke('snapshot')).data.playback.index).toBe(0)
  await page.getByRole('button', { name: '取消', exact: true }).click()
  expect((await invoke('snapshot')).data.unlike).toBeNull()
  await page.keyboard.press('f')
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true)
  await page.keyboard.press('Escape')
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false)
  await screenshot(info.outputPath('player-simplified.png'))
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('失焦时暂停', { exact: true }).check()
  await page.getByRole('button', { name: '快捷键', exact: true }).click()
  await expect(page.locator('#settings-shortcuts [role=combobox]')).toHaveCount(14)
  await screenshot(info.outputPath('settings-shortcuts.png'))
  await page.getByRole('button', { name: '喜欢的内容', exact: true }).click()
  await page.getByRole('button', { name: '继续回看', exact: true }).click()
  await readyVideo()
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await expect(page.getByRole('button', { name: '开始播放', exact: true })).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('button', { name: '开始播放', exact: true })).toBeVisible()
})

test('uses gallery shortcuts to pin and resume slides while disabling wheel navigation and autoplay when configured', async () => {
  await prepareQueue(2, true)
  const preferences = (await invoke('snapshot')).data.playbackPreferences
  await invoke('playbackPreferences', {
    preferences: { ...preferences, autoplay: false, wheelNavigation: false }
  })
  await expect
    .poll(async () => page.evaluate(() => window.mylike.invoke('snapshot', {})))
    .toMatchObject({ ok: true, data: { playbackPreferences: { autoplay: false } } })
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await expect(page.getByRole('button', { name: '开始播放', exact: true })).toBeVisible()
  await expect(page.locator('.gallery-status')).toContainText('1 / 2')
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('.gallery-status')).toContainText('2 / 2')
  await expect(page.getByRole('button', { name: '恢复轮播', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '恢复轮播', exact: true }).click()
  await expect(page.getByRole('button', { name: '恢复轮播', exact: true })).toBeHidden()
  await page.getByRole('button', { name: '暂停播放', exact: true }).click()
  await page.keyboard.press('ArrowLeft')
  await expect(page.locator('.gallery-status')).toContainText('1 / 2')
  await page.locator('.stage').hover({ position: { x: 30, y: 30 } })
  await page.mouse.wheel(0, 300)
  expect((await invoke('snapshot')).data.playback.index).toBe(0)
})

test('shows compact task cards with direct controls and clear errors at small sizes', async ({}, info) => {
  test.setTimeout(testTimeout(90000))
  const { accountId } = await prepareQueue(3)
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeHoldLikesAt = '0'
  })
  await invoke('collectionStart', { accountId, mode: 'update' })
  await page.getByRole('button', { name: '连接与任务', exact: true }).click()
  await expect(page.getByRole('button', { name: '暂停采集', exact: true })).toBeVisible()
  await expect(page.getByRole('progressbar', { name: '喜欢列表采集进度', exact: true })).not.toHaveAttribute(
    'aria-valuenow'
  )
  await expect(page.getByRole('textbox', { name: '搜索任务', exact: true })).toHaveCount(0)
  await expect(page.getByRole('tablist', { name: '任务状态' })).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: '任务类型' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '采集一页', exact: true })).toBeHidden()
  await page.getByRole('button', { name: '暂停采集', exact: true }).click()
  await expect.poll(async () => (await invoke('snapshot')).data.collection.status).toBe('paused')
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeHoldLikesAt = null
    ;(globalThis as any).__mylikeReleaseLikes?.()
    ;(globalThis as any).__favoriteRateLimited = true
  })
  await page.getByRole('button', { name: '同步收藏', exact: true }).click()
  await expect.poll(async () => (await invoke('snapshot')).data.favorites?.errorCode).toBe('RATE_LIMITED')
  const favorites = page.getByRole('region', { name: '收藏同步', exact: true })
  await expect(favorites.getByRole('alert')).toContainText('限流')
  await expect(favorites.getByRole('button', { name: '继续同步收藏', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '继续采集', exact: true })).toBeVisible()
  await screenshot(info.outputPath('tasks-simple.png'))
  await invoke('theme', { theme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await screenshot(info.outputPath('tasks-simple-light.png'))
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().startsWith('mylike://ui/')
    )!
    win.setSize(920, 640)
    win.webContents.setZoomFactor(1.5)
  })
  await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThan(650)
  await expect
    .poll(() => page.locator('.task-center').evaluate((node) => node.scrollWidth - node.clientWidth))
    .toBeLessThanOrEqual(1)
  await page.getByRole('button', { name: '继续同步收藏', exact: true }).scrollIntoViewIfNeeded()
  await expect(favorites.getByRole('button', { name: '继续同步收藏', exact: true })).toBeVisible()
  await screenshot(info.outputPath('tasks-simple-small.png'))
  const favoriteTaskId = (await invoke('snapshot')).data.favorites.id
  await app.evaluate(() => {
    ;(globalThis as any).__favoriteRateLimited = false
    ;(globalThis as any).__favoriteHold = true
  })
  await page.getByRole('button', { name: '继续同步收藏', exact: true }).click()
  await expect
    .poll(async () => (await invoke('snapshot')).data.favorites, { timeout: 30000 })
    .toMatchObject({ status: 'running', stage: 'folder', cursor: '9007199254740993977' })
  await page.getByRole('button', { name: '暂停同步', exact: true }).click()
  await expect.poll(async () => (await invoke('snapshot')).data.favorites.status).toBe('paused')
  await app.evaluate(() => {
    ;(globalThis as any).__favoriteHold = false
    ;(globalThis as any).__releaseFavorite?.()
  })
  await page.getByRole('button', { name: '继续同步收藏', exact: true }).click()
  await expect
    .poll(async () => (await invoke('snapshot')).data.favorites?.status, { timeout: 30000 })
    .toBe('completed')
  expect((await invoke('snapshot')).data.favorites.id).toBe(favoriteTaskId)
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeHoldLikesAt = '0'
  })
  await page.getByRole('button', { name: '继续采集', exact: true }).click()
  await page.getByRole('button', { name: '停止采集', exact: true }).click()
  await expect.poll(async () => (await invoke('snapshot')).data.collection.status).toBe('stopped')
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeHoldLikesAt = null
    ;(globalThis as any).__mylikeReleaseLikes?.()
  })
})

test('shows a concise dashboard with publication years and recent works', async ({}, info) => {
  test.setTimeout(testTimeout(90000))
  const { accountId } = await prepareQueue(12)
  expect((await invoke('favoritesStart', { accountId })).ok).toBe(true)
  await expect
    .poll(async () => (await invoke('snapshot')).data.favorites?.status, { timeout: 40000 })
    .toBe('completed')
  await page.getByRole('button', { name: '仪表盘', exact: true }).click()
  await expect(page.getByRole('group', { name: '本地内容', exact: true })).toContainText('12')
  const overview = (await invoke('libraryOverview', { accountId })).data
  expect(overview).toMatchObject({ likes: 12, favorites: 3, overlap: 3, folders: 2 })
  expect(overview.years.reduce((sum: number, day: { count: number }) => sum + day.count, 0)).toBe(12)
  await expect(page.getByRole('region', { name: '内容来源分布' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '任务动态', exact: true })).toHaveCount(0)
  await expect(page.locator('.recent-work')).toHaveCount(4)
  await screenshot(info.outputPath('dashboard-complete.png'))
  await page.getByRole('region', { name: '作品年份分布' }).scrollIntoViewIfNeeded()
  await screenshot(info.outputPath('dashboard-trends.png'))
  await page.getByRole('button', { name: '收藏的内容', exact: true }).click()
  await expect(page.getByRole('heading', { name: '收藏的内容', exact: true })).toBeVisible()
})

test('automatically appends likes, favorites and folder pages without rereading previous pages', async ({}, info) => {
  test.setTimeout(testTimeout(90000))
  await prepareScrollableLibrary()
  const offsets = (source: string, folderId: string | null = null) =>
    app.evaluate(
      (_electron, { source, folderId }) =>
        (
          (globalThis as any).__libraryQueries as {
            source: string
            folderId?: string | null
            offset: number
          }[]
        )
          .filter((row) => row.source === source && (row.folderId ?? null) === folderId)
          .map((row) => row.offset),
      { source, folderId }
    )
  for (const source of ['likes', 'favorites']) {
    if (source === 'favorites') await page.getByRole('button', { name: '收藏的内容', exact: true }).click()
    await expect(page.locator('.list-caption')).toContainText('145 条内容')
    await expect(page.getByRole('button', { name: '加载更多内容', exact: true })).toHaveCount(0)
    const initial = (await offsets(source)).filter((offset) => offset === 0).length
    const firstHeight = await page
      .locator('.virtual-grid')
      .evaluate((node) => node.getBoundingClientRect().height)
    await scrollLibraryToEnd()
    await expect.poll(() => offsets(source)).toContain(60)
    await expect
      .poll(() => page.locator('.virtual-grid').evaluate((node) => node.getBoundingClientRect().height))
      .toBeGreaterThan(firstHeight)
    await scrollLibraryToEnd()
    await expect(page.locator('.library-load-status')).toHaveText('已显示全部内容')
    const loaded = await offsets(source)
    expect(loaded.filter((offset) => offset === 0)).toHaveLength(initial)
    expect(loaded.filter((offset) => offset === 60)).toHaveLength(1)
    expect(loaded.filter((offset) => offset === 120)).toHaveLength(1)
    expect(await page.locator('.work-card').count()).toBeLessThan(60)
    await scrollLibraryToEnd()
    await expect(page.getByRole('heading', { name: '队列作品 1', exact: true })).toBeVisible()
  }
  await chooseOption('收藏夹筛选', '大收藏夹 · 125')
  await expect(page.locator('.list-caption')).toContainText('125 条内容')
  for (const offset of [60, 120]) {
    const height = await page.locator('.virtual-grid').evaluate((node) => node.getBoundingClientRect().height)
    await scrollLibraryToEnd()
    await expect.poll(() => offsets('favorites', '9007199254740993999')).toContain(offset)
    await expect
      .poll(() => page.locator('.virtual-grid').evaluate((node) => node.getBoundingClientRect().height))
      .toBeGreaterThan(height)
  }
  await scrollLibraryToEnd()
  await expect(page.locator('.library-load-status')).toHaveText('已显示全部内容')
  await screenshot(info.outputPath('favorites-infinite-end.png'))
  await chooseOption('收藏夹筛选', '小收藏夹 · 7')
  await expect(page.locator('.list-caption')).toContainText('7 条内容')
  await expect(page.locator('.library-load-status')).toHaveText('已显示全部内容')
  expect(await offsets('favorites', '9007199254740993988')).toEqual([0])
})

test('keeps loaded cards after a next-page error and retries only when requested', async ({}, info) => {
  await prepareScrollableLibrary()
  await app.evaluate(() => {
    ;(globalThis as any).__failLibraryMore = true
  })
  await scrollLibraryToEnd()
  await expect(page.getByRole('alert')).toContainText('受控下一页读取失败')
  await expect(page.locator('.work-card').first()).toBeVisible()
  await expect(page.locator('.work-card').first()).toBeEnabled()
  await page.waitForTimeout(500)
  const attempts = () =>
    app.evaluate(
      () =>
        (globalThis as any).__libraryQueries.filter((row: any) => row.source === 'likes' && row.offset === 60)
          .length
    )
  expect(await attempts()).toBe(1)
  await screenshot(info.outputPath('infinite-retry.png'))
  await app.evaluate(() => {
    ;(globalThis as any).__failLibraryMore = false
  })
  const height = await page.locator('.virtual-grid').evaluate((node) => node.getBoundingClientRect().height)
  await page.getByRole('button', { name: '重试加载', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect.poll(attempts).toBe(2)
  await expect
    .poll(() => page.locator('.virtual-grid').evaluate((node) => node.getBoundingClientRect().height))
    .toBeGreaterThan(height)
  await scrollLibraryToEnd()
  await expect(page.locator('.library-load-status')).toHaveText('已显示全部内容')
})

test('discards delayed next pages after filter and account changes', async () => {
  await prepareScrollableLibrary(true)
  await app.evaluate(() => {
    ;(globalThis as any).__holdLibraryMore = true
  })
  await scrollLibraryToEnd()
  await expect
    .poll(() => app.evaluate(() => typeof (globalThis as any).__releaseLibraryPage))
    .toBe('function')
  await scrollLibraryToEnd()
  await scrollLibraryToEnd()
  expect(
    await app.evaluate(
      () =>
        (globalThis as any).__libraryQueries.filter((row: any) => row.source === 'likes' && row.offset === 60)
          .length
    )
  ).toBe(1)
  await expect(page.locator('.work-card').first()).toBeEnabled()
  await page.getByRole('button', { name: '图集', exact: true }).click()
  await expect(page.locator('.list-caption')).toContainText('72 条内容')
  await app.evaluate(() => {
    ;(globalThis as any).__holdLibraryMore = false
    ;(globalThis as any).__releaseLibraryPage()
    ;(globalThis as any).__releaseLibraryPage = null
  })
  await page.waitForTimeout(250)
  await expect(page.locator('.type-badge').filter({ hasText: '视频' })).toHaveCount(0)
  expect(await page.locator('.library-scroll').evaluate((node) => node.scrollTop)).toBe(0)
  await scrollLibraryToEnd()
  await expect(page.locator('.library-load-status')).toHaveText('已显示全部内容')
  await page.getByRole('button', { name: '全部内容', exact: true }).click()
  await expect(page.locator('.list-caption')).toContainText('145 条内容')
  await app.evaluate(() => {
    ;(globalThis as any).__holdLibraryMore = true
  })
  await scrollLibraryToEnd()
  await expect
    .poll(() => app.evaluate(() => typeof (globalThis as any).__releaseLibraryPage))
    .toBe('function')
  await invoke('createAccount', { name: '空白账号' })
  await expect(page.locator('.list-caption')).toContainText('0 条内容')
  await app.evaluate(() => {
    ;(globalThis as any).__holdLibraryMore = false
    ;(globalThis as any).__releaseLibraryPage()
  })
  await page.waitForTimeout(250)
  await expect(page.locator('.work-card')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '暂无内容', exact: true })).toBeVisible()
})

test('marks safe title and sidebar drag regions while keeping controls interactive', async () => {
  await prepareQueue(1)
  const regions = await page.evaluate(() => {
    const region = (selector: string) =>
      getComputedStyle(document.querySelector(selector)!).getPropertyValue('-webkit-app-region')
    return {
      bar: region('.window-bar'),
      header: region('.page-header'),
      brand: region('.brand'),
      search: region('.search-field'),
      button: region('.header-actions button'),
      sidebarTop: getComputedStyle(document.querySelector('.sidebar')!, '::before').getPropertyValue(
        '-webkit-app-region'
      )
    }
  })
  expect(regions).toEqual({
    bar: 'drag',
    header: 'drag',
    brand: 'drag',
    search: 'no-drag',
    button: 'no-drag',
    sidebarTop: 'drag'
  })
  await page.getByRole('searchbox', { name: '搜索内容', exact: true }).fill('队列')
  await expect(page.locator('.list-caption')).toContainText('1 条内容')
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await readyVideo()
  await expect
    .poll(() =>
      page
        .locator('.player-heading')
        .evaluate((node) => getComputedStyle(node).getPropertyValue('-webkit-app-region'))
    )
    .toBe('drag')
  expect(
    await page
      .getByRole('button', { name: '返回内容库', exact: true })
      .evaluate((node) => getComputedStyle(node).getPropertyValue('-webkit-app-region'))
  ).toBe('no-drag')
  await page.getByRole('button', { name: '全屏', exact: true }).click()
  await expect
    .poll(() =>
      page
        .locator('.player-heading')
        .evaluate((node) => getComputedStyle(node).getPropertyValue('-webkit-app-region'))
    )
    .toBe('no-drag')
  await page.keyboard.press('Escape')
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: '喜欢的内容', exact: true })).toBeVisible()
})

test('reports task history read failures without an empty-state claim and allows an explicit retry', async () => {
  await addAccount()
  // Intercept only this isolated app's history read; all other IPC retains its real trust checks.
  await app.evaluate(({ ipcMain }, channel) => {
    const handler = (ipcMain as any)._invokeHandlers.get(channel)
    if (!handler) throw new Error('Missing test IPC handler')
    ;(globalThis as any).__failHistory = true
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, command, input) =>
      command === 'unlikeHistory' && (globalThis as any).__failHistory
        ? { ok: false, error: { code: 'READ_FAILED', message: '受控历史读取失败' } }
        : handler(event, command, input)
    )
  }, CHANNEL)
  await page.getByRole('button', { name: '连接与任务', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('受控历史读取失败')
  await expect(page.getByText('任务历史暂不可用', { exact: true })).toBeVisible()
  await expect(page.getByText('还没有任务', { exact: true })).toHaveCount(0)
  await app.evaluate(() => {
    ;(globalThis as any).__failHistory = false
  })
  await page.getByRole('button', { name: '重新读取', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('region', { name: '取消点赞任务', exact: true })).toContainText('暂无记录')
})

test('keeps history results scoped while changing records and accounts', async ({}, info) => {
  const accountId = await addAccount()
  await app.evaluate(
    ({ ipcMain }, { channel, accountId }) => {
      const handler = (ipcMain as any)._invokeHandlers.get(channel)
      if (!handler) throw new Error('Missing test IPC handler')
      const tasks = ['first-task', 'second-task'].map((id, index) => ({
        id,
        accountId,
        remoteId: 'fixture',
        mode: 'single',
        status: 'paused',
        createdAt: Date.now() - index * 86400000,
        updatedAt: Date.now(),
        total: 1,
        pending: 0,
        inflight: 0,
        success: 0,
        failed: 0,
        unknown: 1,
        reason: '受控未知结果',
        errorCode: 'WRITE_UNKNOWN'
      }))
      ;(globalThis as any).__holdResult = true
      ;(globalThis as any).__verifiedTargets = []
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, command, input) => {
        if (input?.accountId === accountId) {
          if (command === 'unlikeHistory') return { ok: true, data: tasks }
          if (command === 'unlikeItems') {
            const second = input.taskId === 'second-task'
            if (second && (globalThis as any).__holdResult)
              await new Promise<void>((resolve) => {
                ;(globalThis as any).__releaseResult = resolve
              })
            return {
              ok: true,
              data: {
                total: 1,
                items: [
                  {
                    position: 0,
                    workId: second ? '7381234567890123457' : '7381234567890123456',
                    title: second ? '第二项结果' : '第一项结果',
                    status: 'unknown',
                    reason: null,
                    errorCode: 'WRITE_UNKNOWN'
                  }
                ]
              }
            }
          }
          if (command === 'unlikeVerify') {
            ;(globalThis as any).__verifiedTargets.push(input)
            return { ok: true, data: null }
          }
        }
        return handler(event, command, input)
      })
    },
    { channel: CHANNEL, accountId }
  )
  await page.getByRole('button', { name: '连接与任务', exact: true }).click()
  await expect(page.getByText('第一项结果', { exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: '取消点赞历史任务', exact: true }).click()
  await page.getByRole('option').nth(1).click()
  await expect(page.getByText('第一项结果', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '重新核验', exact: true })).toHaveCount(0)
  await expect.poll(() => app.evaluate(() => typeof (globalThis as any).__releaseResult)).toBe('function')
  await app.evaluate(() => {
    ;(globalThis as any).__holdResult = false
    ;(globalThis as any).__releaseResult()
  })
  await expect(page.getByText('第二项结果', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '重新核验', exact: true }).click()
  await expect
    .poll(() => app.evaluate(() => (globalThis as any).__verifiedTargets))
    .toEqual([{ accountId, taskId: 'second-task', workId: '7381234567890123457' }])
  await screenshot(info.outputPath('tasks-unknown-results.png'))
  await invoke('createAccount', { name: '另一个账号' })
  await expect(page.getByRole('region', { name: '取消点赞任务', exact: true })).toContainText('暂无记录')
  await expect(page.getByText('第二项结果', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '重新核验', exact: true })).toHaveCount(0)
})

test('cancels a still-loading login on close without waiting for navigation timeout or binding another account', async () => {
  const accountId = await addAccount()
  await installPlatform(accountId, 'page')
  const opening = invoke('login', { accountId })
  try {
    await expect
      .poll(() => app.evaluate(() => typeof (globalThis as any).__mylikeReleasePage))
      .toBe('function')
    await closeRemoteWindow(accountId)
    await expect.poll(async () => (await invoke('snapshot')).data.busy).toBe(false)
    expect(await opening).toMatchObject({ ok: false, error: { code: 'CANCELLED' } })
    const other = (await invoke('createAccount', { name: '加载取消后的另一个账号' })).data
    expect((await invoke('snapshot')).data).toMatchObject({
      activeAccountId: other.id,
      authentication: null,
      engine: { status: 'stopped' }
    })
  } finally {
    await app.evaluate(() => {
      ;(globalThis as any).__mylikeReleasePage?.()
    })
    await opening
  }
  expect(
    (await invoke('snapshot')).data.accounts.find((account: any) => account.id === accountId).remoteId
  ).toBeNull()
})

test('keeps collected work playable during a slow same-filter background refresh', async () => {
  const { accountId } = await prepareQueue(2)
  const card = page.getByRole('button', { name: /队列作品 1/ })
  await expect(card).toBeVisible()
  await app.evaluate(({ ipcMain }, channel) => {
    const handler = (ipcMain as any)._invokeHandlers.get(channel)
    ;(globalThis as any).__holdLibraryRefresh = true
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, command, input) => {
      if (command === 'query' && input.source !== 'favorites' && (globalThis as any).__holdLibraryRefresh)
        await new Promise<void>((resolve) => {
          ;(globalThis as any).__releaseLibraryRefresh = resolve
        })
      return handler(event, command, input)
    })
  }, CHANNEL)
  await invoke('collectPage', { accountId, continue: false })
  try {
    await expect
      .poll(() => app.evaluate(() => typeof (globalThis as any).__releaseLibraryRefresh))
      .toBe('function')
    await expect(card).toBeEnabled()
    await card.click()
    await expect(page.getByRole('region', { name: '播放器', exact: true })).toBeVisible()
  } finally {
    await app.evaluate(() => {
      ;(globalThis as any).__holdLibraryRefresh = false
      ;(globalThis as any).__releaseLibraryRefresh?.()
    })
  }
})

test('waits for page SDK initialization before sending hidden collection requests', async () => {
  const accountId = await addAccount()
  await installPlatform(accountId)
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeSlowPageSdk = true
  })
  const collecting = invoke('collectPage', { accountId, continue: false })
  try {
    await expect.poll(() => app.evaluate(() => typeof (globalThis as any).__releasePageSdk)).toBe('function')
    await page.waitForTimeout(1500)
    expect(
      await app.evaluate(
        () =>
          ((globalThis as any).__mylikeTestCalls as string[]).filter((url) => url.includes('/aweme/v1/'))
            .length
      )
    ).toBe(0)
  } finally {
    await app.evaluate(() => {
      ;(globalThis as any).__releasePageSdk?.()
    })
  }
  expect((await collecting).data).toMatchObject({ received: 1, added: 1 })
  expect(
    await app.evaluate(() =>
      ((globalThis as any).__mylikeTestCalls as string[])
        .filter((url) => url.includes('/aweme/v1/'))
        .every((url) => url.includes('_fixture_sdk=page-main-world'))
    )
  ).toBe(true)
})

test('wakes on changed login credentials, cancels a stale ten-second probe and still requires matching identity', async () => {
  const accountId = await addAccount()
  await installPlatform(accountId)
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeAuthLost = true
    ;(globalThis as any).__mylikeSlowFirstIdentity = true
    ;(globalThis as any).__identityDelayMs = 10000
  })
  await invoke('login', { accountId })
  await expect
    .poll(() =>
      app.evaluate(() =>
        ((globalThis as any).__mylikeTestCalls as string[]).some((url) => url.includes('/profile/self/'))
      )
    )
    .toBe(true)
  const hint = (value: string) =>
    app.evaluate(
      async ({ session }, { accountId, value }) => {
        await session.fromPartition(`persist:mylike-${accountId}`).cookies.set({
          url: 'https://www.douyin.com',
          name: 'sessionid',
          value,
          secure: true,
          httpOnly: true
        })
      },
      { accountId, value }
    )
  await hint('fixture-session-not-proof')
  await expect
    .poll(
      () =>
        app.evaluate(
          () =>
            ((globalThis as any).__mylikeTestCalls as string[]).filter((url) =>
              url.includes('/profile/self/')
            ).length
        ),
      { timeout: 4000 }
    )
    .toBeGreaterThan(1)
  expect((await invoke('snapshot')).data).toMatchObject({
    engine: { status: 'visible' },
    accounts: [{ remoteId: null }]
  })
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeAuthLost = false
  })
  await hint('fixture-session-logged-in')
  await expect.poll(async () => (await invoke('snapshot')).data.authentication, { timeout: 4000 }).toBeNull()
  expect((await invoke('snapshot')).data.engine.status).toBe('ready')
  const events = (await invoke('runtimeEvents', { accountId })).data
  expect(events).toEqual([])
  expect(JSON.stringify(events)).not.toMatch(/fixture-session|MS4wLjAB_fixture_identity/)
})

test('polls login every two seconds after an HTTP 200 identity rejection and closes without a cookie hint or thirty-second cooldown', async () => {
  const accountId = await addAccount()
  await installPlatform(accountId)
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeIdentityRejected = true
  })
  await invoke('login', { accountId })
  await expect
    .poll(
      () =>
        app.evaluate(
          () =>
            ((globalThis as any).__mylikeTestCalls as string[]).filter((url) =>
              url.includes('/profile/self/')
            ).length
        ),
      { timeout: 6000 }
    )
    .toBeGreaterThanOrEqual(2)
  expect((await invoke('snapshot')).data).toMatchObject({
    engine: { status: 'visible' },
    accounts: [{ remoteId: null }]
  })
  expect((await invoke('runtimeEvents', { accountId })).data).toEqual([])
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeIdentityRejected = false
  })
  await expect.poll(async () => (await invoke('snapshot')).data.authentication, { timeout: 4000 }).toBeNull()
  expect((await invoke('snapshot')).data.engine.status).toBe('ready')
  expect((await invoke('snapshot')).data.accounts[0].remoteId).toBeTruthy()
  expect((await invoke('runtimeEvents', { accountId })).data).toEqual([])
})

test('persists only exceptions and confirmed ends per account with a prominent verify button and MB sizes', async ({}, info) => {
  const { accountId } = await prepareQueue(2)
  const collectionBackground = await page
    .locator('.page-header .primary')
    .evaluate((node) => getComputedStyle(node).backgroundColor)
  await page.getByRole('button', { name: '连接与任务', exact: true }).click()
  const verify = page.getByRole('button', { name: '核验登录', exact: true })
  await expect(verify).toHaveCSS('background-color', collectionBackground)
  const rect = await verify.boundingBox()
  expect(rect!.height).toBeGreaterThanOrEqual(44)
  expect(rect!.width).toBeGreaterThanOrEqual(144)
  await expect(page.getByRole('button', { name: '从头遍历', exact: true })).toHaveCount(0)
  expect((await invoke('collectionStart', { accountId, mode: 'full' })).error.code).toBe('INVALID_INPUT')
  await invoke('collectionStart', { accountId, mode: 'update' })
  await expect.poll(async () => (await invoke('snapshot')).data.collection?.status).toBe('completed')
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeRateLimited = true
  })
  await invoke('collectionStart', { accountId, mode: 'update' })
  await expect.poll(async () => (await invoke('snapshot')).data.collection?.status).toBe('paused')
  await page.getByText('诊断与运行记录', { exact: true }).click()
  const history = page.getByRole('list', { name: '运行记录', exact: true })
  await expect(history).toContainText('确认触底')
  await expect(history).not.toContainText('接口已返回')
  await expect(history).not.toContainText('已开始')
  await expect(history).toContainText('HTTP 429')
  await expect(history).toContainText('RATE_LIMITED')
  await expect(history).toContainText('返回类型')
  await screenshot(info.outputPath('runtime-events-dark.png'))
  await page.getByRole('button', { name: '仪表盘', exact: true }).click()
  await expect(page.getByRole('group', { name: '数据占用', exact: true })).toContainText('MB')
  await app.close()
  await launch()
  const events = (await invoke('runtimeEvents', { accountId })).data
  expect(events.some((event: any) => event.code === 'END_CONFIRMED')).toBe(true)
  expect(events.some((event: any) => event.kind === 'task' && event.code === 'RATE_LIMITED')).toBe(true)
  const other = (await invoke('createAccount', { name: '独立运行记录' })).data
  expect((await invoke('runtimeEvents', { accountId: other.id })).data).toEqual([])
  expect((await invoke('runtimeEvents', { accountId })).error.code).toBe('ACCOUNT_CHANGED')
})

test('does not commit a temporary empty terminal response when rechecking returns more available works', async () => {
  const accountId = await addAccount()
  await installPlatform(accountId)
  await app.evaluate((_electron, workId) => {
    ;(globalThis as any).__mylikeLikedPages = {
      '0': [
        { aweme_list: [], has_more: 0, max_cursor: '0' },
        { aweme_list: [{ aweme_id: workId }], has_more: 1, max_cursor: '10' }
      ],
      '10': { aweme_list: [], has_more: 0, max_cursor: '0' }
    }
  }, workId)
  await invoke('collectionStart', { accountId, mode: 'update' })
  await expect.poll(async () => (await invoke('snapshot')).data.collectionActivity).toBe('confirming')
  expect((await invoke('snapshot')).data.collection).toMatchObject({
    status: 'running',
    cursor: '0',
    pages: 0
  })
  expect((await invoke('query', { accountId })).data.total).toBe(0)
  await expect
    .poll(async () => (await invoke('snapshot')).data.collection?.status, { timeout: 15000 })
    .toBe('completed')
  expect((await invoke('query', { accountId })).data.total).toBe(1)
  expect(
    await app.evaluate(() =>
      ((globalThis as any).__mylikeTestCalls as string[])
        .filter((url) => url.includes('/aweme/favorite/'))
        .map((url) => new URL(url).searchParams.get('max_cursor'))
    )
  ).toEqual(['0', '0', '10', '10'])
})

test('rechecks the retained terminal cursor after head updates and restart without a full rescan', async () => {
  const accountId = await addAccount()
  await installPlatform(accountId)
  await app.evaluate((_electron, workId) => {
    ;(globalThis as any).__mylikeLikedPages = {
      '0': { aweme_list: [{ aweme_id: workId }], has_more: 1, max_cursor: '10' },
      '10': { aweme_list: [], has_more: 0, max_cursor: '0' }
    }
  }, workId)
  await invoke('collectionStart', { accountId, mode: 'update' })
  await expect
    .poll(async () => (await invoke('snapshot')).data.collection)
    .toMatchObject({ status: 'completed', tailCursor: '10' })
  await app.evaluate((_electron, workId) => {
    ;(globalThis as any).__mylikeLikedPages = {
      '0': { aweme_list: [{ aweme_id: workId }], has_more: 1, max_cursor: '99' }
    }
  }, workId)
  await page.getByRole('button', { name: '更新', exact: true }).click()
  await expect
    .poll(async () => (await invoke('snapshot')).data.collection)
    .toMatchObject({ mode: 'incremental', status: 'completed', tailCursor: '10' })
  await app.close()
  await launch()
  await installPlatform(accountId)
  await app.evaluate((_electron, workId) => {
    ;(globalThis as any).__mylikeLikedPages = {
      '10': { aweme_list: [{ aweme_id: String(BigInt(workId) + 1n) }], has_more: 1, max_cursor: '20' },
      '20': { aweme_list: [], has_more: 0, max_cursor: '0' }
    }
  }, workId)
  await page.getByRole('button', { name: '连接与任务', exact: true }).click()
  await page.getByRole('button', { name: '复查末尾', exact: true }).click()
  await expect
    .poll(async () => (await invoke('snapshot')).data.collection)
    .toMatchObject({ mode: 'recheck', status: 'completed', tailCursor: '20', added: 1 })
  expect((await invoke('query', { accountId })).data.total).toBe(2)
  expect(
    await app.evaluate(() =>
      ((globalThis as any).__mylikeTestCalls as string[])
        .filter((url) => url.includes('/aweme/favorite/'))
        .map((url) => new URL(url).searchParams.get('max_cursor'))
    )
  ).toEqual(['10', '20', '20'])
})

for (const outcome of ['overlap', 'terminal-empty']) {
  test(`updates new likes independently of paused history on ${outcome} and resumes the original deep cursor after restart`, async ({}, info) => {
    const accountId = await addAccount()
    await installPlatform(accountId)
    const deep = '9007199254740993988'
    await app.evaluate(
      (_electron, { workId, deep }) => {
        ;(globalThis as any).__mylikeLikedPages = {
          '0': { aweme_list: [{ aweme_id: workId, desc: '历史作品' }], has_more: 1, max_cursor: deep }
        }
        ;(globalThis as any).__mylikeHoldLikesAt = deep
      },
      { workId, deep }
    )
    const previous = (await invoke('collectionStart', { accountId, mode: 'update' })).data
    await expect
      .poll(() => app.evaluate(() => typeof (globalThis as any).__mylikeReleaseLikes))
      .toBe('function')
    await invoke('collectionControl', { accountId, taskId: previous.id, action: 'pause' })
    await app.evaluate(
      (_electron, { workId, outcome }) => {
        ;(globalThis as any).__mylikeHoldLikesAt = null
        ;(globalThis as any).__mylikeReleaseLikes()
        ;(globalThis as any).__mylikeTestCalls.length = 0
        ;(globalThis as any).__mylikeLikedPages =
          outcome === 'terminal-empty'
            ? { '0': { aweme_list: [], has_more: 0, max_cursor: '0' } }
            : {
                '0': {
                  aweme_list: [
                    { aweme_id: workId },
                    { aweme_id: String(BigInt(workId) + 1n), desc: '新点赞一' }
                  ],
                  has_more: 1,
                  max_cursor: '10'
                },
                '10': {
                  aweme_list: [
                    { aweme_id: String(BigInt(workId) + 2n), desc: '新点赞二', create_time: 1500000000 }
                  ],
                  has_more: 1,
                  max_cursor: '20'
                },
                '20': { aweme_list: [{ aweme_id: workId }], has_more: 1, max_cursor: '30' }
              }
      },
      { workId, outcome }
    )
    await page.getByRole('button', { name: '更新', exact: true }).click()
    await expect
      .poll(async () => (await invoke('snapshot')).data.collection)
      .toMatchObject({
        mode: 'incremental',
        phase: 'head',
        status: 'completed',
        backfillCursor: deep,
        added: outcome === 'overlap' ? 2 : 0,
        pages: outcome === 'overlap' ? 3 : 1
      })
    expect((await invoke('snapshot')).data.collection.id).not.toBe(previous.id)
    expect((await invoke('query', { accountId })).data.total).toBe(outcome === 'overlap' ? 3 : 1)
    expect(
      await app.evaluate(() =>
        ((globalThis as any).__mylikeTestCalls as string[])
          .filter((url) => url.includes('/aweme/favorite/'))
          .map((url) => new URL(url).searchParams.get('max_cursor'))
      )
    ).toEqual(outcome === 'overlap' ? ['0', '10', '20'] : ['0', '0'])
    await expect(page.getByRole('button', { name: '继续历史采集', exact: true })).toBeVisible()
    await screenshot(info.outputPath(`incremental-${outcome}.png`))
    await page.getByRole('button', { name: '连接与任务', exact: true }).click()
    await expect(page.getByRole('region', { name: '自动采集任务' })).toContainText(
      '新增更新已完成；历史采集断点已保留'
    )
    if (outcome === 'overlap') {
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((win) =>
          win.webContents.getURL().startsWith('mylike://ui/')
        )!
        win.setSize(920, 640)
        win.webContents.setZoomFactor(1.5)
      })
      await expect
        .poll(() => page.locator('.task-center').evaluate((node) => node.scrollWidth - node.clientWidth))
        .toBeLessThanOrEqual(1)
      await page.getByRole('button', { name: '喜欢的内容', exact: true }).click()
      await expect(page.getByRole('button', { name: '更新', exact: true })).toBeVisible()
      expect(
        await page.locator('.main-area').evaluate((node) => node.scrollWidth - node.clientWidth)
      ).toBeLessThanOrEqual(1)
      await screenshot(info.outputPath('incremental-small.png'))
    }
    await app.close()
    await launch()
    await installPlatform(accountId)
    await app.evaluate(
      (_electron, { workId, deep }) => {
        ;(globalThis as any).__mylikeLikedPages = {
          [deep]: { aweme_list: [{ aweme_id: String(BigInt(workId) + 3n) }], has_more: 0, max_cursor: '0' }
        }
      },
      { workId, deep }
    )
    await page.getByRole('button', { name: '继续历史采集', exact: true }).click()
    await expect
      .poll(async () => (await invoke('snapshot')).data.collection)
      .toMatchObject({ phase: 'backfill', status: 'completed', added: 1 })
    expect(
      await app.evaluate(() =>
        ((globalThis as any).__mylikeTestCalls as string[])
          .filter((url) => url.includes('/aweme/favorite/'))
          .map((url) => new URL(url).searchParams.get('max_cursor'))
      )
    ).toEqual([deep, deep])
    expect((await invoke('query', { accountId })).data.total).toBe(outcome === 'overlap' ? 4 : 2)
  })
}

test('continues an interrupted incremental update without restarting on its newly saved head rows', async () => {
  const { accountId, ids } = await prepareQueue(1)
  await app.evaluate(
    (_electron, { workId, old }) => {
      ;(globalThis as any).__mylikeLikedPages = {
        '0': { aweme_list: [{ aweme_id: String(BigInt(workId) + 20n) }], has_more: 1, max_cursor: '10' },
        '10': { aweme_list: [{ aweme_id: String(BigInt(workId) + 21n) }], has_more: 1, max_cursor: '20' },
        '20': { aweme_list: [{ aweme_id: old }], has_more: 1, max_cursor: '30' }
      }
      ;(globalThis as any).__mylikeHoldLikesAt = '10'
    },
    { workId, old: ids[0] }
  )
  await page.getByRole('button', { name: '更新', exact: true }).click()
  await expect
    .poll(() => app.evaluate(() => typeof (globalThis as any).__mylikeReleaseLikes))
    .toBe('function')
  const task = (await invoke('snapshot')).data.collection
  expect(task).toMatchObject({ mode: 'incremental', cursor: '10', pages: 1, added: 1 })
  await invoke('collectionControl', { accountId, taskId: task.id, action: 'pause' })
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeReleaseLikes()
  })
  await app.close()
  await launch()
  await installPlatform(accountId)
  await app.evaluate(
    (_electron, { workId, old }) => {
      ;(globalThis as any).__mylikeLikedPages = {
        '10': { aweme_list: [{ aweme_id: String(BigInt(workId) + 21n) }], has_more: 1, max_cursor: '20' },
        '20': { aweme_list: [{ aweme_id: old }], has_more: 1, max_cursor: '30' }
      }
    },
    { workId, old: ids[0] }
  )
  await page.getByRole('button', { name: '继续更新', exact: true }).click()
  await expect
    .poll(async () => (await invoke('snapshot')).data.collection)
    .toMatchObject({
      id: task.id,
      mode: 'incremental',
      status: 'completed',
      added: 2,
      pages: 3,
      backfillCursor: null
    })
  expect(
    await app.evaluate(() =>
      ((globalThis as any).__mylikeTestCalls as string[])
        .filter((url) => url.includes('/aweme/favorite/'))
        .map((url) => new URL(url).searchParams.get('max_cursor'))
    )
  ).toEqual(['10', '20'])
  expect((await invoke('query', { accountId })).data.total).toBe(3)
})

test('guides a verified empty account to collection and keeps a breathing task indicator through page waits', async ({}, info) => {
  const accountId = await addAccount()
  await installPlatform(accountId)
  await expect(page.getByRole('button', { name: '打开抖音登录', exact: true })).toBeVisible()
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeAuthLost = true
  })
  await invoke('login', { accountId })
  await expect
    .poll(() =>
      app.evaluate(() =>
        ((globalThis as any).__mylikeTestCalls as string[]).some((url) => url.includes('/profile/self/'))
      )
    )
    .toBe(true)
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeAuthLost = false
  })
  await expect.poll(async () => (await invoke('snapshot')).data.authentication, { timeout: 5000 }).toBeNull()
  await expect(page.getByRole('heading', { name: '开始收录喜欢', exact: true })).toBeVisible()
  await expect(page.locator('.empty-state')).toContainText('点击上方“自动采集”')
  await expect(page.locator('.empty-state')).toContainText('采集途中也可以观看已收录的视频')
  await expect(page.getByRole('button', { name: '打开抖音登录', exact: true })).toHaveCount(0)
  await screenshot(info.outputPath('logged-in-empty-dark.png'))
  await page.getByRole('button', { name: '切换主题' }).click()
  await screenshot(info.outputPath('logged-in-empty-light.png'))
  await page.getByRole('button', { name: '收藏的内容', exact: true }).click()
  await expect(page.getByRole('heading', { name: '开始收录收藏', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '开始同步', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '喜欢的内容', exact: true }).click()
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeLongCollection = true
    ;(globalThis as any).__mylikeHoldLikesAt = '0'
  })
  await page.getByRole('button', { name: '开始采集', exact: true }).click()
  await expect
    .poll(() => app.evaluate(() => typeof (globalThis as any).__mylikeReleaseLikes))
    .toBe('function')
  await expect(page.getByRole('heading', { name: '正在收录内容', exact: true })).toBeVisible()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const dot = page.locator('.activity-dot')
  await expect(dot).toBeVisible()
  await expect(dot).toHaveCSS('animation-name', 'task-breathe')
  await expect(dot).toHaveCSS('animation-duration', '2.4s')
  const originalDot = await dot.elementHandle()
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeHoldLikesAt = '1'
    ;(globalThis as any).__mylikeReleaseLikes()
  })
  await expect.poll(async () => (await invoke('snapshot')).data.collection?.pages).toBe(1)
  await expect
    .poll(async () => (await invoke('snapshot')).data.busy, { intervals: [50], timeout: 2000 })
    .toBe(false)
  expect(await originalDot!.evaluate((node) => node.isConnected)).toBe(true)
  await expect(page.getByRole('button', { name: /测试视频：喜欢的日常/ })).toBeEnabled()
  await page.getByRole('button', { name: '连接与任务', exact: true }).click()
  await expect(page.locator('.task-working')).toBeVisible()
  expect(
    await page.locator('.task-working').evaluate((node) => getComputedStyle(node, '::after').animationName)
  ).toBe('task-breathe')
  await screenshot(info.outputPath('task-breathing-light.png'))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(dot).toHaveCSS('animation-name', 'none')
  await page.getByRole('button', { name: '暂停采集', exact: true }).click()
  await expect(dot).toHaveCount(0)
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeReleaseLikes?.()
  })
})

test('rechecks an empty liked-page cursor instead of skipping it and confirms the final marker', async () => {
  const accountId = await addAccount()
  await installPlatform(accountId)
  await app.evaluate((_electron, workId) => {
    ;(globalThis as any).__mylikeLikedPages = {
      '0': { aweme_list: [{ aweme_id: workId }], has_more: 1, max_cursor: '10' },
      '10': [
        { aweme_list: [], has_more: 1, max_cursor: '20' },
        { aweme_list: [{ aweme_id: String(BigInt(workId) + 1n) }], has_more: 1, max_cursor: '30' }
      ],
      '30': { aweme_list: [], has_more: 0, max_cursor: '0' }
    }
  }, workId)
  await invoke('collectionStart', { accountId, mode: 'update' })
  await expect
    .poll(async () => (await invoke('snapshot')).data.collection, { timeout: 35000 })
    .toMatchObject({ status: 'completed', pages: 3, added: 2, received: 2, errorCode: null })
  expect((await invoke('query', { accountId })).data.total).toBe(2)
  expect(
    await app.evaluate(() =>
      ((globalThis as any).__mylikeTestCalls as string[])
        .filter((url) => url.includes('/aweme/favorite/'))
        .map((url) => new URL(url).searchParams.get('max_cursor'))
    )
  ).toEqual(['0', '10', '10', '30', '30'])
})

test('recovers works behind stable empty liked pages and restarts from the original anchor when paused during a probe', async () => {
  test.setTimeout(testTimeout(90000))
  const accountId = await addAccount()
  await installPlatform(accountId)
  const prepare = async (hold: boolean) =>
    app.evaluate(
      async ({ session }, { accountId, workId, hold }) => {
        await session.fromPartition(`persist:mylike-${accountId}`).cookies.set({
          url: 'https://www.douyin.com',
          name: 'msToken',
          value: 'fixture-page-token',
          secure: true
        })
        ;(globalThis as any).__mylikeHoldLikesAt = hold ? '30' : null
        ;(globalThis as any).__mylikeLikedPages = {
          '0': { aweme_list: [{ aweme_id: workId }], has_more: 1, max_cursor: '10' },
          '10': { aweme_list: [], has_more: 1, max_cursor: '20' },
          '20': { aweme_list: [], has_more: 1, max_cursor: '30' },
          '30': { aweme_list: [{ aweme_id: String(BigInt(workId) + 1n) }], has_more: 0, max_cursor: '0' }
        }
      },
      { accountId, workId, hold }
    )
  await prepare(true)
  const task = (await invoke('collectionStart', { accountId, mode: 'update' })).data
  await expect
    .poll(
      () =>
        app.evaluate(() =>
          ((globalThis as any).__mylikeTestCalls as string[]).some(
            (url) => new URL(url).searchParams.get('max_cursor') === '30'
          )
        ),
      { timeout: 25000 }
    )
    .toBe(true)
  expect((await invoke('snapshot')).data.collection).toMatchObject({ cursor: '10', pages: 1, added: 1 })
  await invoke('collectionControl', { accountId, taskId: task.id, action: 'pause' })
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeReleaseLikes?.()
  })
  await app.close()
  await launch()
  await installPlatform(accountId)
  await prepare(false)
  await invoke('collectionControl', { accountId, taskId: task.id, action: 'resume' })
  await expect
    .poll(async () => (await invoke('snapshot')).data.collection, { timeout: 25000 })
    .toMatchObject({
      status: 'completed',
      cursor: '0',
      pages: 2,
      added: 2,
      tailCursor: '30'
    })
  expect((await invoke('query', { accountId })).data.total).toBe(2)
  const requests = await app.evaluate(() =>
    ((globalThis as any).__mylikeTestCalls as string[])
      .filter((url) => url.includes('/aweme/favorite/'))
      .map((url) => ({
        cursor: new URL(url).searchParams.get('max_cursor'),
        token: new URL(url).searchParams.get('msToken'),
        sdk: new URL(url).searchParams.get('_fixture_sdk')
      }))
  )
  expect(requests.map((request) => request.cursor)).toEqual(['10', '10', '20', '20', '30', '30'])
  expect(
    requests.every((request) => request.token === 'fixture-page-token' && request.sdk === 'page-main-world')
  ).toBe(true)
  const events = (await invoke('runtimeEvents', { accountId })).data
  expect(events.filter((event: any) => event.code === 'END_CONFIRMED')).toHaveLength(1)
  expect(JSON.stringify(events)).not.toContain('fixture-page-token')
})

for (const mode of ['advancing', 'stagnant']) {
  test(`keeps an ${mode} empty tail as a neutral pause with the original checkpoint and resumes after restart`, async ({}, info) => {
    test.setTimeout(testTimeout(120000))
    const accountId = await addAccount()
    await installPlatform(accountId)
    await app.evaluate(
      (_electron, { mode, workId }) => {
        const pages: Record<string, unknown> = {
          '0': { aweme_list: [{ aweme_id: workId }], has_more: 1, max_cursor: '10' }
        }
        for (let i = 10; i <= 15; i++)
          pages[String(i)] = {
            aweme_list: [],
            has_more: 1,
            max_cursor: mode === 'advancing' ? String(i + 1) : '0'
          }
        ;(globalThis as any).__mylikeLikedPages = pages
      },
      { mode, workId }
    )
    await invoke('collectionStart', { accountId, mode: 'update' })
    await expect
      .poll(async () => (await invoke('snapshot')).data.collection, { timeout: 90000 })
      .toMatchObject({
        status: 'paused',
        pages: 1,
        received: 1,
        added: 1,
        cursor: '10',
        errorCode: 'NO_AVAILABLE_ITEMS'
      })
    expect((await invoke('query', { accountId })).data.total).toBe(1)
    const cursors = await app.evaluate(() =>
      ((globalThis as any).__mylikeTestCalls as string[])
        .filter((url) => url.includes('/aweme/favorite/'))
        .map((url) => new URL(url).searchParams.get('max_cursor'))
    )
    expect(cursors).toEqual(
      mode === 'advancing'
        ? ['0', ...['10', '11', '12', '13', '14', '15'].flatMap((cursor) => [cursor, cursor])]
        : ['0', '10', '10', '10']
    )
    await page.getByRole('button', { name: '连接与任务', exact: true }).click()
    const task = page.getByRole('region', { name: '自动采集任务' })
    await expect(task).toContainText('待复查')
    await expect(task).toContainText('尚未确认末尾')
    await expect(task.getByRole('alert')).toHaveCount(0)
    await screenshot(info.outputPath(`empty-tail-${mode}.png`))
    await app.close()
    await launch()
    await installPlatform(accountId)
    await app.evaluate((_electron, workId) => {
      ;(globalThis as any).__mylikeLikedPages = {
        '10': { aweme_list: [{ aweme_id: String(BigInt(workId) + 1n) }], has_more: 0, max_cursor: '0' }
      }
    }, workId)
    await page.getByRole('button', { name: '连接与任务', exact: true }).click()
    await page
      .getByRole('region', { name: '自动采集任务' })
      .getByRole('button', { name: '继续采集', exact: true })
      .click()
    await expect
      .poll(async () => (await invoke('snapshot')).data.collection)
      .toMatchObject({ status: 'completed', pages: 2, added: 2, errorCode: null })
    expect((await invoke('query', { accountId })).data.total).toBe(2)
    expect(
      await app.evaluate(() =>
        ((globalThis as any).__mylikeTestCalls as string[])
          .filter((url) => url.includes('/aweme/favorite/'))
          .map((url) => new URL(url).searchParams.get('max_cursor'))
      )
    ).toEqual(['10', '10'])
  })
}

test('auto-closes first login with an ordinary SMS code dialog and captcha input', async () => {
  const accountId = await addAccount()
  await installPlatform(accountId)
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeAuthLost = true
    ;(globalThis as any).__mylikeLoginMarkup =
      '<section role="dialog" class="captcha-container" style="position:fixed;left:50px;top:50px;width:400px;height:300px;background:white"><h2>验证码登录</h2><label for="captcha-code">验证码</label><input id="captcha-code" style="width:200px;height:40px"><button>获取验证码</button></section>'
  })
  expect((await invoke('login', { accountId })).ok).toBe(true)
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeAuthLost = false
  })
  await expect.poll(async () => (await invoke('snapshot')).data.authentication).toBeNull()
  expect((await invoke('snapshot')).data).toMatchObject({
    engine: { status: 'ready' },
    accounts: [{ remoteId: 'MS4wLjAB_fixture_identity_1' }]
  })
})

test('auto-closes login after DOM readiness without waiting for a slow page image', async () => {
  const accountId = await addAccount()
  await installPlatform(accountId)
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeSlowLoginResource = true
  })
  const opening = invoke('login', { accountId })
  try {
    await expect
      .poll(() => app.evaluate(() => typeof (globalThis as any).__releaseLoginResource))
      .toBe('function')
    await expect.poll(async () => (await invoke('snapshot')).data.engine.status).toBe('ready')
    expect((await invoke('snapshot')).data.accounts[0].remoteId).toBe('MS4wLjAB_fixture_identity_1')
  } finally {
    await app.evaluate(() => {
      ;(globalThis as any).__releaseLoginResource?.()
    })
    await opening
  }
})

test('auto-closes login after the initial navigation is replaced by a login redirect', async () => {
  const accountId = await addAccount()
  await installPlatform(accountId)
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeRedirectLogin = true
  })
  expect((await invoke('login', { accountId })).ok).toBe(true)
  await expect.poll(async () => (await invoke('snapshot')).data.authentication).toBeNull()
  expect((await invoke('snapshot')).data).toMatchObject({
    engine: { status: 'ready' },
    accounts: [{ remoteId: 'MS4wLjAB_fixture_identity_1' }]
  })
})

for (const source of ['likes', 'favorites']) {
  test(`pauses ${source} on repeated content despite advancing cursors without discarding its checkpoint`, async () => {
    const accountId = await addAccount()
    await installPlatform(accountId)
    await app.evaluate((_electron, source) => {
      ;(globalThis as any).__mylikeReplayCollection = source === 'likes'
      ;(globalThis as any).__favoriteReplayPage = source === 'favorites'
    }, source)
    await invoke(source === 'likes' ? 'collectionStart' : 'favoritesStart', { accountId, mode: 'update' })
    const current = async () => {
      const snapshot = (await invoke('snapshot')).data
      return source === 'likes' ? snapshot.collection : snapshot.favorites
    }
    await expect.poll(current).toMatchObject({
      status: 'paused',
      pages: 2,
      cursor: '2',
      received: 2,
      added: 1,
      errorCode: 'CURSOR_STALLED'
    })
    await page.waitForTimeout(1500)
    expect(await current()).toMatchObject({ status: 'paused', pages: 2, cursor: '2' })
  })
}

test('auto-verifies first login, ignores hidden templates and captions, and keeps visible challenges open until cleared', async () => {
  const accountId = await addAccount()
  await installPlatform(accountId)
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeAuthLost = true
  })
  expect((await invoke('login', { accountId })).ok).toBe(true)
  await remoteChallenge(accountId, 'hidden')
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeAuthLost = false
  })
  await expect
    .poll(async () => (await invoke('snapshot')).data.accounts[0].remoteId)
    .toBe('MS4wLjAB_fixture_identity_1')
  await expect.poll(async () => (await invoke('snapshot')).data.engine.status).toBe('ready')
  await invoke('login', { accountId })
  await remoteChallenge(accountId, 'visible')
  await page.waitForTimeout(2800)
  expect((await invoke('snapshot')).data.engine.status).toBe('visible')
  await remoteChallenge(accountId, 'none')
  await expect.poll(async () => (await invoke('snapshot')).data.authentication).toBeNull()
  expect((await invoke('snapshot')).data.engine.status).toBe('ready')
})

for (const shape of ['html', 'json']) {
  test(`recognizes a ${shape} verification response and waits for the original likes API without committing probe pages or auto-resuming`, async () => {
    const { accountId } = await prepareQueue(2)
    await app.evaluate((_electron, shape) => {
      ;(globalThis as any).__mylikeChallengeResponse = shape
    }, shape)
    const task = (await invoke('collectionStart', { accountId, mode: 'update' })).data
    await expect
      .poll(async () => (await invoke('snapshot')).data.collection)
      .toMatchObject({ status: 'paused', errorCode: 'VERIFICATION_REQUIRED', pages: 0, cursor: '0' })
    await expect.poll(async () => (await invoke('snapshot')).data.authentication?.kind).toBe('verification')
    const requests = () =>
      app.evaluate(
        () =>
          ((globalThis as any).__mylikeTestCalls as string[]).filter((url) =>
            url.includes('/aweme/favorite/')
          ).length
      )
    const before = await requests()
    await expect.poll(requests).toBeGreaterThan(before)
    expect((await invoke('snapshot')).data.engine.status).toBe('visible')
    expect((await invoke('snapshot')).data.collection.pages).toBe(0)
    await app.evaluate(() => {
      ;(globalThis as any).__mylikeChallengeResponse = null
    })
    await expect.poll(async () => (await invoke('snapshot')).data.authentication).toBeNull()
    expect((await invoke('snapshot')).data).toMatchObject({
      engine: { status: 'ready' },
      collection: { id: task.id, status: 'paused', pages: 0, cursor: '0' }
    })
    expect((await invoke('query', { accountId })).data.total).toBe(2)
    expect((await invoke('collectionControl', { accountId, taskId: task.id, action: 'resume' })).ok).toBe(
      true
    )
    await expect.poll(async () => (await invoke('snapshot')).data.collection.status).toBe('completed')
  })
}

test('detects an in-page slider during a pending SDK read and stops verification without reopening or auto-resuming', async () => {
  const { accountId } = await prepareQueue(2)
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeHoldLikesAt = '0'
  })
  const task = (await invoke('collectionStart', { accountId, mode: 'update' })).data
  await expect
    .poll(() => app.evaluate(() => typeof (globalThis as any).__mylikeReleaseLikes))
    .toBe('function')
  await remoteChallenge(accountId, 'visible')
  await expect
    .poll(async () => (await invoke('snapshot')).data.collection)
    .toMatchObject({ status: 'paused', errorCode: 'VERIFICATION_REQUIRED', pages: 0 })
  await expect.poll(async () => (await invoke('snapshot')).data.engine.status).toBe('visible')
  expect((await invoke('collectionControl', { accountId, taskId: task.id, action: 'stop' })).ok).toBe(true)
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeHoldLikesAt = null
    ;(globalThis as any).__mylikeReleaseLikes()
  })
  await page.waitForTimeout(2800)
  expect((await invoke('snapshot')).data).toMatchObject({
    engine: { status: 'ready' },
    authentication: null,
    collection: { status: 'stopped', pages: 0, cursor: '0' }
  })
})

test('abandons verification on manual close without reopening or resuming when the challenge clears', async () => {
  const { accountId } = await prepareQueue(2)
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeChallengeResponse = 'json'
  })
  await invoke('collectionStart', { accountId, mode: 'update' })
  await expect.poll(async () => (await invoke('snapshot')).data.engine.status).toBe('visible')
  await closeRemoteWindow(accountId)
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeChallengeResponse = null
  })
  await page.waitForTimeout(6000)
  expect((await invoke('snapshot')).data).toMatchObject({
    engine: { status: 'ready' },
    authentication: null,
    collection: { status: 'paused', pages: 0 }
  })
})

test('discards a late login probe after closing the window and keeps a different account isolated', async () => {
  const accountId = await addAccount()
  await installPlatform(accountId)
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeSlowFirstIdentity = true
    ;(globalThis as any).__identityDelayMs = 6000
  })
  await invoke('login', { accountId })
  await expect
    .poll(() =>
      app.evaluate(() =>
        ((globalThis as any).__mylikeTestCalls as string[]).some((url) => url.includes('/profile/self/'))
      )
    )
    .toBe(true)
  await closeRemoteWindow(accountId)
  await expect.poll(async () => (await invoke('snapshot')).data.busy).toBe(false)
  const other = (await invoke('createAccount', { name: '另一个账号' })).data
  expect((await invoke('snapshot')).data).toMatchObject({ activeAccountId: other.id, authentication: null })
  expect(
    (await invoke('snapshot')).data.accounts.find((account: any) => account.id === accountId).remoteId
  ).toBeNull()
})

test('keeps the original binding and login window when the logged-in identity differs', async () => {
  const { accountId } = await prepareQueue(1)
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeOtherIdentity = true
  })
  await invoke('login', { accountId })
  await expect.poll(async () => (await invoke('snapshot')).data.authentication?.status).toBe('failed')
  expect((await invoke('snapshot')).data).toMatchObject({
    engine: { status: 'visible' },
    accounts: [{ remoteId: 'MS4wLjAB_fixture_identity_1' }]
  })
  await closeRemoteWindow(accountId)
})

test('bounds empty-response recovery to three reads and one rebuild, preserving the cursor without a false popup', async () => {
  test.setTimeout(testTimeout(120000))
  const { accountId } = await prepareQueue(1)
  const count = () =>
    app.evaluate(
      () =>
        ((globalThis as any).__mylikeTestCalls as string[]).filter((url) => url.includes('/aweme/favorite/'))
          .length
    )
  const before = await count()
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeChallengeResponse = 'empty'
  })
  await invoke('collectionStart', { accountId, mode: 'update' })
  await expect
    .poll(async () => (await invoke('snapshot')).data.collection?.status, { timeout: 90000 })
    .toBe('paused')
  expect(await count()).toBe(before + 3)
  expect((await invoke('snapshot')).data).toMatchObject({
    authentication: null,
    engine: { status: 'ready' },
    collection: { pages: 0, cursor: '0', errorCode: 'NO_AVAILABLE_ITEMS' }
  })
})

test('checks the failed folders API instead of accepting healthy identity or favorites and leaves probe results uncommitted', async () => {
  const { accountId } = await prepareQueue(1)
  await app.evaluate(() => {
    ;(globalThis as any).__favoriteChallengeFolder = true
  })
  await invoke('favoritesStart', { accountId })
  await expect.poll(async () => (await invoke('snapshot')).data.favorites?.status).toBe('paused')
  const before = (await invoke('snapshot')).data.favorites
  expect(before.errorCode).toBe('VERIFICATION_REQUIRED')
  await expect
    .poll(() =>
      app.evaluate(
        () =>
          ((globalThis as any).__favoriteRequests as any[]).filter((row) =>
            row.path.includes('/collects/list/')
          ).length
      )
    )
    .toBeGreaterThan(1)
  expect((await invoke('snapshot')).data.engine.status).toBe('visible')
  expect((await invoke('favoriteFolders', { accountId })).data).toEqual([])
  await app.evaluate(() => {
    ;(globalThis as any).__favoriteChallengeFolder = false
  })
  await expect.poll(async () => (await invoke('snapshot')).data.authentication).toBeNull()
  expect((await invoke('snapshot')).data.favorites).toMatchObject({
    status: 'paused',
    pages: before.pages,
    cursor: before.cursor
  })
  expect((await invoke('favoriteFolders', { accountId })).data).toEqual([])
  await invoke('favoritesControl', { accountId, taskId: before.id, action: 'resume' })
  await expect
    .poll(async () => (await invoke('snapshot')).data.favorites.status, { timeout: 30000 })
    .toBe('completed')
})

test('keeps an already-sent unlike alive through a visible slider and preserves its definite success without sending another write', async () => {
  const { accountId, ids } = await prepareQueue(2)
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeHoldUnlike = true
  })
  await invoke('unlikeStart', { accountId, workIds: ids, mode: 'batch' })
  await expect.poll(() => app.evaluate(() => (globalThis as any).__mylikeUnlikeCount)).toBe(1)
  await remoteChallenge(accountId, 'visible')
  await expect.poll(async () => (await invoke('snapshot')).data.authentication?.kind).toBe('verification')
  expect((await invoke('snapshot')).data.unlike).toMatchObject({ status: 'running', success: 0, unknown: 0 })
  await app.evaluate(() => {
    ;(globalThis as any).__mylikeHoldUnlike = false
    ;(globalThis as any).__mylikeReleaseUnlike()
  })
  await expect.poll(async () => (await invoke('snapshot')).data.unlike?.status).toBe('paused')
  expect((await invoke('snapshot')).data.unlike).toMatchObject({ success: 1, unknown: 0 })
  expect(await app.evaluate(() => (globalThis as any).__mylikeUnlikeCount)).toBe(1)
  await remoteChallenge(accountId, 'none')
  await expect.poll(async () => (await invoke('snapshot')).data.authentication).toBeNull()
  expect((await invoke('snapshot')).data.unlike).toMatchObject({ status: 'paused', success: 1, unknown: 0 })
})

test('adds liked work to multiple favorite folders through the page SDK and preserves fullscreen', async ({}, info) => {
  const { accountId } = await prepareQueue(3)
  await app.evaluate(() => {
    ;(globalThis as any).__favoriteWriteFixture = true
  })
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await readyVideo()
  const current = (await invoke('snapshot')).data.playback as QueueState
  await page.keyboard.press('f')
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true)
  const star = page.getByRole('button', { name: '收藏当前作品', exact: true })
  await star.click()
  const dialog = page.getByRole('dialog', { name: '选择收藏夹', exact: true })
  await expect(dialog.getByRole('checkbox', { name: '默认收藏列表', exact: true })).toBeChecked()
  await expect(dialog.getByRole('checkbox', { name: '默认收藏列表', exact: true })).toBeDisabled()
  await dialog.getByRole('checkbox', { name: '旅行', exact: true }).check()
  await dialog.getByRole('checkbox', { name: '音乐', exact: true }).check()
  expect(await app.evaluate(() => (globalThis as any).__favoriteWrites ?? [])).toEqual([])
  await page.keyboard.press('ArrowDown')
  expect((await invoke('snapshot')).data.playback.work.id).toBe(current.work.id)
  await screenshot(info.outputPath('favorite-picker-fullscreen.png'))
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(star).toHaveAttribute('aria-pressed', 'true')
  expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(true)
  const writes = await app.evaluate(() => (globalThis as any).__favoriteWrites)
  expect(writes.map((write: any) => write.operation)).toEqual([
    'favoriteAdd',
    'favoriteFolderAdd',
    'favoriteFolderAdd'
  ])
  expect(
    writes.every((write: any) => write.method === 'POST' && write.params._fixture_sdk === 'page-main-world')
  ).toBe(true)
  expect(writes[0].body).toMatchObject({ action: '1', aweme_id: current.work.id })
  for (const folderId of ['8', '9007199254740993999']) {
    const result = await invoke('query', { accountId, source: 'favorites', folderId })
    expect(result.data.items.map((item: any) => item.id)).toEqual([current.work.id])
  }
  expect((await invoke('query', { accountId, source: 'likes' })).data.total).toBe(3)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '返回内容库', exact: true }).click()
  await page.getByRole('button', { name: '收藏的内容', exact: true }).click()
  await expect(page.locator('.list-caption')).toContainText('1 条内容')
  await chooseOption('收藏夹筛选', '旅行 · 1')
  await expect(page.locator('.list-caption')).toContainText('1 条内容')
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await readyVideo()
  await expect(page.getByRole('button', { name: '收藏当前作品', exact: true })).toHaveCount(0)
})

test('creates private favorite folders, protects modal inputs and persists a custom favorite shortcut', async ({}, info) => {
  const { accountId } = await prepareQueue(2)
  await app.evaluate(() => {
    ;(globalThis as any).__favoriteWriteFixture = true
  })
  const preferences = (await invoke('snapshot')).data.playbackPreferences
  await invoke('playbackPreferences', {
    preferences: { ...preferences, shortcuts: { ...preferences.shortcuts, favorite: 'KeyB' } }
  })
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await readyVideo()
  const work = (await invoke('snapshot')).data.playback.work
  await expect(page.getByRole('button', { name: '收藏当前作品', exact: true })).toHaveAttribute('title', /B/)
  await page.keyboard.press('b')
  const dialog = page.getByRole('dialog', { name: '选择收藏夹', exact: true })
  await dialog.getByRole('button', { name: '新建', exact: true }).click()
  await dialog.getByRole('textbox', { name: '收藏夹名称', exact: true }).fill('新收藏夹')
  await page.keyboard.type('sq')
  expect((await invoke('snapshot')).data.playback.work.id).toBe(work.id)
  await expect(dialog.getByRole('checkbox', { name: '设为私密', exact: true })).toBeChecked()
  await screenshot(info.outputPath('favorite-create-folder.png'))
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(dialog.getByRole('checkbox', { name: '新收藏夹sq', exact: true })).toBeChecked()
  expect((await invoke('favoriteStatus', { accountId, workId: work.id })).data.collected).toBe(false)
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect((await invoke('query', { accountId, source: 'favorites', folderId: '9' })).data.total).toBe(1)
  const create = await app.evaluate(() => (globalThis as any).__favoriteWrites[0])
  expect(create).toMatchObject({
    operation: 'favoriteFolderCreate',
    params: { secret: '1', action: '1', version_code: '230000', collects_name: '新收藏夹sq' }
  })
  await page.getByRole('button', { name: '返回内容库', exact: true }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '快捷键', exact: true }).click()
  await expect(
    page.getByRole('combobox', { name: '收藏 / 取消收藏（当前作品）快捷键', exact: true })
  ).toHaveText('B')
  await app.close()
  await launch()
  expect((await invoke('snapshot')).data.playbackPreferences.shortcuts.favorite).toBe('KeyB')
  expect((await invoke('favoriteStatus', { accountId, workId: work.id })).data.collected).toBe(true)
})

test('keeps confirmed favorite progress after an empty write response and requires fresh reads instead of automatic retries', async () => {
  const { accountId } = await prepareQueue(2)
  await app.evaluate(() => {
    ;(globalThis as any).__favoriteWriteFixture = true
    ;(globalThis as any).__favoriteWriteFailure = 'favoriteFolderAdd'
  })
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await readyVideo()
  const work = (await invoke('snapshot')).data.playback.work
  await page.keyboard.press('s')
  const dialog = page.getByRole('dialog', { name: '选择收藏夹', exact: true })
  await dialog.getByRole('checkbox', { name: '音乐', exact: true }).check()
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('未自动重发')
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
  expect((await invoke('favoriteStatus', { accountId, workId: work.id })).data.collected).toBe(true)
  expect((await invoke('query', { accountId, source: 'favorites', folderId: '8' })).data.total).toBe(0)
  expect(await app.evaluate(() => (globalThis as any).__favoriteWrites.length)).toBe(2)
  await app.evaluate(() => {
    ;(globalThis as any).__favoriteWriteFailure = ''
  })
  await dialog.getByRole('button', { name: '重新读取', exact: true }).click()
  await dialog.getByRole('checkbox', { name: '音乐', exact: true }).check()
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect((await invoke('query', { accountId, source: 'favorites', folderId: '8' })).data.total).toBe(1)
  expect(
    await app.evaluate(() => (globalThis as any).__favoriteWrites.map((write: any) => write.operation))
  ).toEqual(['favoriteAdd', 'favoriteFolderAdd', 'favoriteFolderAdd'])
})

test('preserves an already sent favorite when a slider appears and never uses writes as recovery probes', async () => {
  const { accountId } = await prepareQueue(2)
  await app.evaluate(() => {
    ;(globalThis as any).__favoriteWriteFixture = true
    ;(globalThis as any).__favoriteWriteHold = 'favoriteAdd'
  })
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await readyVideo()
  const work = (await invoke('snapshot')).data.playback.work
  await page.keyboard.press('s')
  const dialog = page.getByRole('dialog', { name: '选择收藏夹', exact: true })
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect
    .poll(() => app.evaluate(() => typeof (globalThis as any).__releaseFavoriteWrite))
    .toBe('function')
  await remoteChallenge(accountId, 'visible')
  await expect.poll(async () => (await invoke('snapshot')).data.authentication?.kind).toBe('verification')
  await app.evaluate(() => {
    ;(globalThis as any).__favoriteWriteHold = ''
    ;(globalThis as any).__releaseFavoriteWrite()
  })
  await expect(dialog).toHaveCount(0)
  expect((await invoke('favoriteStatus', { accountId, workId: work.id })).data.collected).toBe(true)
  expect(await app.evaluate(() => (globalThis as any).__favoriteWrites.length)).toBe(1)
  await remoteChallenge(accountId, 'none')
  await expect.poll(async () => (await invoke('snapshot')).data.authentication).toBeNull()
  expect(await app.evaluate(() => (globalThis as any).__favoriteWrites.length)).toBe(1)
})

test('waits for the current favorite write on close, skips remaining folders and keeps the confirmed result after restart', async () => {
  const { accountId } = await prepareQueue(2)
  await app.evaluate(() => {
    ;(globalThis as any).__favoriteWriteFixture = true
    ;(globalThis as any).__favoriteWriteHold = 'favoriteAdd'
  })
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await readyVideo()
  const work = (await invoke('snapshot')).data.playback.work
  await page.keyboard.press('s')
  const dialog = page.getByRole('dialog', { name: '选择收藏夹', exact: true })
  await dialog.getByRole('checkbox', { name: '音乐', exact: true }).check()
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect
    .poll(() => app.evaluate(() => typeof (globalThis as any).__releaseFavoriteWrite))
    .toBe('function')
  await app.evaluate(() => {
    setTimeout(() => {
      ;(globalThis as any).__favoriteWriteHold = ''
      ;(globalThis as any).__releaseFavoriteWrite()
    }, 1000)
  })
  await app.close()
  await launch()
  expect((await invoke('favoriteStatus', { accountId, workId: work.id })).data.collected).toBe(true)
  expect((await invoke('favoriteFolders', { accountId })).data).toEqual([])
})

test('finishes empty favorite folders with null or omitted terminal arrays after repeated end confirmation', async () => {
  test.setTimeout(testTimeout(90000))
  const { accountId } = await prepareQueue(3)
  await app.evaluate(() => {
    ;(globalThis as any).__favoriteNullTerminals = true
  })
  await page.getByRole('button', { name: '收藏的内容', exact: true }).click()
  await page.getByRole('button', { name: '同步收藏', exact: true }).click()
  await expect
    .poll(async () => (await invoke('snapshot')).data.favorites, { timeout: 60000 })
    .toMatchObject({ status: 'completed', foldersDone: 3, foldersTotal: 3 })
  const requests = await app.evaluate(() => (globalThis as any).__favoriteRequests)
  for (const id of ['8', '9']) {
    expect(requests.filter((request: any) => request.folderId === id)).toHaveLength(2)
    expect((await invoke('query', { accountId, source: 'favorites', folderId: id })).data.total).toBe(0)
  }
  const events = (await invoke('runtimeEvents', { accountId })).data
  expect(events.some((event: any) => event.code === 'INVALID_RESPONSE')).toBe(false)
  expect(events.filter((event: any) => event.code === 'END_CONFIRMED').length).toBeGreaterThanOrEqual(5)
})

for (const kind of ['video', 'live'] as const) {
  test(`keeps ${kind} clean screen free of controls and restores the same frame by keyboard across zoom and prepared playback`, async ({}, info) => {
    test.setTimeout(testTimeout(120000))
    await prepareQueue(3, kind === 'live')
    const preferences = (await invoke('snapshot')).data.playbackPreferences
    await invoke('playbackPreferences', {
      preferences: { ...preferences, continuous: false }
    })
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((win) =>
        win.webContents.getURL().startsWith('mylike://ui/')
      )!
      win.setSize(1340, 900)
      win.showInactive()
    })
    await page.getByRole('button', { name: '顺序播放', exact: true }).click()
    await readyVideo(0)
    const media = page.locator('video')
    // RPC preference changes reach the renderer asynchronously. Pause through
    // the actual player before comparing pixels from a supposedly fixed frame.
    const pause = page.getByRole('button', { name: '暂停播放', exact: true })
    if (await pause.isVisible()) await pause.click()
    await expect(page.getByRole('button', { name: '开始播放', exact: true })).toBeVisible()
    await expect.poll(() => media.evaluate((node) => (node as HTMLVideoElement).paused)).toBe(true)
    const bounds = () =>
      page.evaluate(() => {
        const video = document.querySelector('video')!.getBoundingClientRect()
        const stage = document.querySelector('.stage')!.getBoundingClientRect()
        return {
          x: video.x,
          y: video.y,
          width: video.width,
          height: video.height,
          stage: { x: stage.x, y: stage.y, width: stage.width, height: stage.height }
        }
      })
    for (const zoom of [1, 1.25, 1.5]) {
      await app.evaluate(
        ({ BrowserWindow }, zoom) =>
          BrowserWindow.getAllWindows()
            .find((win) => win.webContents.getURL().startsWith('mylike://ui/'))!
            .webContents.setZoomFactor(zoom),
        zoom
      )
      await seekVideo(0.8)
      await expect.poll(() => media.evaluate((video) => (video as HTMLVideoElement).seeking)).toBe(false)
      expect(await media.evaluate((node) => (node as HTMLVideoElement).paused)).toBe(true)
      const pausedTime = await media.evaluate((node) => (node as HTMLVideoElement).currentTime)
      const original = await bounds()
      const element = await media.elementHandle()
      await page.mouse.move(0, 0)
      await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
      const before = await page
        .locator('.stage')
        .screenshot({ path: info.outputPath(`${kind}-${zoom}-before.png`) })
      await page.keyboard.press('h')
      await expect(page.getByRole('region', { name: '播放器', exact: true }).getByRole('button')).toHaveCount(
        0
      )
      await expect(page.locator('[popover]:popover-open')).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect.poll(bounds).toEqual(original)
      expect(await media.evaluate((node) => (node as HTMLVideoElement).paused)).toBe(true)
      expect(await media.evaluate((node) => (node as HTMLVideoElement).currentTime)).toBeCloseTo(
        pausedTime,
        3
      )
      expect(
        await element!.evaluate((video) => video.isConnected && video === document.querySelector('video'))
      ).toBe(true)
      await page.mouse.move(0, 0)
      await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
      const after = await page
        .locator('.stage')
        .screenshot({ path: info.outputPath(`${kind}-${zoom}-after.png`) })
      expect(
        changedPixels(before, after),
        'Paused media must retain its painted geometry, allowing tiny compositor rounding differences'
      ).toBeLessThan(0.001)
      await element?.dispose()
    }
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((win) => win.webContents.getURL().startsWith('mylike://ui/'))!
        .webContents.setZoomFactor(1)
    )
    await page.getByRole('button', { name: '开始播放', exact: true }).click()
    await page.keyboard.press('f')
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true)
    await expect
      .poll(async () => {
        const box = await bounds()
        return Math.abs(box.width - box.stage.width) < 1 && Math.abs(box.height - box.stage.height) < 1
      })
      .toBe(true)
    const fullscreenBounds = await bounds()
    await page.keyboard.press('h')
    await expect(page.getByRole('region', { name: '播放器', exact: true }).getByRole('button')).toHaveCount(0)
    await page.keyboard.press('f')
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false)
    await expect(page.getByRole('region', { name: '播放器', exact: true }).getByRole('button')).toHaveCount(0)
    await page.keyboard.press('f')
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true)
    await expect(page.getByRole('region', { name: '播放器', exact: true }).getByRole('button')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect.poll(bounds).toEqual(fullscreenBounds)
    await expect.poll(() => media.evaluate((video) => (video as HTMLVideoElement).paused)).toBe(false)
    await page.getByRole('button', { name: '暂停播放', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false)
    if (kind === 'video') {
      await expect
        .poll(() => app.evaluate(() => (globalThis as any).__mediaRequests?.length ?? 0))
        .toBeGreaterThan(1)
      await page.getByRole('button', { name: '下一条', exact: true }).click()
      await readyVideo(1)
      await expect(page.locator('.prepared-video')).toBeVisible()
      const original = await bounds()
      await page.keyboard.press('h')
      await page.keyboard.press('Escape')
      await expect.poll(bounds).toEqual(original)
    }
  })
}

async function prepareCollectedQueue(count = 3) {
  const fixture = await prepareQueue(count)
  await app.evaluate(() => {
    ;(globalThis as any).__favoriteWriteFixture = true
  })
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  for (let index = 0; index < count; index++) {
    await readyVideo(index)
    const queue = (await invoke('snapshot')).data.playback as QueueState
    const editor = await invoke('favoriteEditor', {
      accountId: fixture.accountId,
      queueId: queue.queueId,
      revision: queue.revision,
      workId: queue.work.id
    })
    expect(editor.ok).toBe(true)
    expect(
      (
        await invoke('favoriteSave', {
          accountId: fixture.accountId,
          token: editor.data.token,
          folderIds: ['8', '9007199254740993999']
        })
      ).ok
    ).toBe(true)
    if (index + 1 < count) await page.getByRole('button', { name: '下一条', exact: true }).click()
  }
  await page.getByRole('button', { name: '返回内容库', exact: true }).click()
  await page.getByRole('button', { name: '收藏的内容', exact: true }).click()
  await expect(page.locator('.list-caption')).toContainText(`${count} 条内容`)
  await app.evaluate(() => {
    ;(globalThis as any).__favoriteWrites = []
  })
  return fixture
}

test('uncollects current favorite with star and shortcut in fullscreen, synchronizes every folder and preserves likes', async ({}, info) => {
  test.setTimeout(testTimeout(90000))
  const { accountId } = await prepareCollectedQueue(2)
  await page.getByRole('button', { name: '顺序播放', exact: true }).click()
  await readyVideo(0)
  const current = (await invoke('snapshot')).data.playback as QueueState
  await page.keyboard.press('f')
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true)
  const star = page.getByRole('button', { name: '取消当前收藏', exact: true })
  await expect(star).toHaveAttribute('aria-pressed', 'true')
  await star.click()
  const confirm = page.getByRole('dialog', { name: '取消抖音收藏', exact: true })
  await expect(confirm).toContainText('所有收藏夹')
  await confirm.getByRole('button', { name: '取消', exact: true }).click()
  expect(await app.evaluate(() => (globalThis as any).__favoriteWrites)).toEqual([])
  await page.keyboard.press('s')
  await expect(confirm).toBeVisible()
  await screenshot(info.outputPath('uncollect-fullscreen-confirm.png'))
  await confirm.getByRole('button', { name: '确认取消抖音收藏', exact: true }).click()
  await expect(confirm).toHaveCount(0)
  await expect
    .poll(async () => (await invoke('snapshot')).data.unlike)
    .toMatchObject({ source: 'favorites', success: 1, unknown: 0, status: 'completed' })
  await expect(star).toBeDisabled()
  await expect(star).toHaveAttribute('aria-pressed', 'false')
  expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(true)
  expect((await invoke('snapshot')).data.playback.work.id).toBe(current.work.id)
  const writes = await app.evaluate(() => (globalThis as any).__favoriteWrites)
  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatchObject({
    operation: 'favoriteRemove',
    method: 'POST',
    body: { action: '0', aweme_id: current.work.id },
    params: { _fixture_sdk: 'page-main-world' }
  })
  for (const folderId of ['8', '9007199254740993999'])
    expect((await invoke('query', { accountId, source: 'favorites', folderId })).data.total).toBe(1)
  expect((await invoke('query', { accountId, source: 'likes' })).data.total).toBe(2)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '返回内容库', exact: true }).click()
  await expect(page.locator('.list-caption')).toContainText('1 条内容')
})

test('bulk uncollects the fixed favorites selection from a folder and persists results across restart', async ({}, info) => {
  test.setTimeout(testTimeout(90000))
  const { accountId } = await prepareCollectedQueue(3)
  await chooseOption('收藏夹筛选', '旅行 · 3')
  await page.getByRole('button', { name: '批量选择', exact: true }).click()
  await page.getByRole('button', { name: '选择全部筛选结果', exact: true }).click()
  await expect(page.getByLabel('批量操作')).toContainText('已选 3 条')
  await expect(page.getByRole('button', { name: '删除本地条目', exact: true })).toHaveCount(0)
  // A selected favorites queue must retain its source, rather than become a likes queue.
  await page.getByRole('button', { name: '播放所选', exact: true }).click()
  await readyVideo(0)
  expect((await invoke('snapshot')).data.playback.source).toBe('favorites')
  await expect(page.getByRole('button', { name: '取消当前收藏', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '返回内容库', exact: true }).click()
  await page.getByRole('button', { name: '取消抖音收藏', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: '取消抖音收藏', exact: true })
  await expect(confirm).toContainText('3 条作品')
  await confirm.getByRole('button', { name: '确认取消抖音收藏', exact: true }).click()
  await expect(page.getByRole('region', { name: '取消收藏任务', exact: true })).toBeVisible()
  await expect
    .poll(async () => (await invoke('snapshot')).data.unlike, { timeout: 15000 })
    .toMatchObject({ source: 'favorites', success: 3, status: 'completed' })
  await screenshot(info.outputPath('bulk-uncollect-complete.png'))
  expect((await invoke('query', { accountId, source: 'favorites' })).data.total).toBe(0)
  expect((await invoke('query', { accountId, source: 'likes' })).data.total).toBe(3)
  expect(
    (await invoke('favoriteFolders', { accountId })).data.every((folder: any) => folder.localCount === 0)
  ).toBe(true)
  const writes = await app.evaluate(() => (globalThis as any).__favoriteWrites)
  expect(writes).toHaveLength(3)
  expect(
    writes.every((write: any) => write.operation === 'favoriteRemove' && write.body.action === '0')
  ).toBe(true)
  await terminateApp(app, profile)
  await launch()
  expect((await invoke('snapshot')).data.unlike).toMatchObject({
    source: 'favorites',
    success: 3,
    status: 'completed'
  })
  expect((await invoke('query', { accountId, source: 'favorites' })).data.total).toBe(0)
})

test('pauses bulk uncollect on an unknown response and verifies read-only before continuing only unsent items', async () => {
  test.setTimeout(testTimeout(90000))
  const { accountId } = await prepareCollectedQueue(2)
  await app.evaluate(() => {
    ;(globalThis as any).__favoriteWriteFailure = 'favoriteRemove'
  })
  await page.getByRole('button', { name: '批量选择', exact: true }).click()
  await page.getByRole('button', { name: '选择全部筛选结果', exact: true }).click()
  await page.getByRole('button', { name: '取消抖音收藏', exact: true }).click()
  await page.getByRole('button', { name: '确认取消抖音收藏', exact: true }).click()
  await expect
    .poll(async () => (await invoke('snapshot')).data.unlike)
    .toMatchObject({ status: 'paused', unknown: 1, pending: 1 })
  const task = page.getByRole('region', { name: '取消收藏任务', exact: true })
  await expect(task).toContainText('结果未知 1')
  expect((await invoke('query', { accountId, source: 'favorites' })).data.total).toBe(2)
  await task.getByRole('button', { name: '重新核验', exact: true }).click()
  await expect
    .poll(async () => (await invoke('snapshot')).data.unlike)
    .toMatchObject({ unknown: 0, failed: 1, pending: 1 })
  expect(await app.evaluate(() => (globalThis as any).__favoriteWrites.length)).toBe(1)
  await app.evaluate(() => {
    ;(globalThis as any).__favoriteWriteFailure = ''
  })
  await task.getByRole('button', { name: '继续未发送项', exact: true }).click()
  await expect
    .poll(async () => (await invoke('snapshot')).data.unlike)
    .toMatchObject({ status: 'completed', success: 1, failed: 1, unknown: 0 })
  expect(await app.evaluate(() => (globalThis as any).__favoriteWrites.length)).toBe(2)
  expect((await invoke('query', { accountId, source: 'favorites' })).data.total).toBe(1)
  expect((await invoke('query', { accountId, source: 'likes' })).data.total).toBe(2)
})
