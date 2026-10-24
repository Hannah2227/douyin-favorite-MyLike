import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../../src/main/storage/database'
import {
  readPlaybackPreferences,
  playbackPreferencesSchema,
  appPreferencesSchema
} from '../../src/shared/preferences'
import { restoreWindowState } from '../../src/main/window-state'

const directories: string[] = [],
  stores: Store[] = []
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'mylike-preferences-test-'))
  directories.push(root)
  const file = join(root, 'db.sqlite'),
    store = new Store(file)
  stores.push(store)
  return { file, store }
}
afterEach(() => {
  for (const store of stores.splice(0))
    try {
      store.call('close', undefined)
    } catch {}
  for (const root of directories.splice(0)) {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()))
    expect(basename(root)).toMatch(/^mylike-preferences-test-/)
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
it('preserves legacy custom keys when newly introduced defaults would conflict', () => {
  const value = readPlaybackPreferences({
    volume: 0.3,
    shortcuts: {
      playPause: 'KeyL',
      previous: 'KeyM',
      next: 'KeyN',
      seekBack: 'ArrowLeft',
      seekForward: 'ArrowRight',
      fullscreen: 'KeyF',
      back: 'Escape'
    }
  })
  expect(value).toMatchObject({
    volume: 0.3,
    autoplay: true,
    seekStep: 10,
    shortcuts: { playPause: 'KeyL', previous: 'KeyM', next: 'ArrowDown', queue: 'KeyQ', mute: 'KeyN' }
  })
  expect(() =>
    playbackPreferencesSchema.parse({ ...value, shortcuts: { ...value.shortcuts, queue: 'KeyL' } })
  ).toThrow(/快捷键不能重复/)
  expect(() => readPlaybackPreferences({ shortcuts: { playPause: 'InvalidKey' } })).toThrow()
})
it('adds clean screen to the focused shortcuts, upgrades defaults and preserves custom bindings', () => {
  const value = readPlaybackPreferences({
    shortcuts: {
      previous: 'KeyP',
      next: 'KeyN',
      mute: 'KeyM',
      queue: 'KeyL',
      original: 'KeyC',
      unlike: 'KeyU',
      copyLink: 'KeyY',
      help: 'KeyH',
      sidebar: 'KeyB'
    }
  })
  expect(Object.keys(value.shortcuts)).toHaveLength(13)
  expect(value.shortcuts).toMatchObject({
    previous: 'ArrowUp',
    next: 'ArrowDown',
    mute: 'KeyN',
    queue: 'KeyQ',
    original: 'None',
    unlike: 'KeyZ',
    rateCycle: 'None',
    clean: 'KeyH'
  })
  expect(value.shortcuts).not.toHaveProperty('copyLink')
  const customized = {
    ...value,
    shortcuts: { ...value.shortcuts, next: 'KeyN' as const, mute: 'KeyM' as const }
  }
  expect(readPlaybackPreferences(customized)).toEqual(customized)
  expect(
    readPlaybackPreferences({ shortcutVersion: 2, shortcuts: { playPause: 'KeyH' } }).shortcuts
  ).toMatchObject({ playPause: 'KeyH', clean: 'None' })
  expect(
    readPlaybackPreferences({ shortcuts: { playPause: 'KeyQ', copyLink: 'KeyN' } }).shortcuts
  ).toMatchObject({ playPause: 'KeyQ', queue: 'None', mute: 'KeyN' })
})
it('persists application and playback preferences across restart without changing account data', () => {
  const { store, file } = setup()
  store.call('createAccount', { id: 'a', name: 'A' })
  store.call('appPreferences', {
    preferences: appPreferencesSchema.parse({
      startupPage: 'dashboard',
      zoom: 1.25,
      motion: 'reduce',
      rememberWindow: false
    })
  })
  store.call('appPreferences', { preferences: { zoom: 1.1 } })
  store.call('playbackPreferences', {
    preferences: playbackPreferencesSchema.parse({
      autoplay: false,
      seekStep: 30,
      wheelNavigation: false,
      pauseOnBlur: true
    })
  })
  store.call('close', undefined)
  const next = new Store(file)
  stores.push(next)
  expect(next.call('appPreferences', {})).toEqual({
    startupPage: 'dashboard',
    zoom: 1.1,
    motion: 'reduce',
    rememberWindow: false
  })
  expect(next.call('playbackPreferences', {})).toMatchObject({
    autoplay: false,
    seekStep: 30,
    wheelNavigation: false,
    pauseOnBlur: true
  })
  expect(next.call('accounts', undefined)).toHaveLength(1)
  expect(next.call('checkDatabase', {})).toMatchObject({ ok: true, issues: 0 })
})
it('reports foreign-key corruption and refuses corrupt settings instead of reporting defaults', () => {
  const { store, file } = setup()
  store.call('close', undefined)
  const db = new DatabaseSync(file)
  db.exec(
    "PRAGMA foreign_keys=OFF;INSERT INTO account_items(accountId,workId,firstSeen,platformSeen) VALUES('missing','1',0,1);INSERT INTO settings VALUES('application','broken-json');"
  )
  db.close()
  const next = new Store(file)
  stores.push(next)
  expect(next.call('checkDatabase', {})).toMatchObject({ ok: false, issues: 2 })
  expect(() => next.call('appPreferences', {})).toThrow(/原设置已保留/)
})
it('keeps remembered windows reachable after monitor removal and rejects non-finite coordinates', () => {
  const area = [{ x: 0, y: 0, width: 1920, height: 1040 }]
  expect(restoreWindowState({ x: -4000, y: 2000, width: 2800, height: 2000, maximized: true }, area)).toEqual(
    { x: 0, y: 0, width: 1920, height: 1040, maximized: true }
  )
  expect(restoreWindowState({ x: 20, y: 20, width: 100, height: 100, maximized: false }, area)).toMatchObject(
    { width: 920, height: 640 }
  )
  expect(restoreWindowState({ x: NaN, y: 0, width: 1200, height: 800, maximized: false }, area)).toBeNull()
  expect(
    restoreWindowState({ x: 60, y: 50, width: 1100, height: 780, maximized: false }, [
      { x: 0, y: 0, width: 1024, height: 728 }
    ])
  ).toEqual({ x: 0, y: 0, width: 1024, height: 728, maximized: false })
})
