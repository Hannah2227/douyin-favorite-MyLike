import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { Inputs, Replies } from './protocol'
import { AppError } from '../errors'

export class Database {
  private readonly worker: Worker
  private next = 0
  private failed = false
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
  readonly ready: Promise<void>
  constructor(file: string) {
    this.worker = new Worker(join(__dirname, 'database-worker.cjs'), { workerData: { file } })
    this.ready = new Promise((resolve, reject) => {
      this.worker.on('message', (message) => {
        if ('ready' in message) {
          message.ready ? resolve() : reject(new AppError('STORAGE_ERROR', message.error))
          return
        }
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        message.ok
          ? pending.resolve(message.data)
          : pending.reject(new AppError(message.error.code, message.error.message))
      })
      const fail = () => {
        this.failed = true
        const error = new AppError('STORAGE_ERROR', '数据库工作线程已停止，操作未完成。')
        reject(error)
        for (const pending of this.pending.values()) pending.reject(error)
        this.pending.clear()
      }
      this.worker.on('error', fail)
      this.worker.on('exit', fail)
    })
  }
  async call<K extends keyof Inputs>(method: K, input: Inputs[K]): Promise<Replies[K]> {
    await this.ready
    if (this.failed) throw new AppError('STORAGE_ERROR', '数据库不可用，请重新启动。')
    return new Promise((resolve, reject) => {
      const id = ++this.next
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ id, method, input })
    })
  }
  async close(): Promise<void> {
    try {
      await this.call('close', undefined)
    } finally {
      await this.worker.terminate()
    }
  }
}
