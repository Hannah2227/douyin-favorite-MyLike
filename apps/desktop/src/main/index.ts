import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, screen } from 'electron'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve, join, sep, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { commands, type Command } from '../shared/contracts'
import { CHANNEL, CHANGED, BEFORE_QUIT, QUIT_READY } from '../shared/channels'
import { Database } from './storage/client'
import { DouyinEngine } from './douyin/engine'
import { safeMediaUrl } from './douyin/parse'
import { Application } from './application'
import { AppError, publicError } from './errors'
import { restoreWindowState } from './window-state'

protocol.registerSchemesAsPrivileged([
  { scheme: 'mylike', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])
app.setName('MyLike')
const data = process.env.MYLIKE_USER_DATA
if (data && isAbsolute(data)) app.setPath('userData', data)
else app.setPath('userData', join(app.getPath('appData'), 'MyLikeElectron'))
let mainWindow: BrowserWindow | null = null
let service: Application | null = null
let quitting = false
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
    backgroundColor: '#0d1018',
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { color: '#0d1018', symbolColor: '#c7cad3', height: 30 }
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
  service = new Application(db, new DouyinEngine(changed, () => mainWindow), changed, () => mainWindow)
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
  app.on('second-instance', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
  void app
    .whenReady()
    .then(() => {
      mkdirSync(app.getPath('userData'), { recursive: true })
      return bootstrap()
    })
    .catch((error) => {
      if (process.env.MYLIKE_HEADLESS !== '1')
        dialog.showErrorBox(
          'MyLike 未能启动',
          '无法加载应用资源或数据库。原数据未重置，请检查文件权限、磁盘与版本。'
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
      .catch(() => console.error('[MyLike] Shutdown persistence failure.'))
      .finally(() => app.quit())
  })
}
