import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, screen } from 'electron'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve, join, sep, isAbsolute, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { commands, type Command } from '../shared/contracts'
import { CHANNEL, CHANGED, BEFORE_QUIT, QUIT_READY } from '../shared/channels'
import { Database } from './storage/client'
import { DouyinEngine } from './douyin/engine'
import { safeMediaUrl } from './douyin/parse'
import { Application } from './application'
import { AppError, publicError } from './errors'
import { restoreWindowState } from './window-state'
import { StorageLocation } from './storage-location'

protocol.registerSchemesAsPrivileged([
  { scheme: 'mylike', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])
// DComp can retain a stale video presentation rectangle after clean-mode
// relayout on Windows; resizing the native window clears it. Use Chromium's
// regular presentation path while retaining GPU rendering and video decoding.
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-direct-composition')
app.setName('MyLike')
const override = process.env.MYLIKE_USER_DATA
const testDirectory = override && isAbsolute(override) ? override : undefined
const installDirectory = app.isPackaged ? dirname(app.getPath('exe')) : undefined
const storage = new StorageLocation(
  testDirectory ?? join(app.getPath('appData'), 'MyLikeElectron'),
  installDirectory,
  installDirectory && !testDirectory ? installDirectory + ' 数据' : undefined
)
app.setPath('userData', storage.anchor)
let mainWindow: BrowserWindow | null = null
let service: Application | null = null
let quitting = false
let choosingStorage = false
let nextStorage: string | undefined
function isUiUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol === 'mylike:' && url.hostname === 'ui' && !url.username && !url.password) return true
    return (
      !app.isPackaged &&
      !!process.env.ELECTRON_RENDERER_URL &&
      url.origin === new URL(process.env.ELECTRON_RENDERER_URL).origin
    )
  } catch {
    return false
  }
}
let quitFlush: { nonce: string; resolve: () => void } | null = null
ipcMain.on(QUIT_READY, (event, nonce: unknown) => {
  if (
    mainWindow &&
    event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame &&
    nonce === quitFlush?.nonce
  )
    quitFlush?.resolve()
})
async function flushRenderer(): Promise<void> {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      quitFlush = null
      resolve()
    }
    const timer = setTimeout(done, 1200),
      nonce = randomUUID()
    quitFlush = { nonce, resolve: done }
    win.webContents.send(BEFORE_QUIT, nonce)
  })
}
const changed = () => {
  if (!quitting && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(CHANGED)
}

async function chooseStorage(win: BrowserWindow): Promise<null> {
  if (quitting || choosingStorage || nextStorage) throw new AppError('STORAGE_BUSY', '正在处理数据目录变更。')
  choosingStorage = true
  try {
    const current = app.getPath('userData')
    const selected = await dialog.showOpenDialog(win, {
      title: '选择新的数据目录',
      properties: ['openDirectory', 'createDirectory']
    })
    const path = selected.filePaths[0]
    if (selected.canceled || !path || quitting) return null
    const target = storage.check(current, path)
    const choice = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['取消', '迁移并重启'],
      defaultId: 1,
      cancelId: 0,
      message: '要移动 MyLike 的数据吗？',
      detail: `新位置：${target}\n\n应用将关闭并重新打开。数据库、备份和登录态会一起迁移，校验成功后才清理旧数据。迁移期间请保持目标磁盘连接。`
    })
    if (choice.response === 1 && !quitting) {
      nextStorage = target
      setImmediate(() => app.quit())
    }
    return null
  } finally {
    choosingStorage = false
  }
}

async function bootstrap(): Promise<void> {
  const db = new Database(join(app.getPath('userData'), 'mylike.sqlite'))
  await db.ready
  const preferences = await db.call('appPreferences', {})
  const remembered = preferences.rememberWindow
    ? restoreWindowState(
        await db.call('windowState', {}),
        screen.getAllDisplays().map((d) => d.workArea)
      )
    : null
  const root = resolve(__dirname, '../renderer')
  const uiSession = session.fromPartition('persist:mylike-ui')
  uiSession.protocol.handle('mylike', (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'ui') return new Response('Not found', { status: 404 })
      const file = resolve(
        root,
        '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
      )
      if (!file.startsWith(root + sep)) return new Response('Forbidden', { status: 403 })
      return net.fetch(pathToFileURL(file).toString())
    } catch {
      return new Response('Invalid path', { status: 400 })
    }
  })
  uiSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(
      permission === 'fullscreen' &&
        contents === mainWindow?.webContents &&
        'isMainFrame' in details &&
        details.isMainFrame &&
        isUiUrl(details.requestingUrl)
    )
  })
  uiSession.setPermissionCheckHandler(
    (contents, permission, _origin, details) =>
      permission === 'fullscreen' &&
      contents === mainWindow?.webContents &&
      details.isMainFrame &&
      isUiUrl(details.requestingUrl ?? contents.getURL())
  )
  uiSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (['image', 'media'].includes(details.resourceType) && safeMediaUrl(details.url))
      details.requestHeaders.Referer = 'https://www.douyin.com/'
    callback({ requestHeaders: details.requestHeaders })
  })
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 920,
    minHeight: 640,
    ...(remembered
      ? { x: remembered.x, y: remembered.y, width: remembered.width, height: remembered.height }
      : {}),
    show: false,
    title: 'MyLike',
    icon: join(app.getAppPath(), 'assets/icon.png'),
    backgroundColor: '#000000',
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { color: '#000000', symbolColor: '#f2f2f2', height: 30 }
        }
      : {}),
    webPreferences: {
      session: uiSession,
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  const win = mainWindow
  win.webContents.setZoomFactor(preferences.zoom)
  if (remembered?.maximized) win.maximize()
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      app.quit()
    }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.on('closed', () => {
    mainWindow = null
  })
  service = new Application(
    db,
    new DouyinEngine(changed, () => mainWindow),
    changed,
    () => mainWindow,
    () => storage.warning
  )
  ipcMain.handle(CHANNEL, async (event, command: unknown, input: unknown) => {
    try {
      const frameUrl = event.senderFrame?.url
      const trusted = frameUrl && isUiUrl(frameUrl)
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || !trusted)
        throw new AppError('FORBIDDEN', '此页面无权调用应用能力。')
      if (typeof command !== 'string' || !Object.hasOwn(commands, command))
        throw new AppError('INVALID_COMMAND', '不支持的操作。')
      const parsed = commands[command as Command].safeParse(input)
      if (!parsed.success) throw new AppError('INVALID_INPUT', '操作参数无效。')
      if (command === 'moveDataFolder') return { ok: true, data: await chooseStorage(win) }
      return { ok: true, data: await service!.execute(command as Command, parsed.data) }
    } catch (error) {
      return { ok: false, error: publicError(error) }
    }
  })
  mkdirSync(app.getPath('userData'), { recursive: true })
  await service.applyAppearance()
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL)
    await win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else await win.loadURL('mylike://ui/index.html')
  if (process.env.MYLIKE_HEADLESS !== '1') win.show()
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  let storageError: unknown
  try {
    mkdirSync(storage.anchor, { recursive: true })
    const directory = storage.prepare()
    app.setPath('userData', directory)
    app.setPath('sessionData', directory)
  } catch (error) {
    storageError = error
  }
  app.on('second-instance', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
  void app
    .whenReady()
    .then(() => {
      if (storageError) throw storageError
      return bootstrap()
    })
    .then(() => storage.finish())
    .catch((error) => {
      let restored = false
      try {
        restored = storage.restorePrevious()
      } catch {
        // The active path may be unavailable. Keep the recorded location.
      }
      if (process.env.MYLIKE_HEADLESS !== '1')
        dialog.showErrorBox(
          'MyLike 未能启动',
          restored
            ? '新数据位置未能启动，已恢复原位置。请重新打开 MyLike。'
            : error instanceof AppError
              ? error.message
              : '无法加载应用资源或数据库。原数据未重置，请检查文件权限、磁盘与版本。'
        )
      console.error(
        '[MyLike] Startup failed; user data was not reset.',
        error instanceof Error ? error.message : 'unknown error'
      )
      app.exit(1)
    })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void flushRenderer()
      .then(() => service?.close())
      .then(() => {
        if (!nextStorage) return
        storage.schedule(app.getPath('userData'), nextStorage)
        app.relaunch()
      })
      .catch((error: unknown) => {
        if (nextStorage && process.env.MYLIKE_HEADLESS !== '1')
          dialog.showErrorBox(
            '未能移动数据',
            error instanceof AppError ? error.message : '原数据仍在原位置，请重新打开 MyLike。'
          )
        console.error('[MyLike] Shutdown or storage relocation failed.')
      })
      .finally(() => app.quit())
  })
}
