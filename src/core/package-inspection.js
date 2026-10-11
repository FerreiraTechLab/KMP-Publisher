const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const yauzl = require("yauzl");

const MAX_ENTRIES = 20000;
const MAX_UNPACKED = 4 * 1024 * 1024 * 1024;

function safeZipPath(name) {
  if (!name || name.startsWith("/") || name.includes("\\") || name.includes("\0")) return false;
  return !name.split("/").some((part) => part === "." || part === "..");
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const digest = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("end", () => resolve(digest.digest("hex")));
  });
}

function readEntries(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, {lazyEntries: true, validateEntrySizes: true}, (error, zip) => {
      if (error) return reject(error);
      const entries = [];
      let unpacked = 0;
      let settled = false;
      const fail = (reason) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(reason instanceof Error ? reason : new Error(reason));
      };
      zip.on("error", fail);
      zip.on("entry", (entry) => {
        if (!safeZipPath(entry.fileName)) return fail(`Caminho inseguro: ${entry.fileName}`);
        if (entry.generalPurposeBitFlag & 0x1) return fail(`Entrada criptografada: ${entry.fileName}`);
        unpacked += entry.uncompressedSize;
        entries.push(entry.fileName);
        if (entries.length > MAX_ENTRIES) return fail("O ZIP possui arquivos demais.");
        if (unpacked > MAX_UNPACKED) return fail("O conteúdo descompactado excede 4 GiB.");
        zip.readEntry();
      });
      zip.on("end", () => {
        if (!settled) {
          settled = true;
          resolve({entries, unpackedBytes: unpacked});
        }
      });
      zip.readEntry();
    });
  });
}

async function inspectPackage(filePath) {
  if (path.extname(filePath).toLowerCase() !== ".zip") throw new Error("Selecione um arquivo ZIP.");
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size === 0) throw new Error("O pacote está vazio ou indisponível.");
  const [{entries, unpackedBytes}, digest] = await Promise.all([readEntries(filePath), sha256(filePath)]);
  const roots = [...new Set(entries.map((name) => name.replace(/\/$/, "").split("/", 1)[0]).filter(Boolean))];
  const launchers = entries.filter((name) => !name.endsWith("/") && name.toLowerCase().endsWith(".sh"));
  const warnings = [];
  if (launchers.length === 0) warnings.push("Nenhum launcher .sh foi encontrado.");
  if (roots.length === 0) warnings.push("O ZIP não possui raízes instaláveis.");
  if (!entries.some((name) => /(^|\/)(license|copying)(\.|$)/i.test(name))) {
    warnings.push("Nenhum arquivo de licença foi detectado no pacote.");
  }
  return {filePath, fileName: path.basename(filePath), sizeBytes: stat.size,
    sha256: digest, entries, entryCount: entries.length, unpackedBytes, roots, launchers, warnings};
}

module.exports = {inspectPackage, safeZipPath};
