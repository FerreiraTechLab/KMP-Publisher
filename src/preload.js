const {contextBridge, ipcRenderer} = require("electron");

contextBridge.exposeInMainWorld("publisher", {
  choosePackage: () => ipcRenderer.invoke("package:choose"),
  validate: (input, inspected) => ipcRenderer.invoke("submission:validate", input, inspected),
  exportProposal: (input, inspected) => ipcRenderer.invoke("submission:export", input, inspected),
  listSeeds: () => ipcRenderer.invoke("seeds:list"),
  attachTorrent: (id) => ipcRenderer.invoke("seeds:attach", id),
  startSeed: (id) => ipcRenderer.invoke("seeds:start", id),
  stopSeed: (id) => ipcRenderer.invoke("seeds:stop", id),
  syncSeeds: () => ipcRenderer.invoke("seeds:sync")
});
