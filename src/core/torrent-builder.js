const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const PIECE_LENGTH = 256 * 1024;
const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce"
];

function webSeeds(fileName) {
  const encoded = encodeURIComponent(fileName);
  return [
    `https://ferreiratechlab.github.io/KMP-catalog/packages/${encoded}`,
    `https://raw.githubusercontent.com/FerreiraTechLab/KMP-catalog/main/docs/packages/${encoded}`
  ];
}

async function generateTorrent(packagePath, torrentPath) {
  const bencode = (await import("bencode")).default;
  const stat = await fsp.stat(packagePath);
  if (!stat.size) throw new Error("Não é possível gerar torrent de um pacote vazio.");
  const pieces = [];
  let pending = Buffer.alloc(0);
  for await (const chunk of fs.createReadStream(packagePath)) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= PIECE_LENGTH) {
      pieces.push(crypto.createHash("sha1").update(pending.subarray(0, PIECE_LENGTH)).digest());
      pending = pending.subarray(PIECE_LENGTH);
    }
  }
  if (pending.length) pieces.push(crypto.createHash("sha1").update(pending).digest());
  const info = {length: stat.size, name: path.basename(packagePath),
    "piece length": PIECE_LENGTH, pieces: Buffer.concat(pieces)};
  const document = {announce: TRACKERS[0], "announce-list": TRACKERS.map((tracker) => [tracker]),
    info, "url-list": webSeeds(info.name)};
  const encoded = Buffer.from(bencode.encode(document));
  await fsp.mkdir(path.dirname(torrentPath), {recursive: true});
  await fsp.writeFile(torrentPath, encoded);
  return {torrentPath, infoHash: crypto.createHash("sha1").update(bencode.encode(info)).digest("hex"),
    sizeBytes: encoded.length, trackers: TRACKERS, webSeeds: document["url-list"]};
}

module.exports = {generateTorrent, TRACKERS, webSeeds};
