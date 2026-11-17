import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { shell } from 'electron'

/**
 * 本机「视频工具箱」：下载动作交给它做，MyLike 只负责下单、进度和定位文件。
 * 工具箱是外部依赖，缺失时所有命令都会返回 ok:false 而不是抛错。
 */
const TOOL_ROOT = 'D:\\dsh-jinyu\\tools\\video-downloader'
const SERVICE = 'http://127.0.0.1:8765'
const CONFIG = join(TOOL_ROOT, 'webtool-config.json')
const PYTHON = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Python312', 'python.exe')
const VIDEO = /\\.(mp4|mkv|webm|flv|m4a|mp3)$/i

export interface ToolboxProgress {
  ok: boolean
  dir: string
  file: string
  size: number
  mtimeMs: number
}

export interface ToolboxDirectState {
  running: boolean
  exit: number | null
  err: string
}

export interface ToolboxResult {
  ok: boolean
  dir?: string
  file?: string
  count?: number
  msg?: string
}

/** 保存目录以工具箱自己的配置为准，用户在那里改过就跟着改。 */
export function downloadDir(): string {
  try {
    const config = JSON.parse(readFileSync(CONFIG, 'utf8')) as { download_dir?: string }
    if (config.download_dir) return config.download_dir
  } catch {
    // 没有配置就用默认目录
  }
  return 'E:\\06-视频\\下载的视频'
}

/** 用下载目录里最新文件的字节数当进度——工具箱的 percent 对抖音方案恒为 0。 */
export function readProgress(): ToolboxProgress {
  const dir = downloadDir()
  try {
    let best: { name: string; size: number; mtimeMs: number } | null = null
    for (const name of readdirSync(dir)) {
      if (!VIDEO.test(name)) continue
      const info = statSync(join(dir, name))
      if (!best || info.mtimeMs > best.mtimeMs) best = { name, size: info.size, mtimeMs: info.mtimeMs }
    }
    return { ok: true, dir, file: best?.name ?? '', size: best?.size ?? 0, mtimeMs: best?.mtimeMs ?? 0 }
  } catch {
    return { ok: false, dir, file: '', size: 0, mtimeMs: 0 }
  }
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(SERVICE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  return (await response.json()) as Record<string, unknown>
}

export class Toolbox {
  private child: ChildProcess | null = null
  private exit: number | null = null
  private output = ''

  /** 走工具箱自己的任务通道（会做大小探测、排序、网盘同步）。 */
  async download(url: string): Promise<ToolboxResult> {
    try {
      const result = await post('/api/start', { mode: 'download', text: url, parallel: 1, dom_mode: 'auto' })
      return { ok: result.ok === true, count: Number(result.count ?? 0), msg: String(result.msg ?? '') }
    } catch {
      return { ok: false, msg: '视频工具箱没在运行：先双击「视频工具箱」再试。' }
    }
  }

  /**
   * 越过工具箱的任务通道，直接调用它自己的下载函数。
   * 实测它的 /api/start 对 douyinvod 直链会秒失败，而 DL.download 能正常下完。
   */
  direct(url: string): ToolboxResult {
    if (this.child) return { ok: false, msg: '上一条还在下载' }
    const dir = downloadDir()
    const script = [
      'import sys',
      'sys.path.insert(0, r"' + TOOL_ROOT + '")',
      'import downloader as DL',
      'DL.OUTDIR = sys.argv[2]',
      'code, out = DL.download(sys.argv[1], False)',
      'print("EXITCODE", code)',
      'print(out[-3000:])'
    ].join(';')
    try {
      const child = spawn(PYTHON, ['-c', script, url, dir], {
        env: {
          ...process.env,
          PYTHONPATH: join(TOOL_ROOT, 'ytdlp'),
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1'
        },
        windowsHide: true
      })
      this.child = child
      this.exit = null
      this.output = ''
      const collect = (chunk: Buffer) => {
        this.output = (this.output + chunk.toString('utf8')).slice(-4000)
      }
      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)
      child.on('exit', (code) => {
        this.exit = code
        this.child = null
      })
      return { ok: true, dir }
    } catch (error) {
      return { ok: false, msg: error instanceof Error ? error.message : String(error) }
    }
  }

  directState(): ToolboxDirectState {
    const exit = /EXITCODE\s+(-?\d+)/.exec(this.output)
    const error = this.output.split('\n').filter((line) => line.startsWith('ERROR')).pop() ?? ''
    return { running: this.child !== null, exit: exit ? Number(exit[1]) : this.exit, err: error.slice(0, 300) }
  }

  async state(): Promise<{ running: boolean; items: unknown[] }> {
    try {
      const response = await fetch(SERVICE + '/api/state')
      const data = (await response.json()) as { running?: boolean; items?: unknown[] }
      return { running: data.running === true, items: Array.isArray(data.items) ? data.items : [] }
    } catch {
      return { running: false, items: [] }
    }
  }

  async pickDir(): Promise<ToolboxResult> {
    try {
      const result = await post('/api/pickdir', {})
      return { ok: result.ok === true, dir: String(result.dir ?? ''), msg: String(result.msg ?? '') }
    } catch {
      return { ok: false, msg: '视频工具箱没在运行' }
    }
  }

  async reveal(): Promise<ToolboxResult> {
    const { dir, file } = readProgress()
    try {
      if (file) shell.showItemInFolder(join(dir, file))
      else await shell.openPath(dir)
      return { ok: true, dir, file }
    } catch (error) {
      return { ok: false, dir, msg: error instanceof Error ? error.message : String(error) }
    }
  }
}
