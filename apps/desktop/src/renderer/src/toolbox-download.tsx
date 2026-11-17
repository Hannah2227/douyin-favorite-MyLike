import { useEffect, useRef, useState } from 'react'
import { call } from './api'
import './toolbox-download.css'

/** 抖音 CDN 的直链带签名，只有真正的视频流才拿去下载。 */
const VIDEO = /douyinvod|mime_type=video|\.mp4(\?|$)/i
const MUSIC = /\/ies-music|\.mp3(\?|$)|\.m4a(\?|$)/i

type Tone = 'info' | 'ok' | 'err'
type Status = { text: string; tone: Tone } | null

/** 先拿播放器正在播的流，拿不到再向主进程要一条新的签名地址。 */
async function resolveUrl(): Promise<string> {
  const local = document.querySelector('video')?.currentSrc ?? ''
  if (VIDEO.test(local) && !MUSIC.test(local)) return local
  try {
    const snapshot = await call(window.mylike.invoke('snapshot', {}))
    const playback = snapshot.playback
    if (!playback?.work?.id) return ''
    const media = (await call(
      window.mylike.invoke('media', {
        accountId: playback.accountId,
        workId: playback.work.id,
        playback: { queueId: playback.queueId, revision: playback.revision }
      })
    )) as { videos?: unknown[]; urls?: unknown[] } | null
    for (const item of [...(media?.videos ?? []), ...(media?.urls ?? [])]) {
      const url = typeof item === 'string' ? item : ((item as { url?: string }).url ?? '')
      if (url && VIDEO.test(url) && !MUSIC.test(url)) return url
    }
  } catch {
    // 取链失败就当作没有可下载的流
  }
  return ''
}

export function ToolboxDownload() {
  const queue = useRef<string[]>([])
  const busy = useRef(false)
  const done = useRef(0)
  const ticker = useRef<number | null>(null)
  const baseline = useRef<{ file: string; mtimeMs: number } | null>(null)
  const [status, setStatus] = useState<Status>(null)

  function stop() {
    if (ticker.current !== null) {
      window.clearInterval(ticker.current)
      ticker.current = null
    }
  }

  function poll() {
    stop()
    baseline.current = null
    ticker.current = window.setInterval(() => {
      void Promise.all([
        call(window.mylike.invoke('toolboxProgress', {})),
        call(window.mylike.invoke('toolboxDirectState', {}))
      ]).then(([progress, direct]) => {
        if (!baseline.current) {
          baseline.current = { file: progress.file, mtimeMs: progress.mtimeMs }
          return
        }
        const fresh =
          (progress.file !== '' && progress.file !== baseline.current.file) ||
          progress.mtimeMs > baseline.current.mtimeMs
        const size = fresh ? progress.size : 0
        const mb = (size / 1048576).toFixed(1)
        if (!direct.running && direct.exit !== null) {
          stop()
          if (direct.exit === 0 && size > 0) {
            done.current += 1
            setStatus({ text: `已完成 ${done.current} 个 · ${progress.file} · ${mb} MB`, tone: 'ok' })
          } else {
            setStatus({ text: `失败：${direct.err || `退出码 ${direct.exit}`}`, tone: 'err' })
          }
          runNext()
          return
        }
        setStatus({ text: `下载中 ${mb} MB · 保存到 ${progress.dir}`, tone: 'info' })
      }, () => stop())
    }, 1000)
  }

  function runNext() {
    const url = queue.current.shift()
    if (!url) {
      busy.current = false
      if (done.current > 0) {
        setStatus({ text: `全部下载结束：共 ${done.current} 个`, tone: 'ok' })
        window.setTimeout(() => setStatus(null), 6000)
      }
      done.current = 0
      return
    }
    busy.current = true
    setStatus({ text: '开始下载…', tone: 'info' })
    void call(window.mylike.invoke('toolboxDirect', { url })).then(
      (result) => {
        if (!result.ok) {
          busy.current = false
          setStatus({ text: `启动失败：${result.msg ?? ''}`, tone: 'err' })
          return
        }
        poll()
      },
      (error: Error) => {
        busy.current = false
        setStatus({ text: `启动失败：${error.message}`, tone: 'err' })
      }
    )
  }

  async function start() {
    const url = await resolveUrl()
    if (!url) {
      setStatus({ text: '这条作品没有可下载的视频流（音乐 / 图文 / 图集）', tone: 'err' })
      return
    }
    queue.current.push(url)
    const waiting = queue.current.length + (busy.current ? 1 : 0)
    setStatus({ text: `已加入队列（第 ${waiting} 个）`, tone: 'info' })
    if (!busy.current) runNext()
  }

  async function pickDir() {
    const result = await call(window.mylike.invoke('toolboxPickDir', {}))
    setStatus(
      result.ok
        ? { text: `保存位置已改为：${result.dir ?? ''}`, tone: 'ok' }
        : { text: `改目录失败：${result.msg ?? ''}`, tone: 'err' }
    )
  }

  async function reveal() {
    const result = await call(window.mylike.invoke('toolboxReveal', {}))
    if (!result.ok) setStatus({ text: `打不开：${result.msg ?? ''}`, tone: 'err' })
  }

  useEffect(() => stop, [])

  return (
    <>
      <button type="button" className="toolbox-control" title="用本机视频工具箱下载当前视频" onClick={() => void start()}>
        下载
      </button>
      <button type="button" className="toolbox-control" title="更改下载保存位置" onClick={() => void pickDir()}>
        目录
      </button>
      <button type="button" className="toolbox-control" title="在资源管理器中定位最新下载的文件" onClick={() => void reveal()}>
        打开
      </button>
      {status && (
        <div className={`toolbox-status ${status.tone}`} role="status" onClick={() => setStatus(null)}>
          {status.text}
        </div>
      )}
    </>
  )
}
