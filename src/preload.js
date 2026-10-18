const {contextBridge, ipcRenderer} = require("electron");

contextBridge.exposeInMainWorld("publisher", {
  bootstrap: () => ipcRenderer.invoke("app:bootstrap"),
  dashboard: () => ipcRenderer.invoke("dashboard:get"),
  editPort: (id) => ipcRenderer.invoke("ports:edit-data", id),
  choosePackage: () => ipcRenderer.invoke("package:choose"),
  validate: (input, inspected) => ipcRenderer.invoke("submission:validate", input, inspected),
  exportProposal: (input, inspected, editingId) => ipcRenderer.invoke("submission:export", input, inspected, editingId),
  listSeeds: () => ipcRenderer.invoke("seeds:list"),
  seedDetails: (id) => ipcRenderer.invoke("seeds:details", id),
  exportTorrent: (id) => ipcRenderer.invoke("seeds:export-torrent", id),
  startSeed: (id) => ipcRenderer.invoke("seeds:start", id),
  stopSeed: (id) => ipcRenderer.invoke("seeds:stop", id),
  syncSeeds: () => ipcRenderer.invoke("seeds:sync"),
  communityStatus: () => ipcRenderer.invoke("community:status"),
  setCommunity: (enabled) => ipcRenderer.invoke("community:set", enabled),
  connectGitHub: (token) => ipcRenderer.invoke("github:connect", token),
  githubStatus: () => ipcRenderer.invoke("github:status"),
  publishProposal: (id) => ipcRenderer.invoke("github:publish", id),
  openExternal: (url) => ipcRenderer.invoke("external:open", url)
});
