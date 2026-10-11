const {contextBridge, ipcRenderer} = require("electron");

contextBridge.exposeInMainWorld("publisher", {
  choosePackage: () => ipcRenderer.invoke("package:choose"),
  validate: (input, inspected) => ipcRenderer.invoke("submission:validate", input, inspected),
  exportProposal: (input, inspected) => ipcRenderer.invoke("submission:export", input, inspected)
});
