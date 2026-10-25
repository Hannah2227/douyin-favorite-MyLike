import { z } from 'zod'

export const shortcutKeys = [
  'Space',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((key) => `Key${key}` as `Key${Uppercase<string>}`),
  'BracketLeft',
  'BracketRight',
  'Comma',
  'Period',
  'Home',
  'End',
  'None'
] as const
const keySchema = z.enum(shortcutKeys)
export const shortcutActions = {
  playPause: { label: '播放 / 暂停', key: 'Space', group: '播放' },
  previous: { label: '上一条 / PageUp', key: 'ArrowUp', group: '播放' },
  next: { label: '下一条 / PageDown', key: 'ArrowDown', group: '播放' },
  seekBack: { label: '快退 / 上一张（图集）', key: 'ArrowLeft', group: '播放' },
  seekForward: { label: '快进 / 下一张（图集）', key: 'ArrowRight', group: '播放' },
  fullscreen: { label: '全屏', key: 'KeyF', group: '界面' },
  mute: { label: '静音', key: 'KeyN', group: '声音与倍速' },
  continuous: { label: '切换连播', key: 'KeyA', group: '播放' },
  unlike: { label: '取消当前条目点赞', key: 'KeyZ', group: '作品' },
  favorite: { label: '收藏 / 取消收藏（当前作品）', key: 'KeyS', group: '作品' },
  rateCycle: { label: '倍速循环（0.75x–2x）', key: 'None', group: '声音与倍速' },
  original: { label: '打开原页看评论', key: 'None', group: '作品' },
  queue: { label: '播放列表', key: 'KeyQ', group: '界面' },
  clean: { label: '清屏 / 退出清屏', key: 'KeyH', group: '界面' }
} as const
export type ShortcutAction = keyof typeof shortcutActions
const shortcutShape = Object.fromEntries(
  Object.entries(shortcutActions).map(([id, action]) => [id, keySchema.default(action.key)])
) as { [K in ShortcutAction]: z.ZodDefault<typeof keySchema> }
export const playbackRates = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3]
export const playbackPreferencesSchema = z
  .object({
    shortcutVersion: z.literal(2).default(2),
    volume: z.number().min(0).max(1).default(0.7),
    speed: z.number().min(0.5).max(3).default(1),
    continuous: z.boolean().default(true),
    autoplay: z.boolean().default(true),
    wheelNavigation: z.boolean().default(true),
    pauseOnBlur: z.boolean().default(false),
    seekStep: z.number().int().min(1).max(60).default(10),
    shortcuts: z.object(shortcutShape).prefault({})
  })
  .refine((value) => {
    const keys = Object.values(value.shortcuts).filter((key) => key !== 'None')
    return new Set(keys).size === keys.length
  }, '快捷键不能重复。')
export type PlaybackPreferences = z.infer<typeof playbackPreferencesSchema>

const legacyDefaults: Partial<Record<ShortcutAction, string>> = {
  previous: 'KeyP',
  next: 'KeyN',
  mute: 'KeyM',
  queue: 'KeyL',
  original: 'KeyC',
  unlike: 'KeyU'
}
/** Upgrade shipped defaults; preserve supported custom bindings and discard removed actions. */
export function readPlaybackPreferences(raw: unknown): PlaybackPreferences {
  if (!raw || typeof raw !== 'object') return playbackPreferencesSchema.parse(raw)
  const value = raw as Record<string, unknown>
  const previous =
    value.shortcuts && typeof value.shortcuts === 'object' ? (value.shortcuts as Record<string, unknown>) : {}
  const shortcuts: Record<string, unknown> = {}
  for (const id of Object.keys(shortcutActions) as ShortcutAction[]) {
    const key = previous[id]
    if (key !== undefined && (value.shortcutVersion === 2 || key !== legacyDefaults[id]))
      shortcuts[id] = key === 'Escape' ? 'None' : key
  }
  const used = new Set(Object.values(shortcuts).filter((key) => key !== 'None'))
  for (const [id, action] of Object.entries(shortcutActions)) {
    if (shortcuts[id] !== undefined) continue
    shortcuts[id] = used.has(action.key) ? 'None' : action.key
    if (shortcuts[id] !== 'None') used.add(shortcuts[id])
  }
  return playbackPreferencesSchema.parse({ ...value, shortcuts })
}
export function keyLabel(code: string): string {
  const labels: Record<string, string> = {
    Space: '空格',
    Escape: 'Esc',
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    BracketLeft: '[',
    BracketRight: ']',
    Comma: ',',
    Period: '.',
    None: '不设置'
  }
  return labels[code] ?? code.replace('Key', '')
}
export const appPreferencesSchema = z.object({
  startupPage: z.enum(['library', 'dashboard', 'favorites', 'tasks']).default('library'),
  zoom: z.union([z.literal(0.9), z.literal(1), z.literal(1.1), z.literal(1.25), z.literal(1.5)]).default(1),
  rememberWindow: z.boolean().default(true),
  motion: z.enum(['system', 'reduce']).default('system')
})
export type AppPreferences = z.infer<typeof appPreferencesSchema>
export const appPreferencesPatchSchema = z.object({
  startupPage: appPreferencesSchema.shape.startupPage.removeDefault().optional(),
  zoom: appPreferencesSchema.shape.zoom.removeDefault().optional(),
  rememberWindow: appPreferencesSchema.shape.rememberWindow.removeDefault().optional(),
  motion: appPreferencesSchema.shape.motion.removeDefault().optional()
})
export interface WindowState {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}
