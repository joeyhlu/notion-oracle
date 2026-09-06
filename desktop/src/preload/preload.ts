import { contextBridge, ipcRenderer } from "electron";
import type { BrainId, ChatEvent, ChatRequest, OracleApi, OverlayMode, Settings } from "../shared/types.ts";

const api: OracleApi = {
  getSettings: () => ipcRenderer.invoke("oracle:get-settings"),
  saveSettings: (patch: Partial<Settings>) => ipcRenderer.invoke("oracle:save-settings", patch),
  checkBrain: (brain: BrainId, pathOverride?: string) => ipcRenderer.invoke("oracle:check-brain", brain, pathOverride),
  openSignIn: (brain: BrainId) => ipcRenderer.invoke("oracle:open-sign-in", brain),
  openExternal: (url: string) => ipcRenderer.invoke("oracle:open-external", url),
  testNotion: (token: string) => ipcRenderer.invoke("oracle:test-notion", token),
  getPageHint: () => ipcRenderer.invoke("oracle:page-hint"),
  platform: () => ipcRenderer.invoke("oracle:platform"),
  chatSend: (request: ChatRequest) => ipcRenderer.invoke("oracle:chat-send", request),
  chatAbort: () => ipcRenderer.invoke("oracle:chat-abort"),
  onChatEvent: (callback: (event: ChatEvent) => void) => {
    const listener = (_: unknown, event: ChatEvent) => callback(event);
    ipcRenderer.on("oracle:chat-event", listener);
    return () => ipcRenderer.removeListener("oracle:chat-event", listener);
  },
  setMode: (mode: OverlayMode) => ipcRenderer.invoke("oracle:set-mode", mode),
  onMode: (callback: (mode: OverlayMode) => void) => {
    const listener = (_: unknown, mode: OverlayMode) => callback(mode);
    ipcRenderer.on("oracle:mode", listener);
    return () => ipcRenderer.removeListener("oracle:mode", listener);
  },
  quit: () => ipcRenderer.invoke("oracle:quit"),
};

contextBridge.exposeInMainWorld("oracle", api);
