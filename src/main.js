const {app, BrowserWindow, dialog, ipcMain, safeStorage, shell} = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const {inspectPackage} = require("./core/package-inspection");
const {createSubmission} = require("./core/submission");
const {SeedManager, validateTorrent} = require("./core/seed-manager");
const {findPublishedPackage, loadSignedCatalog} = require("./core/catalog-discovery");
const {generateTorrent} = require("./core/torrent-builder");
const {GitHubPublisher} = require("./core/github-publisher");

let seedManager;
let githubToken = null;
let communityEnabled = false;
const CATALOG_URL = "https://ferreiratechlab.github.io/KMP-catalog";

function tokenPath() { return path.join(app.getPath("userData"), "github-token.enc"); }
async function loadGitHubToken() {
  if (!safeStorage.isEncryptionAvailable()) return null;
  try { return safeStorage.decryptString(await fs.readFile(tokenPath())); }
  catch (error) { if (error.code !== "ENOENT") console.error(error); return null; }
}
async function saveGitHubToken(token) {
  githubToken = token;
  if (!safeStorage.isEncryptionAvailable()) return false;
  await fs.writeFile(tokenPath(), safeStorage.encryptString(token), {mode: 0o600});
  return true;
}

async function synchronizePublishedSeeds() {
  const key = app.isPackaged ? path.join(process.resourcesPath, "catalog-root.pub") :
    path.join(__dirname, "..", "resources", "catalog-root.pub");
  const catalog = await loadSignedCatalog({baseUrl: CATALOG_URL, publicKeyPath: key});
  const torrentDirectory = path.join(seedManager.stateDirectory, "torrents");
  await fs.mkdir(torrentDirectory, {recursive: true});
  let activated = 0;
  for (const record of seedManager.records.filter((item) => item.publicationStatus !== "published")) {
    const download = findPublishedPackage(catalog, record);
    if (!download?.torrent) continue;
    const torrentPath = path.join(torrentDirectory, `${record.portId}-${record.version}.torrent`);
    const candidatePath = torrentPath + ".published";
    await fs.writeFile(candidatePath, Buffer.from(download.torrent, "base64"));
    const publishedInfoHash = await validateTorrent(candidatePath, record.packagePath);
    if (record.infoHash && publishedInfoHash !== record.infoHash) {
      await fs.rm(candidatePath, {force: true});
      throw new Error(`O catálogo publicou um torrent diferente para ${record.id}.`);
    }
    await fs.rename(candidatePath, torrentPath);
    await seedManager.attachTorrent(record.id, torrentPath);
    record.publicationStatus = "published";
    await seedManager.save();
    if (!seedManager.processes.has(record.id)) await seedManager.start(record.id);
    activated += 1;
  }
  let community = null;
  if (communityEnabled) community = await seedManager.mirrorCatalog(catalog);
  return {sequence: catalog.sequence, activated, community};
}

async function prepareLocalSeed(record, torrentDirectory) {
  if (!record.torrentPath) {
    const torrentPath = path.join(torrentDirectory, `${record.portId}-${record.version}.torrent`);
    await generateTorrent(record.packagePath, torrentPath);
    await seedManager.attachTorrent(record.id, torrentPath);
  }
  if (!seedManager.processes.has(record.id)) await seedManager.start(record.id);
}

async function prepareAllLocalSeeds() {
  const torrentDirectory = path.join(seedManager.stateDirectory, "torrents");
  await fs.mkdir(torrentDirectory, {recursive: true});
  for (const record of seedManager.records) {
    try { await prepareLocalSeed(record, torrentDirectory); }
    catch (error) { record.status = "error"; record.error = error.message; await seedManager.save(); }
  }
}

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
  const torrents = path.join(output, "torrents");
  await fs.mkdir(packages, {recursive: true});
  const packagePath = path.join(packages, inspected.fileName);
  await fs.copyFile(inspected.filePath, packagePath);
  await fs.writeFile(path.join(output, "submission.json"),
    JSON.stringify(generated.submission, null, 2) + "\n", {encoding: "utf8", flag: "wx"});
  await seedManager.registerProposal({id: input.id, version: input.version,
    sha256: inspected.sha256, packagePath, proposalPath: output});
  const record = seedManager.records.find((item) => item.id === `${input.id}@${input.version}`);
  const torrent = await generateTorrent(packagePath,
    path.join(torrents, `${path.parse(inspected.fileName).name}.torrent`));
  await seedManager.attachTorrent(record.id, torrent.torrentPath);
  let seedWarning = null;
  try { await seedManager.start(record.id); }
  catch (error) { seedWarning = error.message; }
  return {errors: [], output, infoHash: torrent.infoHash,
    seedStarted: !seedWarning, seedWarning};
});


ipcMain.handle("community:status", () => ({enabled: communityEnabled}));
ipcMain.handle("community:set", async (_event, enabled) => {
  communityEnabled = Boolean(enabled);
  await fs.writeFile(path.join(app.getPath("userData"), "community.json"),
    JSON.stringify({enabled: communityEnabled}) + "\n");
  const result = communityEnabled ? await synchronizePublishedSeeds() : null;
  return {ok: true, enabled: communityEnabled, result};
});
ipcMain.handle("seeds:list", () => seedManager.list());
ipcMain.handle("seeds:details", async (_event, id) => {
  try { return {ok: true, seed: await seedManager.details(id)}; }
  catch (error) { return {ok: false, error: error.message}; }
});
ipcMain.handle("seeds:export-torrent", async (_event, id) => {
  try {
    const record = seedManager.records.find((item) => item.id === id);
    if (!record?.torrentPath) throw new Error("Este port ainda não possui um torrent.");
    const selected = await dialog.showSaveDialog({title: "Exportar torrent",
      defaultPath: path.basename(record.torrentPath),
      filters: [{name: "Arquivo BitTorrent", extensions: ["torrent"]}]});
    if (selected.canceled || !selected.filePath) return {ok: false, canceled: true};
    if (path.resolve(selected.filePath) !== path.resolve(record.torrentPath))
      await fs.copyFile(record.torrentPath, selected.filePath);
    return {ok: true, filePath: selected.filePath};
  } catch (error) { return {ok: false, error: error.message}; }
});
ipcMain.handle("github:connect", async (_event, token) => {
  try {
    const value = String(token || "").trim();
    const user = await new GitHubPublisher(value).identity();
    const persisted = await saveGitHubToken(value);
    return {ok: true, login: user.login, persisted};
  } catch (error) { return {ok: false, error: error.message}; }
});
ipcMain.handle("github:status", async () => {
  if (!githubToken) return {connected: false};
  try { const user = await new GitHubPublisher(githubToken).identity(); return {connected: true, login: user.login}; }
  catch { return {connected: false}; }
});
ipcMain.handle("github:publish", async (_event, id) => {
  try {
    const record = seedManager.records.find((item) => item.id === id);
    if (!record) throw new Error("Proposta não encontrada.");
    const result = await new GitHubPublisher(githubToken).publish(record);
    record.pullRequest = result; record.submissionStatus = "in-review"; await seedManager.save();
    return {ok: true, ...result};
  } catch (error) { return {ok: false, error: error.message}; }
});
ipcMain.handle("external:open", (_event, url) => shell.openExternal(url));
ipcMain.handle("seeds:start", async (_event, id) => {
  try { await seedManager.start(id); return {ok: true}; }
  catch (error) {
    const record = seedManager.records.find((item) => item.id === id);
    if (record) { record.status = "error"; record.error = error.message; await seedManager.save(); }
    return {ok: false, error: error.message};
  }
});
ipcMain.handle("seeds:stop", async (_event, id) => { await seedManager.stop(id); return {ok: true}; });
ipcMain.handle("seeds:sync", async () => {
  try { return {ok: true, ...(await synchronizePublishedSeeds())}; }
  catch (error) { return {ok: false, error: error.message}; }
});

app.whenReady().then(async () => {
  seedManager = new SeedManager(path.join(app.getPath("userData"), "seeding"));
  await seedManager.load();
  githubToken = await loadGitHubToken();
  try { communityEnabled = JSON.parse(await fs.readFile(path.join(app.getPath("userData"), "community.json"))).enabled === true; } catch {}
  await prepareAllLocalSeeds();
  createWindow();
  synchronizePublishedSeeds().catch(() => {});
  setInterval(() => synchronizePublishedSeeds().catch(() => {}), 5 * 60 * 1000).unref();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", async () => {
  if (process.platform !== "darwin") {
    if (seedManager) await seedManager.shutdown();
    app.quit();
  }
});
