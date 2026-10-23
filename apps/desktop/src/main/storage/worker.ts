import { parentPort, workerData } from 'node:worker_threads'
import { Store } from './database'
import { AppError } from '../errors'

try {
  const store = new Store(workerData.file)
  parentPort!.on('message', ({ id, method, input }) => {
    try {
      parentPort!.postMessage({ id, ok: true, data: store.call(method, input) })
    } catch (error) {
      parentPort!.postMessage({
        id,
        ok: false,
        error:
          error instanceof AppError
            ? { code: error.code, message: error.message }
            : { code: 'STORAGE_ERROR', message: '数据库操作失败，原数据已保留，请检查磁盘与文件权限。' }
      })
    }
  })
  parentPort!.postMessage({ ready: true })
} catch (error) {
  console.error(
    '[MyLike:database] Initialization failed:',
    error instanceof Error ? error.message : 'unknown error'
  )
  parentPort!.postMessage({
    ready: false,
    error: '无法打开数据库，原文件已保留。请检查是否损坏、权限不足或版本过新。'
  })
}
