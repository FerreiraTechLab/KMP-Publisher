const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {generateTorrent, pieceLengthFor, webSeeds, MAX_WEB_SEED_PACKAGE} = require("../src/core/torrent-builder");
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
  assert.ok(first.trackers.length >= 4);
  assert.ok(first.trackers.some((tracker) => tracker.startsWith("https://")));
  assert.equal(first.webSeeds.length, 2);
});

test("only advertises GitHub web seeds for packages that can be hosted there", () => {
  assert.equal(webSeeds("small.zip", MAX_WEB_SEED_PACKAGE).length, 2);
  assert.deepEqual(webSeeds("large.zip", MAX_WEB_SEED_PACKAGE + 1), []);
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

test("keeps every torrent within the 64 KiB catalog limit", async (context) => {
  assert.equal(pieceLengthFor(46 * 1024 * 1024), 256 * 1024, "pacotes pequenos mantêm o infohash de antes");
  assert.equal(pieceLengthFor(497 * 1024 * 1024), 256 * 1024);
  assert.equal(pieceLengthFor(1388761094), 1024 * 1024);
  assert.equal(pieceLengthFor(8 * 1024 * 1024 * 1024), 4 * 1024 * 1024);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kmp-large-torrent-"));
  context.after(() => fs.rm(directory, {recursive: true, force: true}));
  const packagePath = path.join(directory, "large.zip");
  await fs.writeFile(packagePath, Buffer.alloc(1));
  await fs.truncate(packagePath, 1388761094);
  const result = await generateTorrent(packagePath, path.join(directory, "large.torrent"));
  assert.ok(result.sizeBytes <= 64 * 1024, `torrent com ${result.sizeBytes} bytes`);
  await validateTorrent(result.torrentPath, packagePath);
});
