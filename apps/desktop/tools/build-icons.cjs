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
    const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
    const encoded = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image(); img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}'; await img.decode();
    return ${JSON.stringify(sizes)}.map(size => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = size; canvas.getContext('2d').drawImage(img, 0, 0, size, size); return canvas.toDataURL('image/png').split(',')[1]; });
  })()`)
    const images = encoded.map((value) => Buffer.from(value, 'base64'))
    writeFileSync(resolve(__dirname, '../assets/icon.png'), images[sizes.indexOf(512)])
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
    const representations = [
      ['icp4', 16],
      ['icp5', 32],
      ['icp6', 64],
      ['ic07', 128],
      ['ic08', 256],
      ['ic09', 512],
      ['ic11', 32],
      ['ic12', 64],
      ['ic13', 256],
      ['ic14', 512],
      ['ic10', 1024]
    ]
    const chunks = representations.map(([type, size]) => {
      const png = images[sizes.indexOf(size)]
      const chunk = Buffer.alloc(8)
      chunk.write(type, 0, 4, 'ascii')
      chunk.writeUInt32BE(8 + png.length, 4)
      return Buffer.concat([chunk, png])
    })
    const icnsHeader = Buffer.alloc(8)
    icnsHeader.write('icns', 0, 4, 'ascii')
    icnsHeader.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4)
    writeFileSync(resolve(__dirname, '../assets/icon.icns'), Buffer.concat([icnsHeader, ...chunks]))
    win.destroy()
    console.log('Built PNG, Windows ICO and macOS ICNS (including Retina) from assets/icon.svg.')
    app.quit()
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
