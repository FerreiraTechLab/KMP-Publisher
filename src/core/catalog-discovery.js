const crypto = require("node:crypto");
const fs = require("node:fs/promises");

const MAX_HEAD = 64 * 1024;
const MAX_CATALOG = 8 * 1024 * 1024;

async function fetchBytes(url, limit, fetchImpl = fetch) {
  const response = await fetchImpl(url, {signal: AbortSignal.timeout(15000), cache: "no-store"});
  if (!response.ok) throw new Error(`Catálogo respondeu HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > limit) throw new Error("Resposta do catálogo possui tamanho inválido.");
  return bytes;
}

function verifyEd25519(data, signature, publicKey) {
  if (!crypto.verify(null, data, publicKey, signature)) throw new Error("Assinatura do catálogo inválida.");
}

async function loadSignedCatalog({baseUrl, publicKeyPath, fetchImpl = fetch}) {
  const root = baseUrl.replace(/\/$/, "");
  const publicKey = await fs.readFile(publicKeyPath);
  const [headBytes, headSignature] = await Promise.all([
    fetchBytes(`${root}/head.json`, MAX_HEAD, fetchImpl),
    fetchBytes(`${root}/head.json.sig`, 1024, fetchImpl)
  ]);
  verifyEd25519(headBytes, headSignature, publicKey);
  const head = JSON.parse(headBytes.toString("utf8"));
  if (head.schemaVersion !== 1 || !Number.isSafeInteger(head.sequence) || head.sequence < 1)
    throw new Error("Head do catálogo possui formato inválido.");
  if (Date.parse(head.expiresAt) <= Date.now()) throw new Error("Head do catálogo expirou.");
  const name = `catalog-${String(head.sequence).padStart(8, "0")}.json`;
  const catalogBytes = await fetchBytes(`${root}/snapshots/${name}`, MAX_CATALOG, fetchImpl);
  if (catalogBytes.length !== head.catalogSize ||
      crypto.createHash("sha256").update(catalogBytes).digest("hex") !== head.catalogSha256)
    throw new Error("Hash do catálogo não confere.");
  verifyEd25519(catalogBytes, Buffer.from(head.catalogSignature, "base64"), publicKey);
  const catalog = JSON.parse(catalogBytes.toString("utf8"));
  if (catalog.sequence !== head.sequence || ![2, 3].includes(catalog.schemaVersion))
    throw new Error("Snapshot do catálogo possui formato inválido.");
  return catalog;
}

function findPublishedPackage(catalog, record) {
  const item = catalog.items.find((candidate) => candidate.id === record.portId);
  if (!item) return null;
  if (catalog.schemaVersion === 3) {
    if (item.release?.version !== record.version) return null;
    const variant = item.release.variants.find((candidate) => candidate.download?.sha256 === record.sha256);
    if (!variant) return null;
    return variant.download;
  }
  return item.version === record.version && item.packageSha256 === record.sha256 ? item : null;
}

module.exports = {findPublishedPackage, loadSignedCatalog, verifyEd25519};
