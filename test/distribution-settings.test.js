const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {DEFAULTS, DistributionSettings, normalizeDistributionSettings} = require("../src/core/distribution-settings");

test("uses safe distribution defaults", () => {
  assert.deepEqual(normalizeDistributionSettings(), DEFAULTS);
  assert.deepEqual(normalizeDistributionSettings({uploadLimit: "invalid", maxCommunityPorts: 0,
    maxCommunityStorageGiB: 200}), DEFAULTS);
});

test("persists distribution settings", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kmp-settings-"));
  context.after(() => fs.rm(directory, {recursive: true, force: true}));
  const file = path.join(directory, "distribution.json");
  const settings = new DistributionSettings(file);
  await settings.save({communityEnabled: false, runInBackground: true, startWithSystem: true,
    uploadLimit: "5m", maxCommunityPorts: 6,
    maxCommunityStorageGiB: 12});
  const restored = new DistributionSettings(file);
  assert.deepEqual(await restored.load(), {communityEnabled: false, runInBackground: true,
    startWithSystem: true, uploadLimit: "5M",
    maxCommunityPorts: 6, maxCommunityStorageGiB: 12});
});

test("starting with the system also enables background operation", () => {
  const settings = normalizeDistributionSettings({runInBackground: false, startWithSystem: true});
  assert.equal(settings.runInBackground, true);
  assert.equal(settings.startWithSystem, true);
});
