const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { resolve } = require('node:path')
if (!process.env.MYLIKE_ICON_PROFILE) throw Error('Run pnpm icons to build icons in an isolated profile.')
app.setPath('userData', process.env.MYLIKE_ICON_PROFILE)
app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, partition: 'icon-builder' }
    })
    await win.loadURL('data:text/html,<html><body></body></html>')
    const svg = readFileSync(resolve(__dirname, '../assets/icon.svg'), 'utf8')
    const sizes = [16, 24, 32, 48, 64, 128, 256, 512]
    const encoded = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image(); img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}'; await img.decode();
    return ${JSON.stringify(sizes)}.map(size => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = size; canvas.getContext('2d').drawImage(img, 0, 0, size, size); return canvas.toDataURL('image/png').split(',')[1]; });
  })()`)
    const images = encoded.map((value) => Buffer.from(value, 'base64'))
    writeFileSync(resolve(__dirname, '../assets/icon.png'), images.at(-1))
    const count = 7,
      header = Buffer.alloc(6 + 16 * count)
    header.writeUInt16LE(1, 2)
    header.writeUInt16LE(count, 4)
    let offset = header.length
    for (let i = 0; i < count; i++) {
      const at = 6 + 16 * i,
        size = sizes[i]
      header[at] = header[at + 1] = size === 256 ? 0 : size
      header.writeUInt16LE(1, at + 4)
      header.writeUInt16LE(32, at + 6)
      header.writeUInt32LE(images[i].length, at + 8)
      header.writeUInt32LE(offset, at + 12)
      offset += images[i].length
    }
    writeFileSync(
      resolve(__dirname, '../assets/icon.ico'),
      Buffer.concat([header, ...images.slice(0, count)])
    )
    win.destroy()
    console.log('Built transparent PNG and seven-resolution Windows ICO from assets/icon.svg.')
    app.quit()
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
