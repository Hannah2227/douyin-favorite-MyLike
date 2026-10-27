import { useEffect, useRef, useState, type RefObject } from 'react'
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ImageIcon,
  LoaderCircle,
  Volume2,
  VolumeX,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  ListVideo,
  Maximize,
  Minimize,
  RotateCcw,
  HeartOff,
  Star,
  MessageCircle,
  X
} from 'lucide-react'
import type { PlaybackPosition, PlaybackPreferences } from '../../shared/contracts'
import type { Playback } from './usePlayback'
import { QueuePanel } from './QueuePanel'
import { MediaCaption, SeekBar, SpeedMenu } from './PlayerControls'
import { PreparedVideo } from './PreparedVideo'
import './player.css'
import { usePlayerShortcuts } from './usePlayerShortcuts'
import { keyLabel, type ShortcutAction } from '../../shared/preferences'
import { FavoriteDialog } from './FavoriteDialog'
import { call } from './api'
import { togglePlayerFullscreen } from './fullscreen'

type Props = {
  playback: Playback
  preferences: PlaybackPreferences
  updatePreferences: (patch: Partial<PlaybackPreferences>) => void
  operationError: string
  clearError: () => void
  login: () => void
  unlike: () => void
  unlikeBusy: boolean
  libraryRevision: number
  queueOpen: boolean
  setQueueOpen: (open: boolean) => void
  fullscreenRoot: RefObject<HTMLDivElement | null>
  fullscreenActive: boolean
  clean: boolean
  setClean: (clean: boolean) => void
  exit: () => Promise<void>
}
const seconds = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.min(86400, value)) : 0)
const clock = (value: number) =>
  `${Math.floor(seconds(value) / 60)}:${String(Math.floor(seconds(value) % 60)).padStart(2, '0')}`
export function Player({
  playback,
  preferences,
  updatePreferences,
  operationError,
  clearError,
  login,
  unlike,
  unlikeBusy,
  libraryRevision,
  queueOpen,
  setQueueOpen,
  fullscreenRoot,
  fullscreenActive,
  clean,
  setClean,
  exit
}: Props) {
  const { queue, media, error } = playback.view!,
    work = queue.work,
    scope = playback.key
  const stage = useRef<HTMLElement>(null),
    video = useRef<HTMLVideoElement>(null),
    poster = useRef<HTMLImageElement>(null),
    music = useRef<HTMLAudioElement>(null)
  const [image, setImage] = useState(queue.position.slide),
    [candidate, setCandidate] = useState(0),
    [mediaError, setMediaError] = useState('')
  const [playing, setPlaying] = useState(!queue.completed && preferences.autoplay),
    [slidePinned, setSlidePinned] = useState(false),
    [liveStill, setLiveStill] = useState(false),
    [ready, setReady] = useState(false),
    [musicTime, setMusicTime] = useState(0),
    [musicDuration, setMusicDuration] = useState(0),
    [videoTime, setVideoTime] = useState(queue.position.seconds),
    [videoDuration, setVideoDuration] = useState(0),
    [musicWarning, setMusicWarning] = useState('')
  const [captionExpanded, setCaptionExpanded] = useState(false)
  const [favoriteOpen, setFavoriteOpen] = useState(false),
    [collected, setCollected] = useState(false)
  useEffect(() => {
    let current = true
    void call(window.mylike.invoke('favoriteStatus', { accountId: queue.accountId, workId: work.id }))
      .then((state) => {
        if (current) setCollected(state.collected)
      })
      .catch(() => {})
    return () => {
      current = false
    }
  }, [queue.accountId, work.id, libraryRevision])
  const lastVolume = useRef(preferences.volume || 0.7)
  const hint = (id: ShortcutAction, text: string) =>
    preferences.shortcuts[id] === 'None' ? text : `${text} (${keyLabel(preferences.shortcuts[id])})`
  const playingRef = useRef(playing),
    imageRef = useRef(image),
    elapsed = useRef(queue.position.seconds),
    lastTick = useRef(performance.now()),
    endedOnce = useRef(queue.completed),
    musicEnded = useRef(false),
    liveHold = useRef<number | null>(null),
    resumeVideo = useRef(queue.position.seconds)
  const disposed = useRef(new WeakSet<HTMLMediaElement>())
  playingRef.current = playing
  imageRef.current = image
  const gallery = (media?.work.mediaType ?? work.mediaType) === 'gallery',
    slide = media?.images[image],
    source = gallery ? slide?.liveUrl : media?.videos[candidate]
  const position = (): PlaybackPosition => {
    if (!media) return queue.position
    return {
      seconds: gallery
        ? seconds(elapsed.current)
        : video.current && video.current.readyState >= 1
          ? seconds(video.current.currentTime)
          : seconds(resumeVideo.current),
      slide: gallery ? imageRef.current : 0,
      musicSeconds:
        music.current && music.current.readyState >= 1
          ? seconds(music.current.currentTime)
          : queue.position.musicSeconds
    }
  }
  const positionRef = useRef(position)
  positionRef.current = position
  useEffect(
    () =>
      playback.registerReader(
        scope,
        () => positionRef.current(),
        () => pause()
      ),
    [scope]
  )
  const pause = () => {
    playingRef.current = false
    setPlaying(false)
    video.current?.pause()
    music.current?.pause()
  }
  const play = () => {
    if (queue.completed) {
      void playback.replay()
      return
    }
    playingRef.current = true
    setPlaying(true)
    lastTick.current = performance.now()
    if (liveHold.current === null) void video.current?.play().catch(() => {})
    if (!musicEnded.current) void music.current?.play().catch(() => {})
  }
  const changeSlide = (index: number, manual = false) => {
    if (manual) setSlidePinned(true)
    liveHold.current = null
    setLiveStill(false)
    elapsed.current = 0
    resumeVideo.current = 0
    setImage(index)
    imageRef.current = index
    setReady(false)
    setMediaError('')
    lastTick.current = performance.now()
  }
  const end = () => {
    if (endedOnce.current || !playback.isCurrent(scope)) return
    endedOnce.current = true
    const value = positionRef.current()
    pause()
    void playback.ended(value, true, scope)
  }
  useEffect(() => {
    setCandidate(0)
    setMediaError('')
    setMusicWarning('')
    if (!media) {
      setReady(false)
      setLiveStill(false)
    }
    musicEnded.current = false
    liveHold.current = null
    elapsed.current = queue.position.seconds
    resumeVideo.current = queue.position.seconds
    if (media) {
      const index = Math.min(queue.position.slide, Math.max(0, media.images.length - 1))
      setImage(index)
      imageRef.current = index
    }
  }, [media])
  useEffect(() => {
    if (video.current) {
      video.current.volume = preferences.volume
      video.current.playbackRate = preferences.speed
    }
    if (music.current) {
      music.current.volume = preferences.volume
      music.current.playbackRate = preferences.speed
    }
  }, [preferences.volume, preferences.speed, source, media])
  useEffect(() => {
    const element = video.current
    if (element) disposed.current.delete(element)
    return () => {
      if (element) {
        disposed.current.add(element)
        element.pause()
        element.removeAttribute('src')
        element.load()
      }
    }
  }, [source])
  useEffect(() => {
    const audio = music.current
    return () => {
      if (audio) {
        disposed.current.add(audio)
        audio.pause()
        audio.removeAttribute('src')
        audio.load()
      }
    }
  }, [media?.music])
  useEffect(() => {
    // Music may already have ended when continuous playback is switched off.
    if (!preferences.continuous && music.current?.ended && playingRef.current) {
      musicEnded.current = false
      music.current.currentTime = 0
      void music.current.play().catch(() => {})
    }
  }, [preferences.continuous])
  useEffect(() => {
    if (!gallery || !media || !ready || !playing || queue.completed || mediaError) return
    lastTick.current = performance.now()
    const timer = setInterval(() => {
      if (!playingRef.current || !playback.isCurrent(scope)) return
      const now = performance.now()
      const delta = (now - lastTick.current) / 1000
      if (!slidePinned) elapsed.current += delta
      lastTick.current = now
      playback.report(scope, positionRef.current())
      if (source) {
        // Return to the matching still photo for two wall-clock seconds between
        // live clips, keeping music and the logical play state active.
        if (liveHold.current === null) return
        liveHold.current = Math.max(0, liveHold.current - delta)
        if (liveHold.current > 0) return
      } else if (elapsed.current < 3) return
      if (!slidePinned) {
        if (imageRef.current + 1 < media.images.length) {
          changeSlide(imageRef.current + 1)
          return
        }
        if (!preferences.continuous && media.images.length > 1) {
          changeSlide(0)
          return
        }
        if (preferences.continuous && (!media.music || musicEnded.current)) {
          end()
          return
        }
      }
      if (source && video.current) {
        liveHold.current = null
        video.current.currentTime = 0
        void video.current.play().catch(() => {})
      } else if (!preferences.continuous) elapsed.current = 0
    }, 200)
    return () => clearInterval(timer)
  }, [
    gallery,
    media,
    ready,
    playing,
    image,
    source,
    queue.completed,
    mediaError,
    slidePinned,
    preferences.continuous
  ])
  const seek = (amount: number) => {
    const element = gallery && music.current ? music.current : video.current
    if (element && Number.isFinite(element.duration))
      element.currentTime = Math.max(0, Math.min(element.duration, element.currentTime + amount))
  }
  const fullscreen = () => {
    void togglePlayerFullscreen(fullscreenRoot.current).catch(() => {})
  }
  const back = () => {
    pause()
    void exit()
  }
  const move = (target: 'next' | 'previous' | number) => {
    pause()
    void playback.move(target)
  }
  const openOriginal = () => {
    pause()
    void playback.original(scope).catch((e) => setMusicWarning(e.message))
  }
  const openFavorite = () => {
    if (unlikeBusy || favoriteOpen) return
    if (queue.source === 'favorites') {
      if (collected) {
        pause()
        unlike()
      }
      return
    }
    if (queue.source && queue.source !== 'likes') return
    pause()
    setFavoriteOpen(true)
  }
  const retryMedia = () => {
    pause()
    playingRef.current = true
    setPlaying(true)
    playback.retry()
  }
  const toggleMute = () => {
    if (preferences.volume > 0) {
      lastVolume.current = preferences.volume
      updatePreferences({ volume: 0 })
    } else updatePreferences({ volume: lastVolume.current })
  }
  useEffect(() => {
    if (!preferences.pauseOnBlur) return
    const blur = () => pause()
    window.addEventListener('blur', blur)
    return () => window.removeEventListener('blur', blur)
  }, [preferences.pauseOnBlur])
  const carousel = () => {
    if (!gallery) return
    if (!slidePinned) setSlidePinned(true)
    else {
      elapsed.current = 0
      lastTick.current = performance.now()
      setSlidePinned(false)
      play()
    }
  }
  const cycleSpeed = () => {
    const rates = [0.75, 1, 1.25, 1.5, 1.75, 2]
    updatePreferences({ speed: rates.find((rate) => rate > preferences.speed) ?? rates[0]! })
  }
  usePlayerShortcuts(
    preferences.shortcuts,
    {
      playPause: () => (playingRef.current ? pause() : play()),
      previous: () => queue.index > 0 && move('previous'),
      next: () => queue.index + 1 < queue.total && move('next'),
      seekBack: () => (gallery ? image > 0 && changeSlide(image - 1, true) : seek(-preferences.seekStep)),
      seekForward: () =>
        gallery
          ? media && image + 1 < media.images.length && changeSlide(image + 1, true)
          : seek(preferences.seekStep),
      fullscreen,
      queue: () => setQueueOpen(!queueOpen),
      clean: () => setClean(!clean),
      continuous: () => updatePreferences({ continuous: !preferences.continuous }),
      rateCycle: cycleSpeed,
      mute: toggleMute,
      original: openOriginal,
      favorite: openFavorite,
      unlike: () => {
        if ((!queue.source || queue.source === 'likes') && !unlikeBusy) {
          pause()
          unlike()
        }
      }
    },
    stage,
    back,
    () => {
      if (!clean) return false
      setClean(false)
      return true
    }
  )
  const wheelAction = useRef<(delta: number) => void>(() => {})
  wheelAction.current = (delta) => {
    if (!preferences.wheelNavigation || document.querySelector('dialog[open]') || !playback.isCurrent(scope))
      return
    const direction = delta > 0 ? 'next' : 'previous'
    if (
      (direction === 'next' && queue.index + 1 >= queue.total) ||
      (direction === 'previous' && queue.index === 0)
    )
      return
    if (playback.acceptWheel()) move(direction)
  }
  useEffect(() => {
    let delta = 0,
      at = 0
    const node = stage.current
    const wheel = (event: WheelEvent) => {
      if (
        event.ctrlKey ||
        event.metaKey ||
        Math.abs(event.deltaX) > Math.abs(event.deltaY) ||
        !(event.target instanceof Element) ||
        !event.target.closest('.stage') ||
        !!event.target.closest('.media-caption')
      )
        return
      event.preventDefault()
      if (Date.now() - at > 250 || Math.sign(delta) !== Math.sign(event.deltaY)) delta = 0
      at = Date.now()
      delta += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1)
      if (Math.abs(delta) >= 80) {
        wheelAction.current(delta)
        delta = 0
      }
    }
    node?.addEventListener('wheel', wheel, { passive: false })
    return () => node?.removeEventListener('wheel', wheel)
  }, [])
  const hasContent = !!source || !!slide
  return (
    <section
      ref={stage}
      className={`player-view${queueOpen && !clean ? ' queue-visible' : ''}${clean ? ' is-clean' : ''}`}
      aria-label="播放器"
    >
      <header className="player-heading">
        <button className="quiet" aria-label="返回内容库" title="返回内容库 (Esc)" onClick={back}>
          <ArrowLeft size={18} />
          返回
        </button>
      </header>
      {operationError && (
        <div className="player-notice" role="alert">
          {operationError}
          <button aria-label="关闭播放提示" onClick={clearError}>
            <X size={14} />
          </button>
        </div>
      )}
      <div className="player-body">
        <div className="stage">
          {!media && !error && (
            <div className="stage-message">
              <LoaderCircle className="spin" size={30} />
              <h2>正在获取播放地址</h2>
            </div>
          )}
          {(error || mediaError) && (
            <div className="stage-message" role="alert">
              <h2>暂时无法播放</h2>
              <p>{error || mediaError}</p>
              <div className="panel-actions">
                <button title="刷新播放地址" onClick={retryMedia}>
                  刷新地址重试
                </button>
                <button onClick={login}>打开登录 / 验证</button>
              </div>
            </div>
          )}
          {media && !hasContent && (
            <div className="stage-message">
              <ImageIcon size={30} />
              <h2>未取得可播放资源</h2>
              <p>可以打开原页查看作品状态。</p>
            </div>
          )}
          {source && !mediaError && (
            <PreparedVideo
              key={source}
              videoRef={video}
              element={!gallery && candidate === 0 ? playback.view?.prepared : undefined}
              volume={preferences.volume}
              speed={preferences.speed}
              src={source}
              className={liveStill ? 'live-resting' : undefined}
              aria-label="当前视频"
              aria-hidden={gallery && liveStill}
              onClick={() => (playingRef.current ? pause() : play())}
              onDoubleClick={fullscreen}
              autoPlay={playing && !queue.completed}
              loop={!gallery && !preferences.continuous}
              playsInline
              onLoadedMetadata={(event) => {
                const element = event.currentTarget
                setVideoDuration(seconds(element.duration))
                const seekTo = gallery
                  ? Math.min(elapsed.current, element.duration || 0)
                  : resumeVideo.current
                if (seekTo > 0)
                  element.currentTime = Math.min(
                    seekTo,
                    Number.isFinite(element.duration) ? Math.max(0, element.duration - 0.05) : seekTo
                  )
                setVideoTime(seconds(element.currentTime))
                setReady(true)
              }}
              onPlay={() => {
                if (!playback.isCurrent(scope) || queue.completed) {
                  video.current?.pause()
                  return
                }
                if (!playingRef.current) play()
              }}
              onPlaying={() => setLiveStill(false)}
              onPause={(event) => {
                if (gallery && (event.currentTarget.ended || liveHold.current !== null)) return
                if (!disposed.current.has(event.currentTarget) && playingRef.current) pause()
              }}
              onTimeUpdate={() => {
                if (!gallery) {
                  if (video.current && video.current.readyState >= 1)
                    resumeVideo.current = seconds(video.current.currentTime)
                  setVideoTime(resumeVideo.current)
                  playback.report(scope, positionRef.current())
                }
              }}
              onEnded={(event) => {
                if (!playback.isCurrent(scope) || disposed.current.has(event.currentTarget)) return
                if (gallery && event.currentTarget === video.current) {
                  liveHold.current = 2
                  lastTick.current = performance.now()
                  if (poster.current?.complete && poster.current.naturalWidth > 0) setLiveStill(true)
                  else event.currentTarget.currentTime = 0
                } else if (!gallery && preferences.continuous) end()
              }}
              onError={() => {
                resumeVideo.current = seconds(video.current?.currentTime ?? resumeVideo.current)
                if (media && !gallery && candidate + 1 < media.videos.length) {
                  setCandidate(candidate + 1)
                  setReady(false)
                } else {
                  setMediaError('媒体地址不可用或解码失败。请刷新地址或打开原页。')
                  pause()
                }
              }}
            />
          )}
          {source && gallery && slide && (
            <img
              key={slide.url}
              ref={poster}
              className={`gallery-image live-poster${liveStill ? ' is-visible' : ''}`}
              src={slide.url}
              alt={`实况第 ${image + 1} 张静态照片`}
              aria-hidden={!liveStill}
              onClick={() => (playingRef.current ? pause() : play())}
              onDoubleClick={fullscreen}
              onLoad={() => {
                if (liveHold.current !== null) setLiveStill(true)
              }}
              onError={() => {
                setLiveStill(false)
                if (liveHold.current !== null && video.current) video.current.currentTime = 0
              }}
            />
          )}
          {!source && slide && (
            <img
              className="gallery-image"
              src={slide.url}
              alt={`图集第 ${image + 1} 张`}
              onClick={() => (playingRef.current ? pause() : play())}
              onLoad={() => setReady(true)}
              onError={() => {
                setMediaError('图片未能加载，请刷新地址重试。')
                pause()
              }}
            />
          )}
          {media?.music && gallery && (
            <audio
              key={media.music}
              ref={music}
              src={media.music}
              autoPlay={playing && !queue.completed}
              loop={!preferences.continuous}
              onLoadedMetadata={(event) => {
                const element = event.currentTarget
                if (queue.position.musicSeconds > 0)
                  element.currentTime = Math.min(
                    queue.position.musicSeconds,
                    Number.isFinite(element.duration)
                      ? Math.max(0, element.duration - 0.05)
                      : queue.position.musicSeconds
                  )
                setMusicDuration(seconds(element.duration))
              }}
              onTimeUpdate={(event) => setMusicTime(seconds(event.currentTarget.currentTime))}
              onEnded={() => {
                musicEnded.current = true
              }}
              onSeeked={(event) => {
                musicEnded.current =
                  Number.isFinite(event.currentTarget.duration) &&
                  event.currentTarget.currentTime >= event.currentTarget.duration - 0.05
                if (playingRef.current && !musicEnded.current) void event.currentTarget.play().catch(() => {})
              }}
              onError={() => {
                musicEnded.current = true
                setMusicWarning('图集音乐暂时不可用，仍可查看图片。')
              }}
            />
          )}
          {!playing && hasContent && !queue.completed && !mediaError && (
            <button className="stage-play" aria-label="继续播放媒体" onClick={() => play()}>
              <Play size={52} fill="currentColor" />
            </button>
          )}
          {queue.completed && media && (
            <div className="playback-completed">
              <h2>本轮播放已结束</h2>
              <button title="从头重播" onClick={() => void playback.replay()}>
                <RotateCcw size={17} />
                重新播放当前作品
              </button>
            </div>
          )}
          {media && media.images.length > 1 && (
            <>
              <button
                className="gallery-arrow previous-image"
                aria-label="上一张"
                title={hint('seekBack', '上一张')}
                disabled={image === 0}
                onClick={() => changeSlide(image - 1, true)}
              >
                <ChevronLeft />
              </button>
              <button
                className="gallery-arrow next-image"
                aria-label="下一张"
                title={hint('seekForward', '下一张')}
                disabled={image === media.images.length - 1}
                onClick={() => changeSlide(image + 1, true)}
              >
                <ChevronRight />
              </button>
            </>
          )}
          {media && hasContent && !mediaError && (
            <MediaCaption
              author={work.author}
              title={work.title}
              publishedAt={work.publishedAt}
              gallery={gallery}
              expanded={captionExpanded}
              toggle={() => setCaptionExpanded(!captionExpanded)}
              hint="展开 / 收起文案"
            />
          )}
          {gallery && media && (
            <div className="gallery-status">
              <span>
                {image + 1} / {media.images.length}
              </span>
              {slidePinned && (
                <button title="恢复轮播" onClick={carousel}>
                  恢复轮播
                </button>
              )}
            </div>
          )}
        </div>
        {queueOpen && <QueuePanel queue={queue} jump={move} close={() => setQueueOpen(false)} />}
      </div>
      <footer className="player-footer">
        {!gallery && (
          <SeekBar
            label="视频进度"
            duration={videoDuration}
            value={Math.min(videoTime, videoDuration || 1)}
            disabled={!ready || !videoDuration}
            change={(value) => {
              if (video.current) {
                video.current.currentTime = value
                setVideoTime(value)
              }
            }}
          />
        )}
        {gallery && media?.music && (
          <SeekBar
            label="音乐进度"
            duration={musicDuration}
            value={Math.min(musicTime, musicDuration || 1)}
            change={(value) => {
              if (music.current) music.current.currentTime = value
            }}
          />
        )}
        <div className="playback-controls">
          <div className="player-main-controls">
            <button
              aria-label="上一条"
              title={hint('previous', '上一条')}
              disabled={queue.index === 0}
              onClick={() => move('previous')}
            >
              <SkipBack size={19} />
            </button>
            <button
              aria-label={playing ? '暂停播放' : '开始播放'}
              title={hint('playPause', playing ? '暂停播放' : '开始播放')}
              onClick={() => (playingRef.current ? pause() : play())}
            >
              {playing ? <Pause size={20} /> : <Play size={20} />}
            </button>
            <button
              aria-label="下一条"
              title={hint('next', '下一条')}
              disabled={queue.index + 1 >= queue.total}
              onClick={() => move('next')}
            >
              <SkipForward size={19} />
            </button>
            <span className="player-time">
              {clock(gallery ? musicTime : videoTime)} / {clock(gallery ? musicDuration : videoDuration)}
            </span>
            <span
              className="player-queue-position"
              title={queue.mode === 'shuffle' ? '洗牌播放' : '顺序播放'}
            >
              {queue.index + 1} / {queue.total}
            </span>
          </div>
          <div className="player-tools">
            {musicWarning && (
              <span className="music-warning" role="status">
                {musicWarning}
              </span>
            )}
            <label className="continuous-control" title={hint('continuous', '关闭时循环当前作品')}>
              <input
                type="checkbox"
                checked={preferences.continuous}
                onChange={(event) => updatePreferences({ continuous: event.target.checked })}
              />
              连播
            </label>
            <label className="clean-control" title={hint('clean', '清屏 / 退出清屏')}>
              <input
                type="checkbox"
                checked={clean}
                onChange={(event) => {
                  setClean(event.target.checked)
                  event.target.blur()
                }}
              />
              清屏
            </label>
            {(!queue.source || queue.source === 'likes' || queue.source === 'favorites') && (
              <button
                className={`favorite-control${collected ? ' is-collected' : ''}`}
                aria-label={queue.source === 'favorites' ? '取消当前收藏' : '收藏当前作品'}
                aria-pressed={collected}
                title={hint(
                  'favorite',
                  queue.source === 'favorites'
                    ? collected
                      ? '取消当前收藏（需确认）'
                      : '已取消收藏'
                    : collected
                      ? '已收藏，添加至收藏夹'
                      : '收藏 / 选择收藏夹'
                )}
                disabled={unlikeBusy || (queue.source === 'favorites' && !collected)}
                onClick={openFavorite}
              >
                <Star size={19} fill="currentColor" />
              </button>
            )}
            {(!queue.source || queue.source === 'likes') && (
              <button
                className="unlike-control"
                aria-label="取消当前点赞"
                title={hint('unlike', '取消当前点赞（需确认）')}
                disabled={unlikeBusy}
                onClick={() => {
                  pause()
                  unlike()
                }}
              >
                <HeartOff size={19} />
              </button>
            )}
            <button
              aria-label="打开原页"
              title={hint('original', '在系统浏览器打开原页看评论')}
              onClick={openOriginal}
            >
              <MessageCircle size={19} />
            </button>
            <button
              aria-label="显示播放队列"
              title={hint('queue', '播放队列')}
              aria-pressed={queueOpen}
              onClick={() => setQueueOpen(!queueOpen)}
            >
              <ListVideo size={19} />
            </button>
            <SpeedMenu
              value={preferences.speed}
              hint={hint('rateCycle', '倍速循环（0.75x–2x）')}
              change={(speed) => updatePreferences({ speed })}
            />
            <label title="音量">
              <button
                aria-label={preferences.volume === 0 ? '恢复音量' : '静音'}
                title={hint('mute', '静音 / 恢复音量')}
                onClick={toggleMute}
              >
                {preferences.volume === 0 ? <VolumeX size={17} /> : <Volume2 size={17} />}
              </button>
              <input
                aria-label="音量"
                type="range"
                min="0"
                max="1"
                step=".05"
                value={preferences.volume}
                onChange={(event) => updatePreferences({ volume: Number(event.target.value) })}
              />
            </label>
            <button
              aria-label={fullscreenActive ? '退出全屏' : '全屏'}
              title={hint('fullscreen', fullscreenActive ? '退出全屏' : '全屏')}
              onClick={fullscreen}
            >
              {fullscreenActive ? <Minimize size={19} /> : <Maximize size={19} />}
            </button>
          </div>
        </div>
      </footer>
      {favoriteOpen && (
        <FavoriteDialog
          scope={{
            accountId: queue.accountId,
            queueId: queue.queueId,
            revision: queue.revision,
            workId: work.id
          }}
          close={() => setFavoriteOpen(false)}
          login={login}
          saved={() => setCollected(true)}
        />
      )}
    </section>
  )
}
