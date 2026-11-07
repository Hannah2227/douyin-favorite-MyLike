import { afterEach, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { StorageLocation } from '../../src/main/storage-location'

const temp = realpathSync(tmpdir())
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    const path = realpathSync(root)
    if (dirname(path) !== temp || !basename(path).startsWith('mylike-location-'))
      throw Error('Unsafe cleanup')
    rmSync(path, { recursive: true, force: true })
  }
})

function setup() {
  const root = mkdtempSync(join(temp, 'mylike-location-'))
  roots.push(root)
  const anchor = join(root, 'MyLikeElectron')
  mkdirSync(anchor)
  const executableDirectory = join(root, 'Apps', 'MyLike')
  mkdirSync(executableDirectory, { recursive: true })
  const fresh = executableDirectory + ' 数据'
  const target = join(root, '已迁移的数据')
  mkdirSync(target)
  return { anchor, executableDirectory, fresh, target }
}

function seed(directory: string) {
  const db = new DatabaseSync(join(directory, 'mylike.sqlite'))
  try {
    db.exec("CREATE TABLE accounts (name TEXT); INSERT INTO accounts VALUES ('legacy')")
  } finally {
    db.close()
  }
  mkdirSync(join(directory, 'Partitions'))
  writeFileSync(join(directory, 'Partitions', 'session'), 'account-session')
  mkdirSync(join(directory, 'backups'))
  writeFileSync(join(directory, 'backups', 'history.sqlite'), 'backup')
}

it('creates a fresh profile beside the install and keeps its recorded location on later launches', () => {
  const { anchor, executableDirectory, fresh, target } = setup()
  const location = new StorageLocation(anchor, executableDirectory, fresh)
  expect(location.prepare()).toBe(fresh)
  expect(new StorageLocation(anchor, executableDirectory, fresh).prepare()).toBe(fresh)
  seed(fresh)
  location.finish()
  expect(new StorageLocation(anchor, target, target + ' 数据').prepare()).toBe(fresh)
  expect(existsSync(join(anchor, 'mylike.sqlite'))).toBe(false)
  expect(JSON.parse(readFileSync(join(anchor, 'storage-location.json'), 'utf8'))).toEqual({
    directory: fresh
  })
  renameSync(join(fresh, 'mylike.sqlite'), join(fresh, 'offline.sqlite'))
  expect(existsSync(join(fresh, 'mylike.sqlite'))).toBe(false)
  expect(() => location.prepare()).toThrow('数据目录不可用')
  expect(existsSync(join(anchor, 'mylike.sqlite'))).toBe(false)
})

it('keeps the legacy profile until a verified move successfully starts', () => {
  const { anchor, executableDirectory, fresh, target } = setup()
  seed(anchor)
  const location = new StorageLocation(anchor, executableDirectory, fresh)
  expect(location.prepare()).toBe(anchor)
  expect(existsSync(fresh)).toBe(false)
  expect(() => location.check(anchor, executableDirectory)).toThrow('安装目录')
  location.schedule(anchor, target)

  const restarted = new StorageLocation(anchor, executableDirectory, fresh)
  expect(restarted.prepare()).toBe(target)
  expect(existsSync(join(anchor, 'mylike.sqlite'))).toBe(true)
  expect(readFileSync(join(target, 'Partitions', 'session'), 'utf8')).toBe('account-session')
  expect(readFileSync(join(target, 'backups', 'history.sqlite'), 'utf8')).toBe('backup')
  const db = new DatabaseSync(join(target, 'mylike.sqlite'), { readOnly: true })
  try {
    expect(db.prepare('SELECT name FROM accounts').get()).toMatchObject({ name: 'legacy' })
  } finally {
    db.close()
  }
  restarted.finish()
  expect(existsSync(join(anchor, 'mylike.sqlite'))).toBe(false)
  expect(new StorageLocation(anchor, executableDirectory, fresh).prepare()).toBe(target)
})

it('leaves a newly occupied destination and the original data intact', () => {
  const { anchor, target } = setup()
  seed(anchor)
  const location = new StorageLocation(anchor)
  location.schedule(anchor, target)
  writeFileSync(join(target, 'user.txt'), 'leave alone')
  expect(location.prepare()).toBe(anchor)
  expect(location.warning).toContain('仍使用原位置')
  expect(readFileSync(join(target, 'user.txt'), 'utf8')).toBe('leave alone')
  expect(existsSync(join(anchor, 'mylike.sqlite'))).toBe(true)
})

it('restores the original profile when the copied profile cannot start', () => {
  const { anchor, target } = setup()
  seed(anchor)
  const location = new StorageLocation(anchor)
  location.schedule(anchor, target)
  expect(location.prepare()).toBe(target)
  expect(location.restorePrevious()).toBe(true)
  expect(location.prepare()).toBe(anchor)
  expect(existsSync(join(target, 'mylike.sqlite'))).toBe(true)
})

it('retains old files when they change after copying', () => {
  const { anchor, target } = setup()
  seed(anchor)
  const location = new StorageLocation(anchor)
  location.schedule(anchor, target)
  expect(location.prepare()).toBe(target)
  writeFileSync(join(anchor, 'new-file'), 'old process still wrote here')
  location.finish()
  expect(location.warning).toContain('旧目录有残留')
  expect(location.prepare()).toBe(target)
  expect(existsSync(join(anchor, 'mylike.sqlite'))).toBe(true)
})
