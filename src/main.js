const {app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, safeStorage, shell, Tray} = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const {inspectPackage} = require("./core/package-inspection");
const {createSubmission} = require("./core/submission");
const {SeedManager, validateTorrent} = require("./core/seed-manager");
const {findPublishedPackage, loadSignedCatalog} = require("./core/catalog-discovery");
const {generateTorrent} = require("./core/torrent-builder");
const {GitHubPublisher} = require("./core/github-publisher");
const {MetricsStore} = require("./core/metrics-store");
const {resolveProposalPath} = require("./core/proposal-record");
const {DistributionSettings, normalizeDistributionSettings} = require("./core/distribution-settings");
const {StartupManager} = require("./core/startup-manager");
const {AppUpdater} = require("./core/app-updater");
const {spawn} = require("node:child_process");

let seedManager;
let metricsStore;
let applicationReady = false;
let githubToken = null;
let distributionSettings;
let startupManager;
let mainWindow = null;
const publishing = new Map();
let tray = null;
let appUpdater = null;
let notifiedUpdate = null;
let isQuitting = false;
const CATALOG_URL = "https://ferreiratechlab.github.io/KMP-catalog";
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

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


async function githubIdentity() {
  if (!githubToken) return {connected: false};
  try {
    const user = await new GitHubPublisher(githubToken).identity();
    return {connected: true, login: user.login};
  } catch { return {connected: false}; }
}

function metadataFromSubmission(document) {
  const project = document.project || {}; const release = document.release || {};
  const variant = release.variants?.[0] || {}; const compatibility = variant.compatibility || {};
  const requirements = variant.requirements || {}; const install = variant.install || {};
  return {id: project.id, name: project.name, description: project.description,
    version: release.version, revision: String((release.revision || 1) + 1),
    channel: release.channel || "stable", releaseNotes: release.notes || "",
    homepage: project.homepage || "", source: project.source || "",
    porterName: project.porter?.name || "", porterUrl: project.porter?.url || "",
    license: project.license || "", licenseEvidence: project.redistribution?.evidence || "",
    redistributionNotes: project.redistribution?.notes || "", redistributionAllowed: true,
    installPaths: (install.paths || []).join(", "), userDataPaths: (install.userDataPaths || []).join(", "),
    architectures: (compatibility.architectures || []).join(", "),
    firmwares: (compatibility.firmwares?.include || []).join(", "),
    variantId: variant.id || "aarch64-portmaster", minimumRamMB: String(requirements.minimumRamMB || 128),
    analogSticks: String(requirements.analogSticks || 0), renderers: (requirements.renderers || []).join(", "),
    runtimes: (requirements.runtimes || []).join(", "), readyToRun: requirements.readyToRun !== false};
}

async function dashboardData() {
  const records = seedManager.list();
  const transfers = await seedManager.networkSnapshot().catch(() => []);
  const metrics = await metricsStore.sample(transfers, seedManager.records);
  return {ready: applicationReady, records, metrics,
    published: records.filter((item) => item.publicationStatus === "published").length,
    waiting: records.filter((item) => item.publicationStatus !== "published").length};
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
    // validateTorrent confere cada peça contra o ZIP local: um infohash diferente só pode
    // vir de outro tamanho de peça (por exemplo, para caber no limite do catálogo), então
    // a semente passa a usar o torrent publicado.
    const publishedInfoHash = await validateTorrent(candidatePath, record.packagePath);
    if (record.infoHash && publishedInfoHash !== record.infoHash && seedManager.processes.has(record.id))
      await seedManager.stop(record.id);
    await fs.rename(candidatePath, torrentPath);
    await seedManager.attachTorrent(record.id, torrentPath);
    record.publicationStatus = "published";
    await seedManager.save();
    if (!seedManager.processes.has(record.id)) await seedManager.start(record.id);
    activated += 1;
  }
  let community = null;
  const settings = distributionSettings.value;
  if (settings.communityEnabled) community = await seedManager.mirrorCatalog(catalog,
    settings.maxCommunityStorageGiB * 1024 * 1024 * 1024, settings.maxCommunityPorts);
  else community = await seedManager.stopCommunity();
  const seedNodes = await seedManager.connectSeedNodes(catalog.extensions?.["kmp.seed-nodes"]).catch(() => 0);
  return {sequence: catalog.sequence, activated, community, seedNodes};
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

function createWindow(options = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setSkipTaskbar(false); mainWindow.show(); mainWindow.focus(); return mainWindow;
  }
  mainWindow = new BrowserWindow({
    width: 1120, height: 760, minWidth: 900, minHeight: 640,
    show: options.show !== false, skipTaskbar: options.show === false,
    backgroundColor: "#09111f", title: "KMP Publisher",
    webPreferences: {preload: path.join(__dirname, "preload.js"), contextIsolation: true,
      nodeIntegration: false, sandbox: true}
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, "renderer/index.html"));
  mainWindow.on("close", (event) => {
    if (!isQuitting && distributionSettings?.value.runInBackground) {
      event.preventDefault(); mainWindow.hide(); mainWindow.setSkipTaskbar(true);
      if (Notification.isSupported()) new Notification({title: "KMP Publisher",
        body: "A janela foi fechada, mas os ports continuam sendo semeados. Abra o Publisher novamente para restaurar a janela."}).show();
    }
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  return mainWindow;
}

function updateTray() {
  if (!distributionSettings?.value.runInBackground) {
    if (tray) { tray.destroy(); tray = null; }
    return;
  }
  if (tray) return;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="7" fill="#31cfa0"/><path d="M7 7h5v7l7-7h6l-9 9 9 9h-6l-7-7v7H7z" fill="#07151a"/></svg>';
  const icon = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
  tray = new Tray(icon.resize({width: 22, height: 22}));
  tray.setToolTip("KMP Publisher — distribuição ativa");
  tray.setContextMenu(Menu.buildFromTemplate([
    {label: "Abrir KMP Publisher", click: () => createWindow()},
    {type: "separator"},
    {label: "Encerrar", click: async () => {
      isQuitting = true;
      if (seedManager) await seedManager.shutdown();
      app.quit();
    }}
  ]));
  tray.on("click", () => createWindow());
}

function reportUpdate(state) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("updater:state", state);
  if (state.status === "available" && notifiedUpdate !== state.version && Notification.isSupported() &&
      (!mainWindow || !mainWindow.isVisible())) {
    notifiedUpdate = state.version;
    new Notification({title: "KMP Publisher", body: `A versão ${state.version} está disponível. Abra o Publisher para atualizar.`}).show();
  }
}

// Linux troca o AppImage e reabre; Windows roda o instalador; no Mac, sem assinatura da
// Apple, só dá para abrir o DMG e deixar a troca com o usuário.
async function installUpdate() {
  if (publishing.size) throw new Error("Aguarde o envio da proposta terminar antes de atualizar.");
  const file = appUpdater.state.status === "ready" ? appUpdater.state.file : await appUpdater.download();
  if (process.platform === "linux") {
    const target = process.env.APPIMAGE;
    if (!target) { shell.showItemInFolder(file); return {ok: true, manual: true,
      message: "Este Publisher não roda como AppImage; o arquivo novo foi aberto na pasta de downloads."}; }
    const staged = `${target}.update`;
    try {
      await fs.copyFile(file, staged);
      await fs.chmod(staged, 0o755);
      await fs.rename(staged, target);
    } catch (error) {
      await fs.rm(staged, {force: true});
      shell.showItemInFolder(file);
      return {ok: true, manual: true, message: `Sem permissão para trocar ${target}; substitua pelo arquivo aberto na pasta.`};
    }
    isQuitting = true;
    await seedManager.shutdown();
    // app.relaunch delega a um processo de dentro do AppImage montado, que some quando
    // o app fecha; um sh à parte espera a trava de instância ser liberada e abre o novo.
    const env = {...process.env};
    for (const name of ["APPDIR", "APPIMAGE", "ARGV0", "OWD"]) delete env[name];
    spawn("/bin/sh", ["-c", 'sleep 2; exec "$0"', target], {detached: true, stdio: "ignore", env}).unref();
    app.exit(0);
    return {ok: true};
  }
  if (process.platform === "win32") {
    isQuitting = true;
    await seedManager.shutdown();
    spawn(file, [], {detached: true, stdio: "ignore"}).unref();
    app.quit();
    return {ok: true};
  }
  const opened = await shell.openPath(file);
  if (opened) throw new Error(opened);
  return {ok: true, manual: true,
    message: "O instalador foi aberto. Encerre o Publisher e arraste o app para Aplicativos, substituindo o anterior."};
}

ipcMain.handle("app:bootstrap", async () => ({ready: applicationReady, github: await githubIdentity(), appVersion: app.getVersion()}));
ipcMain.handle("dashboard:get", async () => {
  try { return {ok: true, ...(await dashboardData())}; }
  catch (error) { return {ok: false, error: error.message}; }
});
ipcMain.handle("ports:edit-data", async (_event, id) => {
  try {
    const record = seedManager.records.find((item) => item.id === id);
    if (!record) throw new Error("Port não encontrado.");
    let metadata = record.metadata ? {...record.metadata} : null;
    const proposalRoot = resolveProposalPath(record);
    if (!metadata) {
      if (!proposalRoot) throw new Error("A proposta antiga não possui um caminho recuperável.");
      metadata = metadataFromSubmission(JSON.parse(
        await fs.readFile(path.join(proposalRoot, "submission.json"), "utf8")));
      record.proposalPath = proposalRoot;
      record.metadata = {...metadata, revision: String(Math.max(1, Number(metadata.revision || 2) - 1))};
      await seedManager.save();
    }
    else metadata.revision = String(Number(metadata.revision || 1) + 1);
    const inspected = await inspectPackage(record.packagePath);
    return {ok: true, metadata, inspected};
  } catch (error) { return {ok: false, error: error.message}; }
});

ipcMain.handle("package:choose", async () => {
  const selected = await dialog.showOpenDialog({title: "Selecione o ZIP do port",
    properties: ["openFile"], filters: [{name: "Pacote ZIP", extensions: ["zip"]}]});
  if (selected.canceled || !selected.filePaths[0]) return null;
  try { return {ok: true, package: await inspectPackage(selected.filePaths[0])}; }
  catch (error) { return {ok: false, error: error.message}; }
});

ipcMain.handle("submission:validate", (_event, input, inspected) => createSubmission(input, inspected));

ipcMain.handle("submission:export", async (_event, input, inspected, editingId) => {
  const generated = createSubmission(input, inspected);
  if (generated.errors.length) return generated;
  const selected = await dialog.showOpenDialog({title: "Escolha onde exportar a proposta",
    properties: ["openDirectory", "createDirectory"]});
  if (selected.canceled || !selected.filePaths[0]) return {canceled: true, errors: []};
  const revisionSuffix = editingId ? `-r${Number(input.revision || 1)}` : "";
  const folderName = `${input.id}-${input.version}${revisionSuffix}`.replace(/[^A-Za-z0-9._-]/g, "-");
  const output = path.join(selected.filePaths[0], folderName);
  const packages = path.join(output, "packages");
  const torrents = path.join(output, "torrents");
  await fs.mkdir(packages, {recursive: true});
  const packagePath = path.join(packages, inspected.fileName);
  await fs.copyFile(inspected.filePath, packagePath);
  await fs.writeFile(path.join(output, "submission.json"),
    JSON.stringify(generated.submission, null, 2) + "\n", {encoding: "utf8", flag: "wx"});
  if (editingId) await seedManager.stop(editingId);
  await seedManager.registerProposal({id: input.id, version: input.version,
    sha256: inspected.sha256, packagePath, proposalPath: output, metadata: input, replaceId: editingId});
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


ipcMain.handle("distribution:get", () => ({ok: true, settings: {...distributionSettings.value}}));
ipcMain.handle("distribution:set", async (_event, value) => {
  try {
    const previous = distributionSettings.value;
    const requested = normalizeDistributionSettings(value);
    await startupManager.setEnabled(requested.startWithSystem);
    const settings = await distributionSettings.save(requested);
    updateTray();
    const uploadChanged = previous.uploadLimit !== settings.uploadLimit;
    await seedManager.stopCommunity();
    if (uploadChanged) {
      await seedManager.shutdown();
      seedManager.uploadLimit = settings.uploadLimit;
      for (const record of seedManager.records) record.uploadLimit = settings.uploadLimit;
      await seedManager.save();
      await prepareAllLocalSeeds();
    }
    if (settings.checkForUpdates && !previous.checkForUpdates) appUpdater.check().catch(() => {});
    const result = settings.communityEnabled ? await synchronizePublishedSeeds() : {community: {removed: 0}};
    return {ok: true, settings, result};
  } catch (error) { return {ok: false, error: error.message}; }
});
ipcMain.handle("seeds:list", () => seedManager.list());
ipcMain.handle("seeds:details", async (_event, id) => {
  try { return {ok: true, seed: {...await seedManager.details(id), publishing: publishing.get(id) || null}}; }
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
ipcMain.handle("github:status", githubIdentity);
// O envio de um pacote grande ao Release leva minutos: o progresso vai para a janela e
// o último erro fica na proposta, para não depender de um alerta que some.
function reportPublishing(id, state) {
  if (state) publishing.set(id, state); else publishing.delete(id);
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send("publish:progress", {id, ...(state || {done: true})});
}
// A cópia no Release é opcional: uma falha nela não desfaz o pull request, porque o
// pacote continua chegando ao nó público e ao CI pelo swarm.
async function uploadSeedRelease(id, record, upload) {
  try { await upload(); delete record.seedUploadError; }
  catch (error) { record.seedUploadError = {message: error.message, at: new Date().toISOString()}; }
  finally { await seedManager.save().catch(() => {}); reportPublishing(id, null); }
}
ipcMain.handle("github:publish", async (_event, id) => {
  if (publishing.has(id)) return {ok: false, error: "O envio desta proposta já está em andamento."};
  const record = seedManager.records.find((item) => item.id === id);
  let upload = null;
  try {
    if (!record) throw new Error("Proposta não encontrada.");
    reportPublishing(id, {stage: "Preparação do envio", startedAt: new Date().toISOString()});
    const startedAt = publishing.get(id).startedAt;
    const {upload: pending, ...result} = await new GitHubPublisher(githubToken, {
      onProgress: (progress) => reportPublishing(id, {...progress, startedAt})}).publish(record);
    record.pullRequest = result; record.submissionStatus = "in-review";
    delete record.submissionError; delete record.seedUploadError;
    await seedManager.save();
    upload = pending;
    if (upload) uploadSeedRelease(id, record, upload);
    return {ok: true, ...result};
  } catch (error) {
    if (record) { record.submissionError = {message: error.message, at: new Date().toISOString()}; await seedManager.save(); }
    return {ok: false, error: error.message};
  } finally { if (!upload) reportPublishing(id, null); }
});
ipcMain.handle("github:review-status", async (_event, id) => {
  try {
    const record = seedManager.records.find((item) => item.id === id);
    if (!record?.pullRequest?.pullNumber) return {ok: true, status: null};
    const status = await new GitHubPublisher(githubToken).reviewStatus(record.pullRequest.pullNumber);
    record.pullRequest.status = status; await seedManager.save();
    return {ok: true, status};
  } catch (error) { return {ok: false, error: error.message}; }
});
ipcMain.handle("external:open", (_event, url) => shell.openExternal(url));
ipcMain.handle("updater:get", () => ({...appUpdater.state}));
ipcMain.handle("updater:check", () => appUpdater.check());
ipcMain.handle("updater:install", async () => {
  try { return await installUpdate(); }
  catch (error) { return {ok: false, error: error.message}; }
});
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

app.on("second-instance", () => createWindow());

app.whenReady().then(async () => {
  if (!singleInstance) return;
  distributionSettings = new DistributionSettings(path.join(app.getPath("userData"), "distribution.json"));
  const settings = await distributionSettings.load();
  startupManager = new StartupManager(app);
  try { await startupManager.setEnabled(settings.startWithSystem); }
  catch (error) { console.error("Não foi possível sincronizar a inicialização automática:", error); }
  seedManager = new SeedManager(path.join(app.getPath("userData"), "seeding"),
    {uploadLimit: settings.uploadLimit});
  metricsStore = new MetricsStore(path.join(app.getPath("userData"), "metrics.json"));
  await Promise.all([seedManager.load(), metricsStore.load()]);
  githubToken = await loadGitHubToken();
  createWindow({show: !process.argv.includes("--background")});
  updateTray();
  (async () => {
    try { await prepareAllLocalSeeds(); await synchronizePublishedSeeds(); }
    catch (error) { console.error(error); }
    finally { applicationReady = true; }
  })();
  setInterval(() => synchronizePublishedSeeds().catch(() => {}), 5 * 60 * 1000).unref();
  appUpdater = new AppUpdater({currentVersion: app.getVersion(), platform: process.platform, arch: process.arch,
    directory: path.join(app.getPath("userData"), "updates"), onState: reportUpdate});
  // Como o Publisher costuma ficar aberto em segundo plano, a verificação se repete.
  const checkUpdates = () => { if (distributionSettings.value.checkForUpdates) appUpdater.check().catch(() => {}); };
  setTimeout(checkUpdates, 20 * 1000).unref();
  setInterval(checkUpdates, 6 * 60 * 60 * 1000).unref();
  setInterval(() => dashboardData().catch(() => {}), 10 * 1000).unref();
  app.on("activate", () => createWindow());
});
app.on("window-all-closed", async () => {
  if (distributionSettings?.value.runInBackground && !isQuitting) return;
  if (seedManager) await seedManager.shutdown();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
