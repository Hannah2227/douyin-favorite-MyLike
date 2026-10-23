import { contextBridge, ipcRenderer } from 'electron'
import { CHANNEL, CHANGED, BEFORE_QUIT, QUIT_READY } from '../shared/channels'
import type { DesktopAPI } from '../shared/contracts'

const closingCallbacks = new Set<() => Promise<void>>()
ipcRenderer.on(BEFORE_QUIT, async (_event, nonce: string) => {
  await Promise.allSettled([...closingCallbacks].map((callback) => Promise.resolve().then(callback)))
  ipcRenderer.send(QUIT_READY, nonce)
})

const api: DesktopAPI = {
  invoke: (command, input) => ipcRenderer.invoke(CHANNEL, command, input),
  onChanged(callback) {
    const listener = () => callback()
    ipcRenderer.on(CHANGED, listener)
    return () => ipcRenderer.removeListener(CHANGED, listener)
  },
  onBeforeQuit(callback) {
    closingCallbacks.add(callback)
    return () => {
      closingCallbacks.delete(callback)
    }
  }
}
contextBridge.exposeInMainWorld('mylike', api)
