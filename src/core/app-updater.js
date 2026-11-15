const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const {createWriteStream} = require("node:fs");
const path = require("node:path");

// As releases do Publisher ficam no repositório público de distribuição, ao lado das
// releases do Client; só as tags publisher-v* interessam aqui.
const RELEASES_API = "https://api.github.com/repos/FerreiraTechLab/KMP-releases/releases?per_page=30";
const TAG_PREFIX = "publisher-v";
const ASSETS = {
  "linux-x64": /-linux-x64\.AppImage$/,
  "win32-x64": /-windows-x64-setup\.exe$/,
  "darwin-arm64": /-macos-arm64\.dmg$/,
  "darwin-x64": /-macos-x64\.dmg$/
};

function compareVersions(left, right) {
  const parts = (value) => String(value).split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const a = parts(left), b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
}

function assetPattern(platform, arch) { return ASSETS[`${platform}-${arch}`] || null; }

function parseChecksums(text) {
  const sums = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (match) sums.set(match[2].trim(), match[1].toLowerCase());
  }
  return sums;
}

// A release de maior versão do Publisher que tenha o instalador deste sistema e o
// SHA256SUMS.txt; uma release incompleta é ignorada. A API não ordena por publicação:
// com tags no mesmo commit, publisher-v0.3.9 vinha antes de publisher-v0.3.10.
function selectRelease(list, platform, arch) {
  const pattern = assetPattern(platform, arch);
  if (!pattern) return null;
  let best = null;
  for (const release of list) {
    if (release.draft || !String(release.tag_name).startsWith(TAG_PREFIX)) continue;
    const installer = release.assets.find((asset) => pattern.test(asset.name));
    const checksums = release.assets.find((asset) => asset.name === "SHA256SUMS.txt");
    if (!installer || !checksums) continue;
    const version = release.tag_name.slice(TAG_PREFIX.length);
    if (best && compareVersions(version, best.version) <= 0) continue;
    best = {version, page: release.html_url, notes: release.body || "",
      installer: {name: installer.name, size: installer.size, url: installer.browser_download_url},
      checksumsUrl: checksums.browser_download_url};
  }
  return best;
}

class AppUpdater {
  constructor({currentVersion, platform, arch, directory, fetch = globalThis.fetch, onState = () => {}}) {
    this.currentVersion = currentVersion;
    this.platform = platform;
    this.arch = arch;
    this.directory = directory;
    this.fetch = fetch;
    this.onState = onState;
    this.state = {status: assetPattern(platform, arch) ? "idle" : "unsupported", currentVersion};
    this.release = null;
  }

  setState(changes) {
    this.state = {...this.state, ...changes};
    this.onState({...this.state});
    return {...this.state};
  }

  async check() {
    if (this.state.status === "unsupported") return {...this.state};
    if (["downloading", "ready"].includes(this.state.status)) return {...this.state};
    this.setState({status: "checking", error: null});
    try {
      const response = await this.fetch(RELEASES_API, {headers: {Accept: "application/vnd.github+json"}});
      if (!response.ok) throw new Error(`GitHub respondeu HTTP ${response.status}.`);
      const release = selectRelease(await response.json(), this.platform, this.arch);
      const newer = release && compareVersions(release.version, this.currentVersion) > 0;
      this.release = newer ? release : null;
      return this.setState({status: newer ? "available" : "current", checkedAt: new Date().toISOString(),
        version: newer ? release.version : null, page: newer ? release.page : null,
        size: newer ? release.installer.size : null});
    } catch (error) {
      return this.setState({status: "error", error: `Não foi possível verificar atualizações: ${error.message}`});
    }
  }

  // Baixa o instalador e só o entrega se o SHA-256 bater com o SHA256SUMS.txt da release.
  async download() {
    if (!this.release) throw new Error("Nenhuma atualização disponível.");
    const {installer, checksumsUrl, version} = this.release;
    this.setState({status: "downloading", received: 0, error: null});
    try {
      const sumsResponse = await this.fetch(checksumsUrl);
      if (!sumsResponse.ok) throw new Error(`SHA256SUMS.txt indisponível (HTTP ${sumsResponse.status}).`);
      const expected = parseChecksums(await sumsResponse.text()).get(installer.name);
      if (!expected) throw new Error("O SHA256SUMS.txt da release não lista este instalador.");
      await fs.rm(this.directory, {recursive: true, force: true});
      await fs.mkdir(this.directory, {recursive: true});
      const target = path.join(this.directory, installer.name);
      const response = await this.fetch(installer.url);
      if (!response.ok || !response.body) throw new Error(`download respondeu HTTP ${response.status}.`);
      const hash = crypto.createHash("sha256");
      const output = createWriteStream(target, {mode: 0o755});
      let received = 0, lastReport = 0;
      const reader = response.body.getReader();
      try {
        for (;;) {
          const {done, value} = await reader.read();
          if (done) break;
          hash.update(value);
          if (!output.write(value)) await new Promise((resolve) => output.once("drain", resolve));
          received += value.length;
          if (received - lastReport >= 1024 * 1024) {
            lastReport = received;
            this.setState({received});
          }
        }
      } finally { await new Promise((resolve, reject) => output.end((error) => error ? reject(error) : resolve())); }
      if (hash.digest("hex") !== expected) {
        await fs.rm(target, {force: true});
        throw new Error("o SHA-256 do instalador baixado não confere; nada foi alterado.");
      }
      this.setState({status: "ready", received, file: target, version});
      return target;
    } catch (error) {
      this.setState({status: "error", error: `Falha ao baixar a atualização: ${error.message}`});
      throw error;
    }
  }
}

module.exports = {AppUpdater, compareVersions, assetPattern, parseChecksums, selectRelease, RELEASES_API};
