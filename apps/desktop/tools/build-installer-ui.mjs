import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const framework = join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319')
const output = resolve('dist/installer-resources')
mkdirSync(output, { recursive: true })
execFileSync(
  join(framework, 'csc.exe'),
  [
    '/nologo',
    '/target:winexe',
    '/platform:x64',
    '/optimize+',
    '/codepage:65001',
    '/win32icon:' + resolve('assets/icon.ico'),
    '/out:' + join(output, 'MyLikeSetupUI.exe'),
    ...['WindowsBase', 'PresentationCore', 'PresentationFramework'].map(
      (name) => '/reference:' + join(framework, 'WPF', name + '.dll')
    ),
    '/reference:' + join(framework, 'System.Xaml.dll'),
    '/resource:' + resolve('build/setup/Setup.xaml') + ',MyLike.Setup.xaml',
    '/resource:' + resolve('assets/icon.png') + ',MyLike.Icon.png',
    resolve('build/setup/Setup.cs'),
    resolve('build/setup/FolderPicker.cs')
  ],
  { stdio: 'inherit', windowsHide: true }
)
