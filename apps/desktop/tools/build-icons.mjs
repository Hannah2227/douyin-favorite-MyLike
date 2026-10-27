import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = mkdtempSync(join(tmpdir(), 'mylike-icon-builder-'))
try {
  const result = spawnSync(
    require('electron'),
    [join(dirname(fileURLToPath(import.meta.url)), 'build-icons.cjs')],
    {
      env: { ...process.env, MYLIKE_ICON_PROFILE: root },
      windowsHide: true,
      stdio: 'inherit'
    }
  )
  if (result.error) throw result.error
  if (result.signal) throw Error(`Icon build terminated by ${result.signal}`)
  if (result.status) throw Error(`Icon build exited with ${result.status}`)
} finally {
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('mylike-icon-builder-'))
    throw Error('Unsafe icon profile cleanup')
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
}
