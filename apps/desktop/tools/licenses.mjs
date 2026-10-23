import {
  readFileSync,
  readdirSync,
  existsSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  copyFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const packages = new Map()

function locate(name, parent) {
  const require = createRequire(join(parent, 'package.json'))
  for (const base of require.resolve.paths(name) ?? []) {
    const folder = join(base, name)
    if (existsSync(join(folder, 'package.json'))) return realpathSync(folder)
  }
  throw new Error(`Cannot locate production dependency: ${name}`)
}

function visit(name, parent) {
  const folder = locate(name, parent)
  if (packages.has(folder)) return
  const pkg = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'))
  const files = readdirSync(folder).filter((file) => /^(licen[cs]e|copying|notice)([.-]|$)/i.test(file))
  if (!files.length) throw new Error(`Missing license notice: ${pkg.name}@${pkg.version}`)
  packages.set(folder, { pkg, texts: files.map((file) => readFileSync(join(folder, file), 'utf8')) })
  for (const dependency of Object.keys(pkg.dependencies ?? {})) visit(dependency, folder)
  for (const dependency of new Set([
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {})
  ])) {
    try {
      locate(dependency, folder)
    } catch {
      continue
    }
    visit(dependency, folder)
  }
}

for (const name of Object.keys(manifest.dependencies)) visit(name, root)
const notices = [...packages.values()]
  .sort((a, b) => a.pkg.name.localeCompare(b.pkg.name))
  .map(
    ({ pkg, texts }) =>
      `${pkg.name}@${pkg.version}\nLicense: ${pkg.license ?? 'See below'}\n\n${texts.join('\n\n')}`
  )
const output = join(root, 'out/legal')
mkdirSync(output, { recursive: true })
copyFileSync(resolve(root, '../../LICENSE'), join(output, 'MyLike-LICENSE.txt'))
writeFileSync(
  join(output, 'THIRD-PARTY-NOTICES.txt'),
  'Third-party components retain their own copyrights and licenses.\n' +
    'Electron and Chromium notices are distributed alongside the application.\n\n' +
    notices.join('\n\n' + '='.repeat(72) + '\n\n') +
    '\n'
)
console.log(`Collected license notices for ${packages.size} production packages.`)
