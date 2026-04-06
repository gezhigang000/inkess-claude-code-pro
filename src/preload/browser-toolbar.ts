/**
 * Preload script for the browser toolbar WebContentsView.
 * Exposes a minimal API for the toolbar HTML to communicate with main process.
 */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('browserToolbar', {
  send: (channel: string, data: Record<string, unknown>) => {
    const allowed = [
      'browser-toolbar:navigate',
      'browser-toolbar:back',
      'browser-toolbar:forward',
      'browser-toolbar:reload',
      'browser-toolbar:stop',
      'browser-toolbar:newTab',
    ]
    if (allowed.includes(channel)) {
      ipcRenderer.send(channel, data)
    }
  },
  onUpdate: (callback: (state: { url: string; canGoBack: boolean; canGoForward: boolean; title: string; loading: boolean }) => void) => {
    // Remove previous listener to prevent accumulation on reload
    ipcRenderer.removeAllListeners('browser-toolbar:update')
    ipcRenderer.on('browser-toolbar:update', (_event, state) => {
      callback(state)
    })
  },
})
