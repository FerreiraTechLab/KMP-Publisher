const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {MetricsStore} = require("../src/core/metrics-store");

test("persists network totals and equivalent downloads", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kmp-metrics-"));
  context.after(() => fs.rm(directory, {recursive: true, force: true}));
  const file = path.join(directory, "metrics.json");
  const store = new MetricsStore(file); await store.load();
  let value = await store.sample([{infoHash: "a".repeat(40), uploadLength: "100",
    downloadLength: "40", totalLength: "100", connections: "1"}],
    [{id: "port@1", infoHash: "a".repeat(40)}]);
  assert.equal(value.equivalentDownloads, 1);
  const restored = new MetricsStore(file); await restored.load();
  value = await restored.sample([{infoHash: "a".repeat(40), uploadLength: "150",
    downloadLength: "60", totalLength: "100", connections: "0"}],
    [{id: "port@1", infoHash: "a".repeat(40)}]);
  assert.equal(value.totalNetworkBytes, 210);
  assert.equal(value.equivalentDownloads, 1.5);
});
