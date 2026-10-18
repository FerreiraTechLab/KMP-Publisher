const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {SeedManager, isPrivateAddress} = require("../src/core/seed-manager");

test("classifies local and Internet peer addresses", () => {
  assert.equal(isPrivateAddress("192.168.0.25"), true);
  assert.equal(isPrivateAddress("::ffff:192.168.0.25"), true);
  assert.equal(isPrivateAddress("10.0.0.2"), true);
  assert.equal(isPrivateAddress("2001:4860:4860::8888"), false);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
});

test("persists a package while it awaits publication", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kmp-publisher-seed-"));
  context.after(() => fs.rm(directory, {recursive: true, force: true}));
  const first = new SeedManager(directory, {aria2: "/fake/aria2c"});
  await first.load();
  await first.registerProposal({id: "example", version: "1.0", sha256: "a".repeat(64), packagePath: "/packages/example.zip"});
  const second = new SeedManager(directory, {aria2: "/fake/aria2c"});
  await second.load();
  assert.equal(second.list()[0].id, "example@1.0");
  assert.equal(second.list()[0].status, "awaiting-publication");
  assert.equal(second.list()[0].publicationStatus, "awaiting-publication");
});

test("does not seed before its torrent is generated", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kmp-publisher-seed-"));
  context.after(() => fs.rm(directory, {recursive: true, force: true}));
  const manager = new SeedManager(directory, {aria2: "/fake/aria2c"});
  await manager.load();
  await manager.registerProposal({id: "example", version: "1.0", sha256: "a".repeat(64), packagePath: "/packages/example.zip"});
  await assert.rejects(manager.start("example@1.0"), /torrent do pacote/);
});

test("reports seed details while it is stopped", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kmp-publisher-seed-"));
  context.after(() => fs.rm(directory, {recursive: true, force: true}));
  const packagePath = path.join(directory, "example.zip");
  await fs.writeFile(packagePath, "package");
  const manager = new SeedManager(directory, {aria2: "/fake/aria2c"});
  await manager.load();
  await manager.registerProposal({id: "example", version: "1.0", sha256: "a".repeat(64), packagePath});
  const details = await manager.details("example@1.0");
  assert.equal(details.running, false);
  assert.equal(details.packageSizeBytes, 7);
  assert.equal(details.pid, null);
  assert.equal(details.transfer, null);
});

test("replaces a port record while preparing an update", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kmp-publisher-update-"));
  context.after(() => fs.rm(directory, {recursive: true, force: true}));
  const manager = new SeedManager(directory, {aria2: "/fake/aria2c"});
  await manager.load();
  await manager.registerProposal({id: "example", version: "1.0", sha256: "a".repeat(64),
    packagePath: "/packages/v1.zip", metadata: {name: "Example", revision: "1"}});
  await manager.registerProposal({id: "example", version: "2.0", sha256: "b".repeat(64),
    packagePath: "/packages/v2.zip", metadata: {name: "Example", revision: "1"},
    replaceId: "example@1.0"});
  assert.equal(manager.list().length, 1);
  assert.equal(manager.list()[0].id, "example@2.0");
  assert.equal(manager.list()[0].metadata.name, "Example");
});
