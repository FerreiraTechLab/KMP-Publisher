const {app, BrowserWindow, dialog, ipcMain} = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const {inspectPackage} = require("./core/package-inspection");
const {createSubmission} = require("./core/submission");
const {SeedManager} = require("./core/seed-manager");

let seedManager;

function createWindow() {
  const window = new BrowserWindow({
    width: 1120, height: 760, minWidth: 900, minHeight: 640,
    backgroundColor: "#09111f", title: "KMP Publisher",
    webPreferences: {preload: path.join(__dirname, "preload.js"), contextIsolation: true,
      nodeIntegration: false, sandbox: true}
  });
  window.removeMenu();
  window.loadFile(path.join(__dirname, "renderer/index.html"));
}

ipcMain.handle("package:choose", async () => {
  const selected = await dialog.showOpenDialog({title: "Selecione o ZIP do port",
    properties: ["openFile"], filters: [{name: "Pacote ZIP", extensions: ["zip"]}]});
  if (selected.canceled || !selected.filePaths[0]) return null;
  try { return {ok: true, package: await inspectPackage(selected.filePaths[0])}; }
  catch (error) { return {ok: false, error: error.message}; }
});

ipcMain.handle("submission:validate", (_event, input, inspected) => createSubmission(input, inspected));

ipcMain.handle("submission:export", async (_event, input, inspected) => {
  const generated = createSubmission(input, inspected);
  if (generated.errors.length) return generated;
  const selected = await dialog.showOpenDialog({title: "Escolha onde exportar a proposta",
    properties: ["openDirectory", "createDirectory"]});
  if (selected.canceled || !selected.filePaths[0]) return {canceled: true, errors: []};
  const folderName = `${input.id}-${input.version}`.replace(/[^A-Za-z0-9._-]/g, "-");
  const output = path.join(selected.filePaths[0], folderName);
  const packages = path.join(output, "packages");
  await fs.mkdir(packages, {recursive: true});
  await fs.copyFile(inspected.filePath, path.join(packages, inspected.fileName));
  await fs.writeFile(path.join(output, "submission.json"),
    JSON.stringify(generated.submission, null, 2) + "\n", {encoding: "utf8", flag: "wx"});
  await seedManager.registerProposal({id: input.id, version: input.version,
    sha256: inspected.sha256, packagePath: path.join(packages, inspected.fileName)});
  return {errors: [], output};
});

ipcMain.handle("seeds:list", () => seedManager.list());
ipcMain.handle("seeds:attach", async (_event, id) => {
  const selected = await dialog.showOpenDialog({title: "Selecione o torrent oficial",
    properties: ["openFile"], filters: [{name: "Torrent BitTorrent", extensions: ["torrent"]}]});
  if (selected.canceled || !selected.filePaths[0]) return {canceled: true};
  try { await seedManager.attachOfficialTorrent(id, selected.filePaths[0]); return {ok: true}; }
  catch (error) { return {ok: false, error: error.message}; }
});
ipcMain.handle("seeds:start", async (_event, id) => {
  try { await seedManager.start(id); return {ok: true}; }
  catch (error) { return {ok: false, error: error.message}; }
});
ipcMain.handle("seeds:stop", async (_event, id) => { await seedManager.stop(id); return {ok: true}; });

app.whenReady().then(async () => {
  seedManager = new SeedManager(path.join(app.getPath("userData"), "seeding"));
  await seedManager.load();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
