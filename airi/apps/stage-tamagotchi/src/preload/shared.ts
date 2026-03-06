import type { ElectronWindow } from '@proj-airi/stage-shared'

import { contextIsolated, platform } from 'node:process'

import { electronAPI } from '@electron-toolkit/preload'
import { contextBridge, ipcRenderer } from 'electron'

export function expose() {
  // TODO: once we refactored eventa to support window-namespaced contexts,
  // we can remove the setMaxListeners call below since eventa will be able to dispatch and
  // manage events within eventa's context system.
  ipcRenderer.setMaxListeners(0)

  // Use `contextBridge` APIs to expose Electron APIs to
  // renderer only if context isolation is enabled, otherwise
  // just add to the DOM global.
  if (contextIsolated) {
    try {
      contextBridge.exposeInMainWorld('electron', electronAPI)
      contextBridge.exposeInMainWorld('platform', platform)
      // LLM 파일 로깅 API
      contextBridge.exposeInMainWorld('logLLM', (line: string) =>
        ipcRenderer.invoke('log:llm', line),
      )
      contextBridge.exposeInMainWorld('logChat', (line: string) =>
        ipcRenderer.invoke('log:chat', line),
      )
      contextBridge.exposeInMainWorld('logTTS', (line: string) =>
        ipcRenderer.invoke('log:tts', line),
      )
    }
    catch (error) {
      console.error(error)
    }
  }
  else {
    window.electron = electronAPI
    window.platform = platform
      ; (window as any).logLLM = (line: string) => ipcRenderer.invoke('log:llm', line)
      ; (window as any).logChat = (line: string) => ipcRenderer.invoke('log:chat', line)
      ; (window as any).logTTS = (line: string) => ipcRenderer.invoke('log:tts', line)
  }
}

export function exposeWithCustomAPI<CustomAPI>(customAPI: CustomAPI) {
  expose()

  // Use `contextBridge` APIs to expose Electron APIs to
  // renderer only if context isolation is enabled, otherwise
  // just add to the DOM global.
  if (contextIsolated) {
    try {
      contextBridge.exposeInMainWorld('api', customAPI)
    }
    catch (error) {
      console.error(error)
    }
  }
  else {
    (window as ElectronWindow<CustomAPI>).api = customAPI
  }
}
