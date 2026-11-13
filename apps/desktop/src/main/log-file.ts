import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Serialized, best-effort log writer. Logging must never fail an operation. */
export class LogFile {
  private pending: Promise<void> = Promise.resolve()
  constructor(private readonly directory: string) {}
  append(file: string, line: string): Promise<void> {
    this.pending = this.pending
      .then(async () => {
        await mkdir(this.directory, { recursive: true })
        await appendFile(join(this.directory, file), line + '\n', 'utf8')
      })
      .catch(() => {})
    return this.pending
  }
}
