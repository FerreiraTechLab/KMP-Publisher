const fs = require("node:fs/promises");

const DEFAULTS = Object.freeze({
  communityEnabled: true,
  runInBackground: false,
  uploadLimit: "1M",
  maxCommunityPorts: 10,
  maxCommunityStorageGiB: 4
});
const UPLOAD_LIMITS = new Set(["0", "256K", "512K", "1M", "2M", "5M", "10M"]);

function normalizeDistributionSettings(value = {}) {
  const uploadLimit = String(value.uploadLimit || DEFAULTS.uploadLimit).toUpperCase();
  const maxCommunityPorts = Number(value.maxCommunityPorts);
  const maxCommunityStorageGiB = Number(value.maxCommunityStorageGiB);
  return {
    communityEnabled: value.communityEnabled !== false,
    runInBackground: value.runInBackground === true,
    uploadLimit: UPLOAD_LIMITS.has(uploadLimit) ? uploadLimit : DEFAULTS.uploadLimit,
    maxCommunityPorts: Number.isInteger(maxCommunityPorts) && maxCommunityPorts >= 1 && maxCommunityPorts <= 100 ?
      maxCommunityPorts : DEFAULTS.maxCommunityPorts,
    maxCommunityStorageGiB: Number.isFinite(maxCommunityStorageGiB) && maxCommunityStorageGiB >= 1 && maxCommunityStorageGiB <= 100 ?
      maxCommunityStorageGiB : DEFAULTS.maxCommunityStorageGiB
  };
}

class DistributionSettings {
  constructor(filePath) { this.filePath = filePath; this.value = {...DEFAULTS}; }
  async load() {
    try { this.value = normalizeDistributionSettings(JSON.parse(await fs.readFile(this.filePath, "utf8"))); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    return {...this.value};
  }
  async save(value) {
    this.value = normalizeDistributionSettings(value);
    const temporary = this.filePath + ".tmp";
    await fs.writeFile(temporary, JSON.stringify({version: 1, ...this.value}, null, 2) + "\n");
    await fs.rename(temporary, this.filePath);
    return {...this.value};
  }
}

module.exports = {DEFAULTS, DistributionSettings, normalizeDistributionSettings};
