const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const {spawn} = require("node:child_process");
const crypto = require("node:crypto");
const net = require("node:net");
const dgram = require("node:dgram");
const {PortMapper} = require("./port-mapper");

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function availableBitTorrentPort(preferred = 6881) {
  for (let port = preferred; port < preferred + 100; port += 1) {
    const tcp = net.createServer();
    const udp = dgram.createSocket("udp4");
    try {
      await new Promise((resolve, reject) => {
        tcp.once("error", reject);
        tcp.listen(port, "0.0.0.0", resolve);
      });
      await new Promise((resolve, reject) => {
        udp.once("error", reject);
        udp.bind(port, "0.0.0.0", resolve);
      });
      return port;
    } catch {}
    finally {
      await new Promise((resolve) => tcp.listening ? tcp.close(resolve) : resolve());
      await new Promise((resolve) => {
        try { udp.close(resolve); } catch { resolve(); }
      });
    }
  }
  throw new Error(`Nenhuma porta TCP/UDP livre entre ${preferred} e ${preferred + 99}.`);
}

async function fileSha256(filePath) {
  const digest = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

async function validateTorrent(torrentPath, packagePath) {
  const bencode = (await import("bencode")).default;
  const document = bencode.decode(await fsp.readFile(torrentPath));
  const info = document && document.info;
  if (!info || info.files || !Number.isSafeInteger(info.length))
    throw new Error("O torrent oficial precisa conter somente um arquivo.");
  if (Number(info.private || 0) !== 0)
    throw new Error("O torrent oficial não pode ser privado, pois todos os nós usam DHT.");
  const tiers = Array.isArray(document["announce-list"]) ? document["announce-list"] : [];
  const trackers = new Set(tiers.flatMap((tier) => Array.isArray(tier) ? tier : [tier])
    .map((value) => Buffer.from(value).toString("utf8")).filter(Boolean));
  if (document.announce) trackers.add(Buffer.from(document.announce).toString("utf8"));
  if (trackers.size < 2)
    throw new Error("O torrent oficial precisa conter ao menos dois trackers públicos.");
  const name = info.name instanceof Uint8Array ? Buffer.from(info.name).toString("utf8") : String(info.name || "");
  const stat = await fsp.stat(packagePath);
  if (name !== path.basename(packagePath) || info.length !== stat.size)
    throw new Error("Nome ou tamanho do torrent não corresponde ao ZIP registrado.");
  return crypto.createHash("sha1").update(bencode.encode(info)).digest("hex");
}

function findExecutable(name, environment = process.env) {
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const directory of String(environment.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension);
      try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
    }
  }
  return null;
}

function bundledTorrentd() {
  const executable = process.platform === "win32" ? "kmp-torrentd.exe" : "kmp-torrentd";
  const platformArch = `${process.platform}-${process.arch}`;
  const candidates = [
    path.join(process.resourcesPath || "", "torrentd", platformArch, executable),
    path.resolve(__dirname, "../../resources/torrentd", platformArch, executable)
  ];
  return candidates.find((candidate) => {
    try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; }
  }) || null;
}

class SeedManager {
  constructor(stateDirectory, options = {}) {
    this.stateDirectory = stateDirectory;
    this.stateFile = path.join(stateDirectory, "seeds.json");
    this.communityFile = path.join(stateDirectory, "community.json");
    this.communityHashes = new Set();
    this.torrentd = options.torrentd === undefined ?
      (options.aria2 === undefined ? (bundledTorrentd() || findExecutable("kmp-torrentd")) : null) :
      options.torrentd;
    this.aria2 = options.aria2 || findExecutable("aria2c");
    this.backend = this.torrentd || this.aria2;
    this.backendKind = this.torrentd ? "kmp-torrentd" : "aria2";
    this.fetch = options.fetch || globalThis.fetch;
    this.spawn = options.spawn || spawn;
    this.allocatePort = options.availablePort || availablePort;
    this.listenPort = options.listenPort || 6881;
    this.allocateListenPort = options.availableListenPort || availableBitTorrentPort;
    this.portMapperProvided = Boolean(options.portMapper);
    this.portMapper = options.portMapper || new PortMapper(this.listenPort);
    this.daemon = null;
    this.daemonStopping = false;
    this.exitPromise = null;
    this.processes = new Map();
    this.records = [];
    this.lastDaemonError = "";
  }
  async load() {
    await fsp.mkdir(this.stateDirectory, {recursive: true});
    try { const parsed = JSON.parse(await fsp.readFile(this.stateFile, "utf8")); this.records = Array.isArray(parsed.records) ? parsed.records : []; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    try {
      const community = JSON.parse(await fsp.readFile(this.communityFile, "utf8"));
      this.communityHashes = new Set(Array.isArray(community.infoHashes) ? community.infoHashes : []);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    return this.list();
  }
  async save() {
    const temporary = this.stateFile + ".tmp";
    await fsp.writeFile(temporary, JSON.stringify({version: 1, records: this.records}, null, 2) + "\n");
    await fsp.rename(temporary, this.stateFile);
  }
  list() { return this.records.map((record) => ({...record, running: this.processes.has(record.id), backendAvailable: Boolean(this.backend), backendKind: this.backendKind})); }
  async rpc(method, params = []) {
    if (!this.daemon) throw new Error("Daemon BitTorrent indisponível.");
    const response = await this.fetch(`http://127.0.0.1:${this.daemon.rpcPort}/jsonrpc`, {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({jsonrpc: "2.0", id: "kmp-publisher", method,
        params: [`token:${this.daemon.rpcSecret}`, ...params]})});
    const body = await response.json();
    if (!response.ok || body.error) throw new Error(body.error?.message || `RPC respondeu HTTP ${response.status}.`);
    return body.result;
  }
  async waitForDaemon() {
    let lastError;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try { await this.rpc("aria2.getVersion"); return; }
      catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    const detail = this.lastDaemonError || lastError?.message || "tempo esgotado";
    throw new Error(`O daemon BitTorrent não iniciou na porta ${this.listenPort}: ${detail}`);
  }
  async ensureDaemon() {
    if (this.daemon) return this.daemon;
    if (!this.backend) throw new Error("Backend BitTorrent indisponível.");
    const selectedPort = await this.allocateListenPort(this.listenPort);
    if (selectedPort !== this.listenPort) {
      this.listenPort = selectedPort;
      if (!this.portMapperProvided) this.portMapper = new PortMapper(this.listenPort);
    }
    const rpcPort = await this.allocatePort();
    const rpcSecret = crypto.randomBytes(24).toString("hex");
    const args = this.backendKind === "kmp-torrentd" ? [
      `--rpc-listen=127.0.0.1:${rpcPort}`, `--rpc-secret=${rpcSecret}`,
      `--state-dir=${path.join(this.stateDirectory, "torrentd")}`,
      `--data-dir=${path.join(this.stateDirectory, "downloads")}`,
      `--listen-port=${this.listenPort}`, "--upload-limit=1M"
    ] : ["--enable-rpc=true", "--rpc-listen-all=false",
      `--rpc-listen-port=${rpcPort}`, `--rpc-secret=${rpcSecret}`,
      "--continue=true", "--auto-file-renaming=false", "--file-allocation=none",
      "--enable-dht=true", "--enable-peer-exchange=true", "--bt-enable-lpd=true",
      `--listen-port=${this.listenPort}`,
      `--dht-listen-port=${this.listenPort}`, "--seed-ratio=0", "--console-log-level=warn"];
    const child = this.spawn(this.backend, args,
    {stdio: ["ignore", "ignore", "pipe"], windowsHide: true});
    this.lastDaemonError = "";
    if (child.stderr) child.stderr.on("data", (chunk) => {
      this.lastDaemonError = String(chunk).trim().split(/\r?\n/).at(-1).slice(0, 500);
    });
    this.daemon = {child, rpcPort, rpcSecret, startedAt: new Date().toISOString()};
    this.daemonStopping = false;
    child.once("error", () => { this.exitPromise = this.handleDaemonExit(true); });
    child.once("exit", (code) => { this.exitPromise = this.handleDaemonExit(code !== 0); });
    try { await this.waitForDaemon(); }
    catch (error) { child.kill("SIGTERM"); this.daemon = null; throw error; }
    await this.portMapper.start().catch(() => {});
    return this.daemon;
  }
  async handleDaemonExit(failed) {
    if (!this.daemon) return;
    const activeIds = [...this.processes.keys()];
    this.daemon = null; this.processes.clear();
    for (const id of activeIds) {
      const record = this.records.find((item) => item.id === id);
      if (record) record.status = failed && !this.daemonStopping ? "error" : "stopped";
    }
    await this.save();
  }
  async findTorrent(infoHash) {
    const keys = ["gid", "status", "infoHash"];
    for (const [method, params] of [["aria2.tellActive", [keys]],
      ["aria2.tellWaiting", [0, 1000, keys]], ["aria2.tellStopped", [0, 1000, keys]]]) {
      for (const item of await this.rpc(method, params) || []) {
        if (String(item.infoHash || "").toLowerCase() === String(infoHash).toLowerCase()) return item;
      }
    }
    return null;
  }
  async networkSnapshot() {
    if (!this.daemon) return [];
    const keys = ["gid", "status", "infoHash", "totalLength", "completedLength",
      "uploadLength", "downloadLength", "downloadSpeed", "uploadSpeed", "connections"];
    const byHash = new Map();
    for (const [method, params] of [["aria2.tellActive", [keys]],
      ["aria2.tellWaiting", [0, 1000, keys]], ["aria2.tellStopped", [0, 1000, keys]]]) {
      for (const item of await this.rpc(method, params) || []) {
        const hash = String(item.infoHash || "").toLowerCase();
        if (hash) byHash.set(hash, item);
      }
    }
    return [...byHash.values()];
  }
  async details(id) {
    const record = this.records.find((item) => item.id === id);
    if (!record) throw new Error("Seed não encontrado.");
    const runtime = this.processes.get(id);
    let packageSizeBytes = null;
    try { packageSizeBytes = (await fsp.stat(record.packagePath)).size; } catch {}
    let transfer = null;
    if (runtime && this.daemon) {
      try {
        const keys = ["gid", "status", "infoHash", "totalLength", "completedLength", "uploadLength",
          "uploadSpeed", "downloadSpeed", "connections", "numSeeders"];
        transfer = await this.rpc("aria2.tellStatus", [runtime.gid, keys]);
        const peers = await this.rpc("aria2.getPeers", [runtime.gid]);
        transfer.peers = Array.isArray(peers) ? peers.length : 0;
        transfer.remotePeers = (peers || []).filter((peer) => !isPrivateAddress(peer.ip)).length;
        transfer.holePunchPeers = (peers || []).filter((peer) => peer.source === "C").length;
        if (this.backendKind === "kmp-torrentd") {
          const network = await this.rpc("kmp.getNetworkStats");
          const torrentNetwork = (network.torrents || []).find((item) =>
            String(item.infoHash || "").toLowerCase() === String(record.infoHash || "").toLowerCase());
          transfer.network = {...network, torrents: undefined, torrent: torrentNetwork || null};
        }
      } catch {}
    }
    return {...record, running: Boolean(runtime), backendAvailable: Boolean(this.backend), backendKind: this.backendKind,
      pid: this.daemon?.child.pid || null, startedAt: runtime?.startedAt || null,
      listenPort: this.listenPort, portMapping: this.portMapper.details(), packageSizeBytes, transfer};
  }
  async registerProposal({id, version, sha256, packagePath, proposalPath, metadata, replaceId}) {
    const key = `${id}@${version}`;
    const existing = this.records.find((record) => record.id === (replaceId || key));
    const value = {id: key, portId: id, version, sha256, packagePath,
      metadata: metadata || existing?.metadata || null,
      proposalPath: proposalPath || existing?.proposalPath || path.dirname(path.dirname(packagePath)),
      torrentPath: existing?.torrentPath || null, status: existing?.torrentPath ? "ready" : "awaiting-publication",
      publicationStatus: existing?.publicationStatus || "awaiting-publication",
      uploadLimit: existing?.uploadLimit || "1M"};
    if (existing) Object.assign(existing, value); else this.records.push(value);
    await this.save(); return value;
  }
  async attachTorrent(id, torrentPath) {
    const record = this.records.find((item) => item.id === id);
    if (!record) throw new Error("Proposta de seed não encontrada.");
    record.infoHash = await validateTorrent(torrentPath, record.packagePath);
    record.torrentPath = torrentPath; record.status = "ready";
    await this.save(); return record;
  }
  async start(id) {
    const record = this.records.find((item) => item.id === id);
    if (!record) throw new Error("Seed não encontrado.");
    if (!this.backend) throw new Error("Backend BitTorrent indisponível.");
    if (!record.torrentPath) throw new Error("O torrent do pacote ainda não foi gerado.");
    if (this.processes.has(id)) return record;
    await Promise.all([fsp.access(record.packagePath), fsp.access(record.torrentPath)]);
    if (await fileSha256(record.packagePath) !== record.sha256)
      throw new Error("O ZIP mudou depois do registro e não pode ser semeado.");
    await validateTorrent(record.torrentPath, record.packagePath);
    await this.ensureDaemon();
    let existing = await this.findTorrent(record.infoHash);
    if (existing?.status === "error" || existing?.status === "removed") {
      await this.rpc("aria2.removeDownloadResult", [existing.gid]); existing = null;
    }
    if (existing?.status === "paused") await this.rpc("aria2.unpause", [existing.gid]);
    const gid = existing?.gid || await this.rpc("aria2.addTorrent", [
      (await fsp.readFile(record.torrentPath)).toString("base64"), [],
      {dir: path.dirname(record.packagePath), "check-integrity": "true", "continue": "true",
        "seed-ratio": "0", "max-upload-limit": record.uploadLimit}]);
    this.processes.set(id, {gid, startedAt: new Date().toISOString()});
    record.status = "seeding"; delete record.error; await this.save();
    return record;
  }
  async mirrorCatalog(catalog, limitBytes = 4 * 1024 * 1024 * 1024) {
    await this.ensureDaemon();
    const candidates = catalog.schemaVersion === 3 ?
      catalog.items.flatMap((item) => item.release?.variants || []).map((variant) => variant.download) :
      catalog.items;
    const unique = new Map();
    for (const download of candidates) {
      if (download?.torrent && download?.infoHash && Number.isSafeInteger(download.sizeBytes))
        unique.set(String(download.infoHash).toLowerCase(), download);
    }
    const selected = [...unique.values()].sort((a, b) => a.sizeBytes - b.sizeBytes);
    const existing = new Set();
    for (const [method, params] of [["aria2.tellActive", [["infoHash"]]],
      ["aria2.tellWaiting", [0, 1000, ["infoHash"]]], ["aria2.tellStopped", [0, 1000, ["infoHash"]]]])
      for (const item of await this.rpc(method, params) || []) existing.add(String(item.infoHash || "").toLowerCase());
    const directory = path.join(this.stateDirectory, "community", "packages");
    await fsp.mkdir(directory, {recursive: true});
    let reservedBytes = 0, added = 0, managed = 0;
    for (const download of selected) {
      if (reservedBytes + download.sizeBytes > limitBytes) continue;
      reservedBytes += download.sizeBytes; managed += 1;
      if (existing.has(String(download.infoHash).toLowerCase())) continue;
      await this.rpc("aria2.addTorrent", [download.torrent, [], {dir: directory,
        "continue": "true", "check-integrity": "true", "seed-ratio": "0",
        "auto-file-renaming": "false"}]);
      added += 1;
      this.communityHashes.add(String(download.infoHash).toLowerCase());
    }
    await fsp.writeFile(this.communityFile, JSON.stringify({
      infoHashes: [...this.communityHashes].sort()
    }, null, 2) + "\n");
    return {managed, added, reservedBytes, limitBytes};
  }
  async stopCommunity() {
    if (!this.communityHashes.size) return {removed: 0};
    await this.ensureDaemon();
    let removed = 0;
    for (const [method, params] of [["aria2.tellActive", [["gid", "infoHash"]]],
      ["aria2.tellWaiting", [0, 1000, ["gid", "infoHash"]]],
      ["aria2.tellStopped", [0, 1000, ["gid", "infoHash"]]]]) {
      for (const item of await this.rpc(method, params) || []) {
        if (!this.communityHashes.has(String(item.infoHash || "").toLowerCase())) continue;
        try { await this.rpc("aria2.forceRemove", [item.gid]); }
        catch { try { await this.rpc("aria2.removeDownloadResult", [item.gid]); } catch {} }
        removed += 1;
      }
    }
    this.communityHashes.clear();
    await fsp.writeFile(this.communityFile, JSON.stringify({infoHashes: []}, null, 2) + "\n");
    return {removed};
  }
  async stop(id) {
    const runtime = this.processes.get(id);
    if (runtime && this.daemon) {
      try { await this.rpc("aria2.forceRemove", [runtime.gid]); } catch {}
      this.processes.delete(id);
    }
    const record = this.records.find((item) => item.id === id);
    if (record) { record.status = "stopped"; await this.save(); }
  }
  async shutdown() {
    if (!this.daemon) { await this.portMapper.stop(); return; }
    this.daemonStopping = true;
    const child = this.daemon.child;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try { await this.rpc("aria2.shutdown"); }
    catch { child.kill("SIGTERM"); }
    await exited;
    if (this.exitPromise) await this.exitPromise;
    await this.portMapper.stop();
  }
}

function isPrivateAddress(address) {
  let value = String(address || "").toLowerCase();
  if (value.startsWith("::ffff:")) value = value.slice(7);
  if (value === "::1" || value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd")) return true;
  const parts = value.split(".").map(Number);
  return parts.length === 4 && parts.every(Number.isInteger) &&
    (parts[0] === 10 || parts[0] === 127 || (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 169 && parts[1] === 254));
}

module.exports = {SeedManager, availableBitTorrentPort, availablePort, bundledTorrentd,
  findExecutable, isPrivateAddress, validateTorrent};
