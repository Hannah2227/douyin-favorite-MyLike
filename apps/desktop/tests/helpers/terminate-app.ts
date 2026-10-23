import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ElectronApplication } from '@playwright/test'

/** Only terminate the process tree of this test's independently verified profile. */
export async function terminateApp(app: ElectronApplication, profile: string): Promise<void> {
  const actual = await app.evaluate(({ app }) => app.getPath('userData'))
  if (
    resolve(actual) !== resolve(profile) ||
    dirname(resolve(profile)) !== resolve(tmpdir()) ||
    !basename(profile).startsWith('mylike-')
  )
    throw Error('Refusing to terminate an application outside the temporary test profile')
  const child = app.process()
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    throw Error('Test application is not running')
  const exited = once(child, 'exit')
  if (process.platform === 'win32')
    await promisify(execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  else child.kill('SIGKILL')
  await exited
}
