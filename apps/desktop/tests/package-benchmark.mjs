import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, cpus, totalmem, release } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

// Instrument a disposable copy of the completed package, leaving the delivered
// EXE/ASAR unchanged. No inspector, CDP or Playwright connection is opened.
const minutes = Number(process.argv[2] ?? 5)
if (!Number.isFinite(minutes) || minutes < 1 || minutes > 180) throw Error('Duration must be 1–180 minutes')
const require = createRequire(import.meta.url)
const builder = createRequire(require.resolve('electron-builder/package.json'))
const library = createRequire(builder.resolve('app-builder-lib/package.json'))
const asar = library('@electron/asar')
const root = mkdtempSync(join(tmpdir(), 'mylike-packaged-benchmark-'))
const bundle = join(root, 'bundle'),
  profile = join(root, 'profile')
let child, watchdog
try {
  mkdirSync(profile)
  cpSync(resolve('dist/win-unpacked'), bundle, { recursive: true })
  const archive = join(bundle, 'resources/app.asar'),
    project = join(bundle, 'resources/app')
  asar.extractAll(archive, project)
  if (!resolve(archive).startsWith(resolve(root) + '\\')) throw Error('Unsafe disposable archive path')
  unlinkSync(archive)
  const manifest = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'))
  manifest.main = 'benchmark.cjs'
  writeFileSync(join(project, 'package.json'), JSON.stringify(manifest))
  cpSync(resolve('tests/helpers/package-benchmark.cjs'), join(project, 'benchmark.cjs'))
  cpSync(resolve('tests/fixtures/flower.mp4'), join(project, 'fixture.mp4'))
  const benchmarkEnv = {
    ...process.env,
    MYLIKE_HEADLESS: '1',
    MYLIKE_USER_DATA: profile,
    MYLIKE_BENCHMARK_MINUTES: String(minutes)
  }
  delete benchmarkEnv.NODE_OPTIONS
  delete benchmarkEnv.ELECTRON_RUN_AS_NODE
  console.log(
    JSON.stringify({
      label: 'machine',
      at: new Date().toISOString(),
      windows: release(),
      cpu: cpus()[0]?.model,
      logicalCPUs: cpus().length,
      physicalMiB: Math.round(totalmem() / 1048576),
      minutes,
      version: manifest.version,
      packagedCopy: true,
      debugConnection: false
    })
  )
  child = spawn(join(bundle, 'MyLike.exe'), [], {
    env: benchmarkEnv,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let buffered = ''
  child.stdout.on('data', (bytes) => {
    buffered += bytes.toString()
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines) if (line.startsWith('MYLIKE_BENCHMARK ')) console.log(line.slice(17))
  })
  child.stderr.on('data', (bytes) => {
    for (const line of bytes.toString().split('\n'))
      if (line.startsWith('Benchmark failed:')) console.error(line)
  })
  watchdog = setTimeout(
    () => {
      if (child.exitCode === null && child.signalCode === null)
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        })
    },
    (minutes * 60 + 240) * 1000
  )
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
} finally {
  clearTimeout(watchdog)
  if (child && child.exitCode === null && child.signalCode === null)
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  if (
    dirname(resolve(root)) !== resolve(tmpdir()) ||
    !basename(root).startsWith('mylike-packaged-benchmark-')
  )
    throw Error('Unsafe benchmark cleanup')
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
