const fsp = require("node:fs/promises");
const path = require("node:path");

class MetricsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = {version: 1, totalUploadedBytes: 0, totalDownloadedBytes: 0,
      peersSeen: 0, transfers: {}, ports: {}, updatedAt: null};
  }
  async load() {
    try {
      const value = JSON.parse(await fsp.readFile(this.filePath, "utf8"));
      if (value?.version === 1) this.state = {...this.state, ...value,
        transfers: value.transfers || {}, ports: value.ports || {}};
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    return this.state;
  }
  async save() {
    await fsp.mkdir(path.dirname(this.filePath), {recursive: true});
    const temporary = this.filePath + ".tmp";
    await fsp.writeFile(temporary, JSON.stringify(this.state, null, 2) + "\n");
    await fsp.rename(temporary, this.filePath);
  }
  async sample(transfers, records) {
    const owned = new Map(records.filter((record) => record.infoHash)
      .map((record) => [String(record.infoHash).toLowerCase(), record]));
    for (const transfer of transfers) {
      const hash = String(transfer.infoHash || "").toLowerCase();
      if (!hash) continue;
      const uploaded = Number(transfer.uploadLength) || 0;
      const downloaded = Number(transfer.downloadLength) || 0;
      const previous = this.state.transfers[hash] || {uploaded: 0, downloaded: 0};
      const uploadDelta = uploaded >= previous.uploaded ? uploaded - previous.uploaded : uploaded;
      const downloadDelta = downloaded >= previous.downloaded ? downloaded - previous.downloaded : downloaded;
      this.state.totalUploadedBytes += uploadDelta;
      this.state.totalDownloadedBytes += downloadDelta;
      this.state.peersSeen = Math.max(this.state.peersSeen, Number(transfer.connections) || 0);
      this.state.transfers[hash] = {uploaded, downloaded};
      const record = owned.get(hash);
      if (record) {
        const port = this.state.ports[record.id] || {uploadedBytes: 0, downloadedBytes: 0};
        port.uploadedBytes += uploadDelta; port.downloadedBytes += downloadDelta;
        port.packageSizeBytes = Number(transfer.totalLength) || port.packageSizeBytes || 0;
        this.state.ports[record.id] = port;
      }
    }
    this.state.updatedAt = new Date().toISOString();
    await this.save();
    return this.summary(records);
  }
  summary(records) {
    let equivalentDownloads = 0;
    for (const record of records) {
      const port = this.state.ports[record.id];
      if (port?.packageSizeBytes) equivalentDownloads += port.uploadedBytes / port.packageSizeBytes;
    }
    return {totalUploadedBytes: this.state.totalUploadedBytes,
      totalDownloadedBytes: this.state.totalDownloadedBytes,
      totalNetworkBytes: this.state.totalUploadedBytes + this.state.totalDownloadedBytes,
      equivalentDownloads, updatedAt: this.state.updatedAt, ports: this.state.ports};
  }
}
module.exports = {MetricsStore};
