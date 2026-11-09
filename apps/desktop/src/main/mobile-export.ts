import { randomUUID } from 'node:crypto'
import { open, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import { AppError } from './errors'

export async function saveMobileLibrary(file: string, text: string, dataDirectory: string): Promise<void> {
  if (!isAbsolute(file) || extname(file).toLowerCase() !== '.json')
    throw new AppError('EXPORT_LOCATION', '请选择一个 .json 文件保存清单。')
  let temporary: string | undefined
  try {
    const directory = await realpath(dirname(file))
    const fromData = relative(await realpath(dataDirectory), directory)
    if (fromData === '' || (!isAbsolute(fromData) && fromData !== '..' && !fromData.startsWith('..' + sep)))
      throw new AppError('EXPORT_LOCATION', '请选择 MyLike 数据目录之外的位置。')
    const target = join(directory, basename(file))
    const staged = join(directory, `.mylike-export-${randomUUID()}.tmp`)
    const handle = await open(staged, 'wx')
    temporary = staged
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(staged, target)
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError('EXPORT_WRITE_FAILED', '无法保存清单，请检查保存位置、磁盘空间或文件占用。')
  } finally {
    if (temporary) await unlink(temporary).catch(() => {})
  }
}
