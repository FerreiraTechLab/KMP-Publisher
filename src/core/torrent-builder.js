const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const PIECE_LENGTH = 256 * 1024;
// O catálogo assinado embute cada torrent e recusa os maiores que 64 KiB (clientes
// antigos rejeitariam o catálogo inteiro). Pacotes grandes usam peças maiores para
// ficar em até 2048 hashes (40 KiB); os pequenos mantêm 256 KiB e o mesmo infohash.
const MAX_PIECES = 2048;
const MAX_WEB_SEED_PACKAGE = 95 * 1024 * 1024;

function pieceLengthFor(sizeBytes) {
  let length = PIECE_LENGTH;
  while (Math.ceil(sizeBytes / length) > MAX_PIECES && length < 16 * 1024 * 1024) length *= 2;
  return length;
}
const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "http://tracker.opentrackr.org:1337/announce",
  "https://tracker.opentrackr.org:443/announce",
  "http://tracker.dler.org:6969/announce",
  "http://tracker.renfei.net:8080/announce",
  "https://tracker.bug38.com:443/announce"
];

function webSeeds(fileName, sizeBytes) {
  if (sizeBytes > MAX_WEB_SEED_PACKAGE) return [];
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
  const pieceLength = pieceLengthFor(stat.size);
  const pieces = [];
  let pending = Buffer.alloc(0);
  for await (const chunk of fs.createReadStream(packagePath)) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= pieceLength) {
      pieces.push(crypto.createHash("sha1").update(pending.subarray(0, pieceLength)).digest());
      pending = pending.subarray(pieceLength);
    }
  }
  if (pending.length) pieces.push(crypto.createHash("sha1").update(pending).digest());
  const info = {length: stat.size, name: path.basename(packagePath),
    "piece length": pieceLength, pieces: Buffer.concat(pieces)};
  const seeds = webSeeds(info.name, stat.size);
  const document = {announce: TRACKERS[0], "announce-list": TRACKERS.map((tracker) => [tracker]),
    info, ...(seeds.length ? {"url-list": seeds} : {})};
  const encoded = Buffer.from(bencode.encode(document));
  await fsp.mkdir(path.dirname(torrentPath), {recursive: true});
  await fsp.writeFile(torrentPath, encoded);
  return {torrentPath, infoHash: crypto.createHash("sha1").update(bencode.encode(info)).digest("hex"),
    sizeBytes: encoded.length, trackers: TRACKERS, webSeeds: seeds};
}

// url-list fica fora do bloco info: acrescentar webseeds não altera o infohash.
async function writeTorrentWithWebSeeds(torrentPath, outputPath, seeds) {
  const bencode = (await import("bencode")).default;
  const document = bencode.decode(await fsp.readFile(torrentPath));
  if (!document?.info) throw new Error("Torrent inválido: bloco info ausente.");
  const infoHash = () => crypto.createHash("sha1").update(bencode.encode(document.info)).digest("hex");
  const before = infoHash();
  const current = document["url-list"] === undefined ? [] :
    [].concat(document["url-list"]).map((value) => Buffer.from(value).toString("utf8"));
  document["url-list"] = [...new Set([...current, ...seeds])];
  const encoded = Buffer.from(bencode.encode(document));
  if (infoHash() !== before) throw new Error("A inclusão de webseeds alterou indevidamente o infohash.");
  await fsp.mkdir(path.dirname(outputPath), {recursive: true});
  await fsp.writeFile(outputPath, encoded);
  return {torrentPath: outputPath, infoHash: before, webSeeds: document["url-list"]};
}

module.exports = {generateTorrent, writeTorrentWithWebSeeds, pieceLengthFor, TRACKERS, webSeeds, MAX_WEB_SEED_PACKAGE};
