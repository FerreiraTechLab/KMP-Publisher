const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {generateTorrent} = require("../src/core/torrent-builder");
const {validateTorrent} = require("../src/core/seed-manager");

test("generates deterministic torrents", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kmp-torrent-"));
  context.after(() => fs.rm(directory, {recursive: true, force: true}));
  const packagePath = path.join(directory, "example-1.0.zip");
  const firstPath = path.join(directory, "first.torrent");
  const secondPath = path.join(directory, "second.torrent");
  await fs.writeFile(packagePath, Buffer.alloc(300000, 42));
  const first = await generateTorrent(packagePath, firstPath);
  const second = await generateTorrent(packagePath, secondPath);
  assert.equal(first.infoHash, second.infoHash);
  assert.deepEqual(await fs.readFile(firstPath), await fs.readFile(secondPath));
  assert.equal(await validateTorrent(firstPath, packagePath), first.infoHash);
  assert.equal(first.trackers.length, 2);
});

test("rejects private torrents because they disable DHT", async (context) => {
  const bencode = (await import("bencode")).default;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kmp-private-torrent-"));
  context.after(() => fs.rm(directory, {recursive: true, force: true}));
  const packagePath = path.join(directory, "example.zip");
  const torrentPath = path.join(directory, "example.torrent");
  await fs.writeFile(packagePath, Buffer.alloc(1024, 7));
  await generateTorrent(packagePath, torrentPath);
  const document = bencode.decode(await fs.readFile(torrentPath));
  document.info.private = 1;
  await fs.writeFile(torrentPath, bencode.encode(document));
  await assert.rejects(validateTorrent(torrentPath, packagePath), /não pode ser privado/);
});
