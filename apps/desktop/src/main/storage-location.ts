import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { AppError } from './errors'

const locator = 'storage-location.json'
const marker = '.mylike-move'
const database = 'mylike.sqlite'
const transient = new Set([
  locator,
  locator + '.tmp',
  marker,
  'lockfile',
  'DevToolsActivePort',
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket'
])
const folder = z.string().refine(isAbsolute)
const moveSchema = z.object({ source: folder, target: folder, id: z.string().uuid() })
const stateSchema = z.object({
  directory: folder,
  creating: z.literal(true).optional(),
  pending: moveSchema.optional(),
  cleanup: moveSchema.extend({ digest: z.string().length(64) }).optional(),
  warning: z.string().optional()
})
type Move = z.infer<typeof moveSchema>
type State = z.infer<typeof stateSchema>

const same = (a: string, b: string) => relative(a, b) === ''
function contains(root: string, path: string): boolean {
  const child = relative(root, path)
  return !child || (!isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep))
}
const overlap = (a: string, b: string) => contains(a, b) || contains(b, a)
const detail = (error: unknown) =>
  error instanceof AppError ? error.message : '请检查磁盘空间、文件权限和文件占用。'

function profileDigest(root: string): string {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  const visit = (path: string) => {
    for (const name of readdirSync(path).sort()) {
      if (path === root && transient.has(name)) continue
      const file = join(path, name)
      const info = lstatSync(file)
      if (info.isDirectory()) {
        hash.update(JSON.stringify(['directory', relative(root, file)]))
        visit(file)
      } else if (info.isFile()) {
        hash.update(JSON.stringify(['file', relative(root, file), info.size]))
        const descriptor = openSync(file, 'r')
        try {
          let length: number
          while ((length = readSync(descriptor, buffer, 0, buffer.length, null)) !== 0)
            hash.update(buffer.subarray(0, length))
        } finally {
          closeSync(descriptor)
        }
      } else throw new AppError('STORAGE_LINK', '数据目录内有链接或特殊文件，无法自动迁移。')
    }
  }
  visit(root)
  return hash.digest('hex')
}

function markMatches(path: string, move: Move): boolean {
  try {
    return readFileSync(join(path, marker), 'utf8') === move.id
  } catch {
    return false
  }
}

/** The singleton lock and locator stay at the old AppData path, across storage moves. */
export class StorageLocation {
  private readonly file: string
  warning: string | undefined
  constructor(
    readonly anchor: string,
    private readonly installDirectory?: string,
    private readonly newProfile?: string
  ) {
    this.file = join(anchor, locator)
  }

  private read(): State {
    try {
      return stateSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { directory: this.anchor }
      throw new AppError('STORAGE_LOCATOR', '数据位置配置无法读取。请保留现有文件并检查数据目录权限。')
    }
  }

  private save(state: State): void {
    const temporary = this.file + '.tmp'
    const descriptor = openSync(temporary, 'w')
    try {
      writeFileSync(descriptor, JSON.stringify(state))
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    renameSync(temporary, this.file)
  }

  private validate(move: Move, resuming = false): void {
    const { source, target } = move
    if (
      target.startsWith('\\\\') ||
      same(source, dirname(source)) ||
      overlap(source, target) ||
      overlap(this.anchor, target) ||
      (this.installDirectory &&
        (overlap(this.installDirectory, target) || overlap(this.installDirectory, source))) ||
      !same(realpathSync(source), source) ||
      !lstatSync(join(source, database)).isFile() ||
      !same(realpathSync(dirname(target)), dirname(target)) ||
      (existsSync(target) && !same(realpathSync(target), target))
    )
      throw new AppError('STORAGE_TARGET', '请选择独立的本地空文件夹，避开安装目录、原数据目录和链接目录。')
    if (existsSync(target) && readdirSync(target).length && !(resuming && markMatches(target, move)))
      throw new AppError('STORAGE_NOT_EMPTY', '目标文件夹有内容，请选择或新建一个空文件夹。')
  }

  check(source: string, target: string): string {
    const canonical = resolve(target)
    this.validate({ source, target: canonical, id: randomUUID() })
    return canonical
  }

  schedule(source: string, target: string): void {
    const state = this.read()
    if (!same(state.directory, source) || state.pending || state.cleanup)
      throw new AppError('STORAGE_BUSY', '数据位置有待完成的变更，请重新打开应用。')
    const move = { source, target, id: randomUUID() }
    this.validate(move)
    this.save({ directory: source, pending: move })
  }

  private copy(move: Move): State {
    const { source, target } = move
    const stage = target + '.mylike-' + move.id
    try {
      this.validate(move, true)
      const digest = profileDigest(source)
      if (!markMatches(target, move)) {
        if (existsSync(stage)) this.removeStage(stage, move)
        mkdirSync(stage)
        writeFileSync(join(stage, marker), move.id, { flag: 'wx' })
        for (const name of readdirSync(source)) {
          if (transient.has(name)) continue
          cpSync(join(source, name), join(stage, name), {
            recursive: true,
            force: false,
            errorOnExist: true,
            filter: (file) => {
              if (lstatSync(file).isSymbolicLink()) throw new Error('Storage link')
              return true
            }
          })
        }
        if (profileDigest(stage) !== digest) throw new Error('Copy mismatch')
        if (existsSync(target)) rmdirSync(target)
        renameSync(stage, target)
      }
      if (profileDigest(target) !== digest) throw new Error('Copy mismatch')
      const copied = new DatabaseSync(join(target, database), { readOnly: true })
      try {
        if (copied.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
          throw new Error('Database verification failed')
      } finally {
        copied.close()
      }
      return { directory: target, cleanup: { ...move, digest } }
    } catch (error) {
      if (existsSync(stage)) {
        try {
          this.removeStage(stage, move)
        } catch {
          // An unrecognized directory may contain user files.
        }
      }
      return { directory: source, warning: '数据迁移未完成，仍使用原位置。' + detail(error) }
    }
  }

  private removeStage(stage: string, move: Move): void {
    if (
      !same(stage, move.target + '.mylike-' + move.id) ||
      !same(realpathSync(stage), stage) ||
      !markMatches(stage, move)
    )
      throw new Error('Unexpected staging path')
    rmSync(stage, { recursive: true })
  }

  prepare(): string {
    let state = this.read()
    if (
      this.newProfile &&
      !existsSync(this.file) &&
      !['mylike.sqlite', 'backups', 'Partitions'].some((name) => existsSync(join(this.anchor, name)))
    ) {
      const directory = this.newProfile
      if (!existsSync(directory)) mkdirSync(directory)
      if (!same(realpathSync(directory), directory) || readdirSync(directory).length)
        throw new AppError(
          'STORAGE_NOT_EMPTY',
          '安装目录旁的 MyLike 数据文件夹已有内容，请保留原文件并选择其他安装位置。'
        )
      state = { directory, creating: true }
      this.save(state)
    }
    if (state.pending) {
      if (!same(state.directory, state.pending.source))
        throw new AppError('STORAGE_LOCATOR', '数据迁移记录与当前目录不一致。请保留现有文件。')
      state = this.copy(state.pending)
      this.save(state)
    }
    if (
      !same(state.directory, this.anchor) &&
      (!existsSync(state.directory) ||
        !same(realpathSync(state.directory), state.directory) ||
        (!state.creating && !existsSync(join(state.directory, database))))
    )
      throw new AppError('STORAGE_UNAVAILABLE', '数据目录不可用。请连接原磁盘并检查权限后重新打开 MyLike。')
    this.warning = state.warning
    return state.directory
  }

  finish(): void {
    const state = this.read()
    if (state.creating) this.save({ directory: state.directory })
    const move = state.cleanup
    if (!move) return
    try {
      this.validate(move, true)
      if (
        !same(state.directory, move.target) ||
        !markMatches(move.target, move) ||
        profileDigest(move.source) !== move.digest
      )
        throw new Error('Old directory changed')
      for (const name of readdirSync(move.source)) {
        if (transient.has(name)) continue
        const path = join(move.source, name)
        if (!contains(move.source, realpathSync(path)) || same(move.source, path))
          throw new Error('Unexpected old data path')
        rmSync(path, { recursive: true })
      }
      this.save({ directory: move.target })
    } catch {
      this.warning = '新位置已启用。旧目录有残留，请确认后再清理：' + move.source
      this.save({ directory: move.target, warning: this.warning })
    }
    if (markMatches(move.target, move)) {
      try {
        unlinkSync(join(move.target, marker))
      } catch {
        // A leftover marker does not change the active location.
      }
    }
  }

  restorePrevious(): boolean {
    const state = this.read()
    const move = state.cleanup
    if (
      !move ||
      !same(state.directory, move.target) ||
      !markMatches(move.target, move) ||
      profileDigest(move.source) !== move.digest
    )
      return false
    this.save({
      directory: move.source,
      warning: '新位置未能启动，已恢复原数据位置。目标目录的复制文件仍保留。'
    })
    return true
  }
}
