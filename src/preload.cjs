// 편집기 화면과 메인 프로세스를 잇는 좁은 통로. 화면은 이 함수들만 쓸 수 있다.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("nextOffice", {
  onRequest: (callback) => ipcRenderer.on("main:request", (_event, message) => callback(message)),
  respond: (id, ok, result, error) => ipcRenderer.send("renderer:response", { id, ok, result, error }),
  ready: (info) => ipcRenderer.send("renderer:ready", info),
  setDirty: (value) => ipcRenderer.send("renderer:dirty", Boolean(value)),
  updateMenuState: (states) => ipcRenderer.send("renderer:menu-state", states),
  runAction: (action) => ipcRenderer.send("renderer:action", String(action)),
  openPaths: (paths) => ipcRenderer.send("renderer:open-paths", paths),
  reportError: (message) => ipcRenderer.send("renderer:error", String(message)),
  getPathForFile: (file) => webUtils.getPathForFile(file),
});
