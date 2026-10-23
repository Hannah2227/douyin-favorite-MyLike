import { AppError } from './errors'

/** One page SDK request at a time. Interactive work runs before the next collection page. */
export class RequestLane {
  private active = false
  private queue: { priority: number; start: () => Promise<void> }[] = []
  private waiters: (() => void)[] = []
  get pending(): boolean {
    return this.active || this.queue.length > 0
  }
  async idle(): Promise<void> {
    if (this.pending) await new Promise<void>((resolve) => this.waiters.push(resolve))
  }
  run<T>(background: boolean, action: () => Promise<T>): Promise<T> {
    if (this.queue.length >= 8) return Promise.reject(new AppError('BUSY', '等待中的请求较多，请稍后重试。'))
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        priority: background ? 1 : 0,
        start: async () => {
          try {
            resolve(await action())
          } catch (error) {
            reject(error)
          }
        }
      })
      this.drain()
    })
  }
  private drain(): void {
    if (this.active) return
    this.queue.sort((a, b) => a.priority - b.priority)
    const next = this.queue.shift()
    if (!next) {
      for (const resolve of this.waiters.splice(0)) resolve()
      return
    }
    this.active = true
    void next.start().finally(() => {
      this.active = false
      this.drain()
    })
  }
}
