import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
const require = createRequire(import.meta.url)
const profile = mkdtempSync(join(tmpdir(), 'mylike-benchmark-'))
const benchmarkEnv = { ...process.env, MYLIKE_HEADLESS: '1', MYLIKE_USER_DATA: profile }
delete benchmarkEnv.NODE_OPTIONS
delete benchmarkEnv.ELECTRON_RUN_AS_NODE
const child = spawn(require('electron'), [resolve('tests/helpers/platform-benchmark.cjs')], {
  env: benchmarkEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
})
child.stdout.pipe(process.stdout)
// Chromium diagnostic stderr can contain URLs; only surface the harness's own failure.
child.stderr.on('data', (bytes) => {
  for (const line of bytes.toString().split('\n'))
    if (line.startsWith('Benchmark failed:')) process.stderr.write(line + '\n')
})
const timeout = setTimeout(() => {
  if (child.exitCode === null && child.signalCode === null)
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
}, 120_000)
try {
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
} finally {
  clearTimeout(timeout)
  if (dirname(resolve(profile)) !== resolve(tmpdir()) || !basename(profile).startsWith('mylike-benchmark-'))
    throw Error('Unsafe benchmark profile cleanup')
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
