const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {SeedManager, ensureTorrentTrackers, ipv6Prefix64, isPrivateAddress} = require("../src/core/seed-manager");
const {PortMapper} = require("../src/core/port-mapper");

test("normalizes the IPv6 /64 prefix", () => {
  assert.equal(ipv6Prefix64("2804:14d:72a4:8834::198a"), "2804:014d:72a4:8834");
  assert.equal(ipv6Prefix64("2001:db8::1"), "2001:0db8:0000:0000");
  assert.equal(ipv6Prefix64("186.207.175.252"), null);
});

test("only confirms inbound reachability from peers outside the local link", async () => {
  const portMapper = new PortMapper(6882, {factories: [async () => ({method: "upnp",
    externalAddress: "186.207.175.252", renew: async () => {}, close: async () => {}})]});
  await portMapper.start();
  const manager = new SeedManager(os.tmpdir(), {aria2: "/fake/aria2c", portMapper,
    networkInterfaces: () => ({wlan0: [{family: "IPv6", address: "2804:14d:72a4:8834:323e:6f74:1d40:a71e"}]})});
  manager.observeInbound([
    {ip: "186.207.175.252", source: "I"},
    {ip: "2804:14d:72a4:8834::198a", source: "I"},
    {ip: "203.0.113.7", source: "Tr"}]);
  assert.equal(portMapper.details().inboundConfirmedAt, null);
  manager.observeInbound([{ip: "203.0.113.7", source: "I"}]);
  assert.ok(portMapper.details().inboundConfirmedAt);
  await portMapper.stop();
});

test("adds fallback trackers without changing the infohash", async (context) => {
  const bencode = (await import("bencode")).default;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kmp-publisher-trackers-"));
  context.after(() => fs.rm(directory, {recursive: true, force: true}));
  const torrentPath = path.join(directory, "legacy.torrent");
  const info = {length: 7, name: "port.zip", "piece length": 16, pieces: Buffer.alloc(20)};
  await fs.writeFile(torrentPath, bencode.encode({announce: "udp://one.example/announce",
    "announce-list": [["udp://one.example/announce"], ["udp://two.example/announce"]], info}));
  const first = await ensureTorrentTrackers(torrentPath);
  const second = await ensureTorrentTrackers(torrentPath);
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(first.infoHash, second.infoHash);
  const updated = bencode.decode(await fs.readFile(torrentPath));
  assert.ok(updated["announce-list"].length > 2);
});

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

test("limits how many community ports are added", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kmp-publisher-community-"));
  context.after(() => fs.rm(directory, {recursive: true, force: true}));
  const manager = new SeedManager(directory, {aria2: "/fake/aria2c", uploadLimit: "2M"});
  await manager.load();
  manager.ensureDaemon = async () => {};
  const additions = [];
  manager.rpc = async (method, params) => {
    if (method === "aria2.addTorrent") additions.push(params);
    return [];
  };
  const downloads = [1, 2, 3].map((number) => ({torrent: `torrent-${number}`,
    infoHash: String(number).repeat(40), sizeBytes: number * 1024}));
  const result = await manager.mirrorCatalog({schemaVersion: 2, items: downloads}, 1024 * 1024, 2);
  assert.equal(result.managed, 2);
  assert.equal(additions.length, 2);
  assert.equal(additions[0][2]["max-upload-limit"], "2M");
});

test("connects every active torrent to the catalog seed nodes", async () => {
  const manager = new SeedManager(os.tmpdir(), {torrentd: "/fake/kmp-torrentd"});
  const calls = [];
  manager.daemon = {};
  manager.rpc = async (method, params) => {
    calls.push([method, params]);
    if (method === "aria2.tellActive") return [{gid: "a1"}, {gid: "b2"}];
    return 1;
  };
  const connected = await manager.connectSeedNodes(["163.176.18.211:6881", "inválido", 7]);
  assert.equal(connected, 2);
  assert.deepEqual(calls.filter(([method]) => method === "kmp.addPeers"),
    [["kmp.addPeers", ["a1", ["163.176.18.211:6881"]]], ["kmp.addPeers", ["b2", ["163.176.18.211:6881"]]]]);
  calls.length = 0;
  assert.equal(await manager.connectSeedNodes(), 2, "a lista anterior é reutilizada ao iniciar um seed");
});
