const path = require("node:path");

const SAFE_ID = /^[a-z0-9][a-z0-9_-]*$/;
const HTTPS = /^https:\/\/[^\s]+$/;

function splitList(value) {
  return [...new Set(String(value || "").split(",").map((part) => part.trim()).filter(Boolean))];
}

function validateInput(input, inspected) {
  const errors = [];
  for (const field of ["id", "name", "description", "version", "license", "porterName"])
    if (!String(input[field] || "").trim()) errors.push(`Campo obrigatório: ${field}`);
  if (!SAFE_ID.test(input.id || "")) errors.push("O ID deve usar letras minúsculas, números, _ ou -.");
  for (const field of ["homepage", "source", "porterUrl", "licenseEvidence"])
    if (!HTTPS.test(input[field] || "")) errors.push(`${field} deve ser uma URL HTTPS.`);
  if (!input.redistributionAllowed) errors.push("É necessário confirmar a permissão de redistribuição.");
  if (!inspected || !inspected.sha256) errors.push("Selecione e inspecione o ZIP.");
  const installPaths = splitList(input.installPaths);
  if (installPaths.length === 0) errors.push("Informe ao menos um caminho de instalação.");
  const roots = new Set(installPaths.map((item) => item.replace(/\/$/, "").split("/", 1)[0]));
  for (const userPath of splitList(input.userDataPaths)) {
    if (!roots.has(userPath.replace(/\/$/, "").split("/", 1)[0]))
      errors.push(`O dado do usuário está fora das raízes instaladas: ${userPath}`);
  }
  return errors;
}

function createSubmission(input, inspected, now = new Date()) {
  const errors = validateInput(input, inspected);
  if (errors.length) return {errors};
  const renderers = splitList(input.renderers);
  const runtimes = splitList(input.runtimes);
  const architectures = splitList(input.architectures);
  const firmwares = splitList(input.firmwares);
  const checks = ["hash"];
  if (inspected.roots.length) checks.push("zip-layout");
  if (inspected.launchers.length) checks.push("launcher");
  checks.push("license");
  return {errors: [], submission: {
    schemaVersion: 1,
    project: {
      id: input.id, name: input.name, description: input.description,
      homepage: input.homepage, source: input.source, license: input.license,
      porter: {name: input.porterName, url: input.porterUrl},
      redistribution: {allowed: true, evidence: input.licenseEvidence,
        ...(input.redistributionNotes ? {notes: input.redistributionNotes} : {})}
    },
    submitter: {name: input.porterName, url: input.porterUrl},
    release: {
      version: input.version, revision: Number(input.revision || 1),
      channel: input.channel || "stable", publishedAt: now.toISOString(),
      notes: input.releaseNotes || "",
      variants: [{
        id: input.variantId || "aarch64-portmaster", priority: 100,
        requiredCapabilities: [],
        compatibility: {architectures, ...(firmwares.length ? {firmwares: {include: firmwares}} : {})},
        requirements: {readyToRun: Boolean(input.readyToRun),
          ...(Number(input.minimumRamMB) ? {minimumRamMB: Number(input.minimumRamMB)} : {}),
          analogSticks: Number(input.analogSticks || 0), renderers, runtimes},
        package: {path: `packages/${path.basename(inspected.fileName)}`,
          sizeBytes: inspected.sizeBytes, sha256: inspected.sha256},
        install: {portId: input.id, paths: splitList(input.installPaths),
          userDataPaths: splitList(input.userDataPaths)}, checks
      }]
    }
  }};
}

module.exports = {createSubmission, splitList, validateInput};
