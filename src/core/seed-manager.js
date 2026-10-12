const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const {spawn} = require("node:child_process");
const crypto = require("node:crypto");
const net = require("node:net");

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

class SeedManager {
  constructor(stateDirectory, options = {}) {
    this.stateDirectory = stateDirectory;
    this.stateFile = path.join(stateDirectory, "seeds.json");
    this.aria2 = options.aria2 || findExecutable("aria2c");
    this.fetch = options.fetch || globalThis.fetch;
    this.spawn = options.spawn || spawn;
    this.allocatePort = options.availablePort || availablePort;
    this.listenPort = options.listenPort || 6881;
    this.daemon = null;
    this.daemonStopping = false;
    this.exitPromise = null;
    this.processes = new Map();
    this.records = [];
  }
  async load() {
    await fsp.mkdir(this.stateDirectory, {recursive: true});
    try { const parsed = JSON.parse(await fsp.readFile(this.stateFile, "utf8")); this.records = Array.isArray(parsed.records) ? parsed.records : []; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    return this.list();
  }
  async save() {
    const temporary = this.stateFile + ".tmp";
    await fsp.writeFile(temporary, JSON.stringify({version: 1, records: this.records}, null, 2) + "\n");
    await fsp.rename(temporary, this.stateFile);
  }
  list() { return this.records.map((record) => ({...record, running: this.processes.has(record.id), backendAvailable: Boolean(this.aria2)})); }
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
    throw new Error(`O daemon BitTorrent não iniciou na porta ${this.listenPort}: ${lastError?.message || "tempo esgotado"}`);
  }
  async ensureDaemon() {
    if (this.daemon) return this.daemon;
    if (!this.aria2) throw new Error("Backend BitTorrent indisponível.");
    const rpcPort = await this.allocatePort();
    const rpcSecret = crypto.randomBytes(24).toString("hex");
    const child = this.spawn(this.aria2, ["--enable-rpc=true", "--rpc-listen-all=false",
      `--rpc-listen-port=${rpcPort}`, `--rpc-secret=${rpcSecret}`,
      "--continue=true", "--auto-file-renaming=false", "--file-allocation=none",
      "--enable-dht=true", "--enable-peer-exchange=true", "--bt-enable-lpd=true",
      `--listen-port=${this.listenPort}`,
      `--dht-listen-port=${this.listenPort}`, "--seed-ratio=0", "--console-log-level=warn"],
    {stdio: "ignore", windowsHide: true});
    this.daemon = {child, rpcPort, rpcSecret, startedAt: new Date().toISOString()};
    this.daemonStopping = false;
    child.once("error", () => { this.exitPromise = this.handleDaemonExit(true); });
    child.once("exit", (code) => { this.exitPromise = this.handleDaemonExit(code !== 0); });
    try { await this.waitForDaemon(); }
    catch (error) { child.kill("SIGTERM"); this.daemon = null; throw error; }
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
      } catch {}
    }
    return {...record, running: Boolean(runtime), backendAvailable: Boolean(this.aria2),
      pid: this.daemon?.child.pid || null, startedAt: runtime?.startedAt || null,
      listenPort: this.listenPort, portMapping: false, packageSizeBytes, transfer};
  }
  async registerProposal({id, version, sha256, packagePath, proposalPath}) {
    const key = `${id}@${version}`;
    const existing = this.records.find((record) => record.id === key);
    const value = {id: key, portId: id, version, sha256, packagePath,
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
    if (!this.aria2) throw new Error("Backend BitTorrent indisponível.");
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
    record.status = "seeding"; await this.save();
    return record;
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
    if (!this.daemon) return;
    this.daemonStopping = true;
    const child = this.daemon.child;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try { await this.rpc("aria2.shutdown"); }
    catch { child.kill("SIGTERM"); }
    await exited;
    if (this.exitPromise) await this.exitPromise;
  }
}

function isPrivateAddress(address) {
  const value = String(address || "").toLowerCase();
  if (value === "::1" || value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd")) return true;
  const parts = value.split(".").map(Number);
  return parts.length === 4 && parts.every(Number.isInteger) &&
    (parts[0] === 10 || parts[0] === 127 || (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 169 && parts[1] === 254));
}

module.exports = {SeedManager, availablePort, findExecutable, isPrivateAddress, validateTorrent};
