const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {SeedManager} = require("../src/core/seed-manager");

test("persists a package while it awaits the official torrent", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kmp-publisher-seed-"));
  context.after(() => fs.rm(directory, {recursive: true, force: true}));
  const first = new SeedManager(directory, {aria2: "/fake/aria2c"});
  await first.load();
  await first.registerProposal({id: "example", version: "1.0", sha256: "a".repeat(64), packagePath: "/packages/example.zip"});
  const second = new SeedManager(directory, {aria2: "/fake/aria2c"});
  await second.load();
  assert.equal(second.list()[0].id, "example@1.0");
  assert.equal(second.list()[0].status, "awaiting-publication");
});

test("does not seed before the official torrent is attached", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kmp-publisher-seed-"));
  context.after(() => fs.rm(directory, {recursive: true, force: true}));
  const manager = new SeedManager(directory, {aria2: "/fake/aria2c"});
  await manager.load();
  await manager.registerProposal({id: "example", version: "1.0", sha256: "a".repeat(64), packagePath: "/packages/example.zip"});
  await assert.rejects(manager.start("example@1.0"), /torrent oficial/);
});
