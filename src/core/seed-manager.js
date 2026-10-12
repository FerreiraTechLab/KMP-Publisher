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
  async details(id) {
    const record = this.records.find((item) => item.id === id);
    if (!record) throw new Error("Seed não encontrado.");
    const runtime = this.processes.get(id);
    let packageSizeBytes = null;
    try { packageSizeBytes = (await fsp.stat(record.packagePath)).size; } catch {}
    let transfer = null;
    if (runtime?.rpcPort) {
      try {
        const parameters = [`token:${runtime.rpcSecret}`,
          ["gid", "status", "infoHash", "totalLength", "completedLength", "uploadLength",
            "uploadSpeed", "downloadSpeed", "connections", "numSeeders"]];
        const response = await this.fetch(`http://127.0.0.1:${runtime.rpcPort}/jsonrpc`, {
          method: "POST", headers: {"Content-Type": "application/json"},
          body: JSON.stringify({jsonrpc: "2.0", id: "kmp-publisher", method: "aria2.tellActive", params: parameters})});
        const body = await response.json();
        transfer = body.result?.find((item) => !record.infoHash || item.infoHash === record.infoHash) || null;
      } catch {}
    }
    return {...record, running: Boolean(runtime), backendAvailable: Boolean(this.aria2),
      pid: runtime?.child.pid || null, startedAt: runtime?.startedAt || null, packageSizeBytes, transfer};
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
    const rpcPort = await availablePort();
    const rpcSecret = crypto.randomBytes(24).toString("hex");
    const child = spawn(this.aria2, ["--check-integrity=true", "--continue=true", "--file-allocation=none",
      "--seed-ratio=0", `--max-upload-limit=${record.uploadLimit}`,
      "--bt-enable-lpd=true", "--enable-dht=true", "--enable-peer-exchange=true",
      "--enable-rpc=true", "--rpc-listen-all=false", `--rpc-listen-port=${rpcPort}`,
      `--rpc-secret=${rpcSecret}`,
      `--dir=${path.dirname(record.packagePath)}`, record.torrentPath], {stdio: "ignore", windowsHide: true});
    this.processes.set(id, {child, rpcPort, rpcSecret, startedAt: new Date().toISOString()}); record.status = "checking";
    child.once("spawn", async () => { record.status = "seeding"; await this.save(); });
    child.once("error", async () => { this.processes.delete(id); record.status = "error"; await this.save(); });
    child.once("exit", async (code) => { this.processes.delete(id); record.status = code === 0 ? "stopped" : "error"; await this.save(); });
    return record;
  }
  async stop(id) {
    const runtime = this.processes.get(id); if (runtime) runtime.child.kill("SIGTERM");
    const record = this.records.find((item) => item.id === id);
    if (record) { record.status = "stopped"; await this.save(); }
  }
}

module.exports = {SeedManager, findExecutable, validateTorrent};
