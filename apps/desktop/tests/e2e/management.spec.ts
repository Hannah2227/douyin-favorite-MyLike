import { testTimeout } from '../helpers/test-timeout'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { encodeTransfer } from '../../src/main/storage/transfer-format'
import { terminateApp } from '../helpers/terminate-app'

let app: ElectronApplication, page: Page, profile: string, files: string
async function launch() {
  app = await electron.launch({
    ...(process.env.MYLIKE_EXECUTABLE
      ? { executablePath: process.env.MYLIKE_EXECUTABLE, args: [] }
      : { args: [process.cwd()] }),
    env: { ...process.env, MYLIKE_HEADLESS: '1', MYLIKE_USER_DATA: profile },
    timeout: testTimeout(30000)
  })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.webContents.setBackgroundThrottling(false)
  )
  await expect(page.getByRole('heading', { name: '喜欢的内容' })).toBeVisible()
}
async function invoke(command: string, input: unknown = {}): Promise<any> {
  return page.evaluate(async ({ command, input }) => (window.mylike.invoke as any)(command, input), {
    command,
    input
  })
}
async function platform(accountId: string) {
  await app.evaluate(async ({ session }, accountId) => {
    const globals = globalThis as any
    globals.__writeCalls = []
    globals.__unknownFirst = false
    globals.__likeFlag = 1
    await session.fromPartition(`persist:mylike-${accountId}`).protocol.handle('https', async (request) => {
      const url = new URL(request.url)
      if (url.pathname === '/user/self')
        return new Response(
          `<!doctype html><script>
        const original = fetch.bind(window); window.fetch = (input, options) => { const url = new URL(input); url.searchParams.set('_fixture_sdk', 'main-world'); return original(url, options); };
        </script>Controlled platform fixture`,
          { headers: { 'content-type': 'text/html' } }
        )
      if (url.pathname.includes('/profile/self/'))
        return Response.json({
          status_code: 0,
          user: { sec_uid: `fixture_remote_${accountId}`, nickname: '受控用户' }
        })
      if (url.pathname.includes('/aweme/favorite/'))
        return Response.json({
          status_code: 0,
          has_more: 0,
          max_cursor: '0',
          aweme_list: ['1', '2'].map((id) => ({
            aweme_id: id,
            desc: `受控作品 ${id}`,
            create_time: 1700000000,
            author: { nickname: '受控作者' }
          }))
        })
      if (url.pathname.includes('/aweme/detail/'))
        return Response.json({
          status_code: 0,
          aweme_detail: { aweme_id: url.searchParams.get('aweme_id'), user_digged: globals.__likeFlag }
        })
      if (url.pathname.includes('/commit/item/digg/')) {
        globals.__writeCalls.push({
          method: request.method,
          body: await request.text(),
          sdk: url.searchParams.get('_fixture_sdk')
        })
        if (globals.__holdWrite)
          await new Promise<void>((r) => {
            globals.__releaseWrite = r
          })
        if (globals.__unknownFirst && globals.__writeCalls.length === 1) return Response.json({})
        return Response.json({ status_code: 0 })
      }
      return new Response('fixture not found', { status: 404 })
    })
  }, accountId)
}
async function account(name = '受控账号') {
  const result = await invoke('createAccount', { name })
  expect(result.ok).toBe(true)
  const id = result.data.id as string
  await platform(id)
  expect((await invoke('collectPage', { accountId: id, continue: false })).ok).toBe(true)
  await expect(page.locator('.list-caption')).toContainText('2 条内容')
  return id
}
async function dialogs(open: string | null, save: string | null = null) {
  await app.evaluate(
    ({ dialog }, { open, save }) => {
      ;(dialog as any).showOpenDialog = async () => ({ canceled: !open, filePaths: open ? [open] : [] })
      ;(dialog as any).showSaveDialog = async () => ({ canceled: !save, filePath: save ?? undefined })
    },
    { open, save }
  )
}
test.beforeEach(async () => {
  profile = mkdtempSync(join(tmpdir(), 'mylike-management-profile-'))
  files = mkdtempSync(join(tmpdir(), 'mylike-management-files-'))
  await launch()
})
test.afterEach(async () => {
  await app?.close().catch(() => {})
  for (const folder of [profile, files]) {
    if (dirname(resolve(folder)) !== resolve(tmpdir()) || !basename(folder).startsWith('mylike-management-'))
      throw new Error('Unsafe cleanup')
    rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('previews and cancels imports, merges after confirmation, and exports a fixed selection without secrets', async () => {
  const accountId = await account(),
    input = join(files, '元数据.json'),
    output = join(files, '导出.json')
  writeFileSync(
    input,
    encodeTransfer(
      [
        {
          id: '3',
          title: '<img src=x onerror=alert(1)>',
          author: '导入作者',
          publishedAt: 1700000000,
          coverUrl: null,
          mediaType: 'gallery',
          isLive: false,
          collectedAt: 1700000000000
        }
      ],
      'other'
    )
  )
  await dialogs(input, output)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '导入元数据', exact: true }).click()
  const modal = page.getByRole('dialog', { name: '合并导入元数据' })
  await expect(modal).toContainText('新增 1 条')
  await modal.getByRole('button', { name: '取消', exact: true }).click()
  expect((await invoke('query', { accountId })).data.total).toBe(2)
  await page.getByRole('button', { name: '导入元数据', exact: true }).click()
  await modal.getByRole('button', { name: '确认合并导入' }).click()
  await expect(modal).not.toBeVisible()
  expect((await invoke('query', { accountId })).data.total).toBe(3)
  const info = await invoke('dataInfo', { accountId })
  expect(info.data.backupsCount).toBeGreaterThan(0)
  await page.getByRole('button', { name: '喜欢的内容', exact: true }).click()
  await expect(page.getByRole('button', { name: /<img src=x onerror=alert\(1\)>/ })).toBeVisible()
  expect(await page.locator('img[src="x"]').count()).toBe(0)
  await page.getByRole('button', { name: '批量选择', exact: true }).click()
  await page.getByRole('button', { name: '选择全部筛选结果', exact: true }).click()
  await page.getByRole('button', { name: '导出所选', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '已导出 3 条' })).toBeVisible()
  const exported = readFileSync(output, 'utf8')
  expect(JSON.parse(exported).items).toHaveLength(3)
  expect(exported).not.toContain('remoteId')
  expect(exported).not.toContain('coverUrl')
  expect(exported).not.toContain('cookie')
  await dialogs(null)
  expect((await invoke('exportLibrary', { accountId, source: { type: 'ids', ids: ['1'] } })).data).toBeNull()
  expect((await invoke('query', { accountId })).data.total).toBe(3)
})

test('renames, clears cache without login loss, logs out only one session, and purges current data and backup records when deleting that account', async () => {
  const a = await account('账号 A'),
    b = await account('账号 B')
  await app.evaluate(
    async ({ session }, { a, b }) => {
      for (const id of [a, b])
        await session.fromPartition(`persist:mylike-${id}`).cookies.set({
          url: 'https://www.douyin.com',
          name: 'fixture_login',
          value: id,
          expirationDate: Date.now() / 1000 + 3600
        })
    },
    { a, b }
  )
  await expect(page.getByLabel('当前账号')).toContainText('账号 B')
  expect((await invoke('switchAccount', { accountId: a })).ok).toBe(true)
  // Direct IPC returns before the debounced account snapshot reaches the UI.
  // Wait for the selected account and its editor before entering a new name.
  await expect(page.getByLabel('当前账号')).toContainText('账号 A')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '本地账号名称' })).toHaveValue('账号 A')
  await page.getByRole('textbox', { name: '本地账号名称' }).fill('新的本地名称')
  await page.getByRole('button', { name: '保存名称', exact: true }).click()
  await expect(page.getByLabel('当前账号')).toContainText('新的本地名称')
  expect((await invoke('clearCache', { accountId: a })).ok).toBe(true)
  expect(
    await app.evaluate(
      async ({ session }, a) =>
        (await session.fromPartition(`persist:mylike-${a}`).cookies.get({ name: 'fixture_login' })).length,
      a
    )
  ).toBe(1)
  await page.getByRole('button', { name: '退出当前登录', exact: true }).click()
  await page.getByRole('button', { name: '确认退出登录', exact: true }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  expect(
    await app.evaluate(
      async ({ session }, { a, b }) =>
        Promise.all(
          [a, b].map(
            async (id) =>
              (await session.fromPartition(`persist:mylike-${id}`).cookies.get({ name: 'fixture_login' }))
                .length
          )
        ),
      { a, b }
    )
  ).toEqual([0, 1])
  expect((await invoke('query', { accountId: a })).data.total).toBe(2)
  expect((await invoke('snapshot')).data.accounts.find((x: any) => x.id === a).lastVerifiedAt).toBeNull()
  expect((await invoke('backup')).ok).toBe(true)
  await page.getByRole('button', { name: '删除当前账号', exact: true }).click()
  await page.getByRole('button', { name: '确认删除账号', exact: true }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  const state = (await invoke('snapshot')).data
  expect(state.accounts.map((x: any) => x.id)).toEqual([b])
  expect(state.activeAccountId).toBe(b)
  expect((await invoke('query', { accountId: b })).data.total).toBe(2)
  const backups = readdirSync(join(profile, 'backups')).filter((name) => name.endsWith('.sqlite'))
  expect(backups).toHaveLength(1)
  const db = new DatabaseSync(join(profile, 'backups', backups[0]!))
  try {
    expect(db.prepare('SELECT count(*) AS n FROM accounts').get()?.n).toBe(1)
    expect(db.prepare('SELECT id FROM accounts').get()?.id).toBe(b)
  } finally {
    db.close()
  }
  await app.close()
  await launch()
  expect((await invoke('snapshot')).data.activeAccountId).toBe(b)
  expect(
    await app.evaluate(
      async ({ session }, b) =>
        (await session.fromPartition(`persist:mylike-${b}`).cookies.get({ name: 'fixture_login' })).length,
      b
    )
  ).toBe(1)
})

test('requires explicit batch confirmation, persists unknown results, verifies read-only and resumes only unsent items', async () => {
  const accountId = await account()
  await app.evaluate(() => {
    ;(globalThis as any).__unknownFirst = true
  })
  await page.getByRole('button', { name: '批量选择', exact: true }).click()
  await page.getByRole('button', { name: '选择全部筛选结果', exact: true }).click()
  await page.getByRole('button', { name: '取消抖音点赞', exact: true }).click()
  const modal = page.getByRole('dialog', { name: '取消抖音点赞' })
  await expect(modal).toContainText('2 条作品')
  await modal.getByRole('button', { name: '取消', exact: true }).click()
  expect(await app.evaluate(() => (globalThis as any).__writeCalls.length)).toBe(0)
  await page.getByRole('button', { name: '取消抖音点赞', exact: true }).click()
  await modal.getByRole('button', { name: '确认取消抖音点赞', exact: true }).click()
  await expect(page.getByRole('heading', { name: '连接与任务' })).toBeVisible()
  await expect.poll(async () => (await invoke('snapshot')).data.unlike?.status).toBe('paused')
  const task = (await invoke('snapshot')).data.unlike
  expect(task).toMatchObject({ unknown: 1, pending: 1, success: 0 })
  expect((await invoke('query', { accountId })).data.total).toBe(2)
  const sent = await app.evaluate(() => (globalThis as any).__writeCalls)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ method: 'POST', sdk: 'main-world' })
  expect(new URLSearchParams(sent[0].body).get('type')).toBe('0')
  expect(new URLSearchParams(sent[0].body).get('item_type')).toBe('0')
  const unknownId = new URLSearchParams(sent[0].body).get('aweme_id')!
  expect((await invoke('unlikeStart', { accountId, workIds: [unknownId], mode: 'single' })).error.code).toBe(
    'UNRESOLVED_WRITE'
  )
  await app.close()
  await launch()
  await platform(accountId)
  expect((await invoke('snapshot')).data.unlike).toMatchObject({ unknown: 1, pending: 1 })
  expect(await app.evaluate(() => (globalThis as any).__writeCalls.length)).toBe(0)
  await app.evaluate(() => {
    ;(globalThis as any).__likeFlag = 0
  })
  await page.getByRole('button', { name: '连接与任务', exact: true }).click()
  await page.getByRole('button', { name: '重新核验', exact: true }).click()
  await expect.poll(async () => (await invoke('snapshot')).data.unlike.unknown).toBe(0)
  expect((await invoke('query', { accountId })).data.total).toBe(1)
  expect(await app.evaluate(() => (globalThis as any).__writeCalls.length)).toBe(0)
  await page.getByRole('button', { name: '继续未发送项', exact: true }).click()
  await expect.poll(async () => (await invoke('snapshot')).data.unlike.status).toBe('completed')
  expect((await invoke('snapshot')).data.unlike.success).toBe(2)
  expect((await invoke('query', { accountId })).data.total).toBe(0)
  expect(await app.evaluate(() => (globalThis as any).__writeCalls.length)).toBe(1)
})

test('stops future writes while preserving the inflight success and blocking concurrent collection or account switch', async () => {
  const accountId = await account()
  await app.evaluate(() => {
    ;(globalThis as any).__holdWrite = true
  })
  const start = await invoke('unlikeStart', { accountId, workIds: ['1', '2'], mode: 'batch' })
  expect(start.ok).toBe(true)
  await expect.poll(() => app.evaluate(() => (globalThis as any).__writeCalls.length)).toBe(1)
  expect((await invoke('collectionStart', { accountId, mode: 'update' })).error.code).toBe('BUSY')
  expect((await invoke('createAccount', { name: 'blocked' })).error.code).toBe('BUSY')
  const stop = invoke('unlikeControl', { accountId, taskId: start.data.id, action: 'stop' })
  await app.evaluate(() => {
    ;(globalThis as any).__releaseWrite()
  })
  expect((await stop).ok).toBe(true)
  expect((await invoke('snapshot')).data.unlike).toMatchObject({
    status: 'stopped',
    success: 1,
    pending: 1,
    unknown: 0
  })
  expect(await app.evaluate(() => (globalThis as any).__writeCalls.length)).toBe(1)
})

test('waits for an inflight write on clean app shutdown and never resumes unsent items after restart', async () => {
  const accountId = await account()
  await app.evaluate(() => {
    ;(globalThis as any).__holdWrite = true
  })
  expect((await invoke('unlikeStart', { accountId, workIds: ['1', '2'], mode: 'batch' })).ok).toBe(true)
  await expect.poll(() => app.evaluate(() => (globalThis as any).__writeCalls.length)).toBe(1)
  await app.evaluate(() => {
    setTimeout(() => (globalThis as any).__releaseWrite(), 2000)
  })
  await app.close()
  await launch()
  await platform(accountId)
  expect((await invoke('snapshot')).data.unlike).toMatchObject({
    status: 'stopped',
    success: 1,
    pending: 1,
    unknown: 0
  })
  expect((await invoke('query', { accountId })).data.total).toBe(1)
  expect(await app.evaluate(() => (globalThis as any).__writeCalls.length)).toBe(0)
})

test('preserves unknown writes after a forced process exit and resumes only unsent items', async () => {
  const accountId = await account()
  await app.evaluate(() => {
    ;(globalThis as any).__holdWrite = true
  })
  const task = await invoke('unlikeStart', { accountId, workIds: ['1', '2'], mode: 'batch' })
  expect(task.ok).toBe(true)
  await expect.poll(() => app.evaluate(() => (globalThis as any).__writeCalls.length)).toBe(1)
  const sentId = await app.evaluate(() =>
    new URLSearchParams((globalThis as any).__writeCalls[0].body).get('aweme_id')
  )
  await terminateApp(app, profile)
  // Reopen through the real application so SQLite performs its normal WAL recovery
  // before a second read-only connection checks structural integrity on Windows.
  await launch()
  const db = new DatabaseSync(join(profile, 'mylike.sqlite'), { readOnly: true })
  try {
    expect(db.prepare('PRAGMA quick_check').get()).toMatchObject({ quick_check: 'ok' })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0)
  } finally {
    db.close()
  }
  await platform(accountId)
  expect((await invoke('snapshot')).data.unlike).toMatchObject({
    id: task.data.id,
    status: 'paused',
    errorCode: 'INTERRUPTED',
    unknown: 1,
    pending: 1,
    success: 0
  })
  expect((await invoke('query', { accountId })).data.total).toBe(2)
  expect(await app.evaluate(() => (globalThis as any).__writeCalls.length)).toBe(0)
  expect((await invoke('unlikeStart', { accountId, workIds: [sentId], mode: 'single' })).error.code).toBe(
    'UNRESOLVED_WRITE'
  )
  expect((await invoke('unlikeControl', { accountId, taskId: task.data.id, action: 'resume' })).ok).toBe(true)
  await expect.poll(async () => (await invoke('snapshot')).data.unlike.status).toBe('completed')
  expect((await invoke('snapshot')).data.unlike).toMatchObject({ unknown: 1, success: 1, pending: 0 })
  const calls = await app.evaluate(() => (globalThis as any).__writeCalls)
  expect(calls).toHaveLength(1)
  expect(new URLSearchParams(calls[0].body).get('aweme_id')).not.toBe(sentId)
  expect((await invoke('query', { accountId })).data.items.map((item: { id: string }) => item.id)).toEqual([
    sentId
  ])
})

test('records an engine crash during a write as unknown and never repeats that write', async () => {
  const accountId = await account()
  await app.evaluate(() => {
    ;(globalThis as any).__holdWrite = true
  })
  const task = await invoke('unlikeStart', { accountId, workIds: ['1', '2'], mode: 'batch' })
  await expect.poll(() => app.evaluate(() => (globalThis as any).__writeCalls.length)).toBe(1)
  const sentId = await app.evaluate(() =>
    new URLSearchParams((globalThis as any).__writeCalls[0].body).get('aweme_id')
  )
  await app.evaluate(async ({ BrowserWindow, session }, accountId) => {
    const partition = session.fromPartition(`persist:mylike-${accountId}`)
    const engine = BrowserWindow.getAllWindows().find((win) => win.webContents.session === partition)!
    await new Promise<void>((resolve) => {
      engine.webContents.once('render-process-gone', () => resolve())
      engine.webContents.forcefullyCrashRenderer()
    })
  }, accountId)
  await expect.poll(async () => (await invoke('snapshot')).data.unlike.status).toBe('paused')
  expect((await invoke('snapshot')).data).toMatchObject({
    busy: false,
    unlike: { errorCode: 'BROWSER_CRASHED', unknown: 1, pending: 1, success: 0 }
  })
  expect((await invoke('query', { accountId })).data.total).toBe(2)
  await app.evaluate(() => {
    ;(globalThis as any).__holdWrite = false
    ;(globalThis as any).__releaseWrite()
  })
  expect((await invoke('unlikeControl', { accountId, taskId: task.data.id, action: 'resume' })).ok).toBe(true)
  await expect.poll(async () => (await invoke('snapshot')).data.unlike.status).toBe('completed')
  expect((await invoke('snapshot')).data.unlike).toMatchObject({ unknown: 1, success: 1, pending: 0 })
  const calls = await app.evaluate(() => (globalThis as any).__writeCalls)
  expect(calls).toHaveLength(2)
  expect(new URLSearchParams(calls[1].body).get('aweme_id')).not.toBe(sentId)
})
