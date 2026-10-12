let inspected = null;
let selectedSeedId = null;
let seedDetailsRefreshing = false;
const form = document.querySelector("#publisher-form");
const messages = document.querySelector("#messages");
const seedModal = document.querySelector("#seed-modal");
const STATUS_LABELS = {"awaiting-publication": "aguardando publicação", ready: "pronto",
  checking: "verificando", seeding: "semeando", stopped: "parado", error: "erro"};

function formatBytes(value, suffix = "") {
  const number = Number(value);
  if (!Number.isFinite(number)) return "indisponível";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = number; let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount.toFixed(unit ? 1 : 0)} ${units[unit]}${suffix}`;
}

function detailItem(label, value) {
  const item = document.createElement("div"); item.className = "detail-item";
  const title = document.createElement("strong"); title.textContent = label;
  const content = document.createElement("span"); content.textContent = value;
  item.append(title, content); return item;
}

async function showSeedDetails(id, open = true) {
  if (seedDetailsRefreshing) return;
  seedDetailsRefreshing = true;
  let result;
  try { result = await window.publisher.seedDetails(id); }
  finally { seedDetailsRefreshing = false; }
  if (!result.ok) return showMessage("error", result.error);
  const seed = result.seed; selectedSeedId = id;
  document.querySelector("#seed-modal-title").textContent = `${seed.portId} ${seed.version}`;
  const state = seed.running ? "Semeando agora" : (STATUS_LABELS[seed.status] || seed.status);
  document.querySelector("#seed-modal-status").textContent =
    `${state} · ${seed.publicationStatus === "published" ? "publicado no catálogo" : "aguardando publicação"}`;
  const transfer = seed.transfer || {};
  const elapsed = seed.startedAt ? Math.max(0, Date.now() - Date.parse(seed.startedAt)) : null;
  const details = [
    ["Enviado", formatBytes(transfer.uploadLength)],
    ["Velocidade", formatBytes(transfer.uploadSpeed, "/s")],
    ["Conexões", transfer.connections ?? "indisponível"],
    ["Tempo ativo", elapsed === null ? "—" : `${Math.floor(elapsed / 3600000)}h ${Math.floor(elapsed % 3600000 / 60000)}min`],
    ["Limite de upload", seed.uploadLimit || "sem limite"],
    ["Processo", seed.pid ? `PID ${seed.pid}` : "inativo"],
    ["Tamanho do pacote", formatBytes(seed.packageSizeBytes)],
    ["Backend", seed.backendAvailable ? "aria2 disponível" : "indisponível"],
    ["Estado do torrent", transfer.status || (seed.running ? "iniciando" : "parado")]
  ];
  document.querySelector("#seed-modal-details").replaceChildren(...details.map(([label, value]) => detailItem(label, String(value))));
  document.querySelector("#seed-package-path").textContent = seed.packagePath || "—";
  document.querySelector("#seed-torrent-path").textContent = seed.torrentPath || "—";
  document.querySelector("#seed-info-hash").textContent = seed.infoHash || "—";
  const toggle = document.querySelector("#toggle-seed");
  toggle.textContent = seed.running ? "Parar semeação" : "Retomar semeação";
  toggle.dataset.running = seed.running ? "true" : "false";
  document.querySelector("#export-seed-torrent").disabled = !seed.torrentPath;
  if (open && !seedModal.open) seedModal.showModal();
}

async function refreshSeeds() {
  const seeds = await window.publisher.listSeeds();
  const active = seeds.filter((seed) => seed.running).length;
  const waiting = seeds.filter((seed) => seed.publicationStatus !== "published").length;
  document.querySelector("#seed-status").textContent = active ? `${active} semeando` :
    waiting ? `${waiting} aguardando publicação` : seeds.length ? `${seeds.length} parado(s)` :
    "Nenhuma proposta registrada";
  const list = document.querySelector("#seed-list");
  list.replaceChildren(...seeds.map((seed) => {
    const row = document.createElement("div"); row.className = "seed-row";
    const publication = seed.publicationStatus === "published" ? "publicado" : "aguardando publicação";
    const distribution = seed.running ? "semeando" : (STATUS_LABELS[seed.status] || seed.status);
    const label = document.createElement("span"); label.textContent = `${seed.portId} ${seed.version} · ${distribution} · ${publication}`;
    const actions = document.createElement("div"); actions.className = "seed-actions";
    const publish = document.createElement("button"); publish.type = "button"; publish.className = "primary";
    if (seed.pullRequest?.pullUrl) {
      publish.textContent = `Abrir revisão #${seed.pullRequest.pullNumber}`;
      publish.onclick = () => window.publisher.openExternal(seed.pullRequest.pullUrl);
    } else {
      publish.textContent = "Enviar para revisão";
      publish.onclick = async () => {
        publish.disabled = true; publish.textContent = "Enviando…";
        const result = await window.publisher.publishProposal(seed.id);
        if (!result.ok) showMessage("error", result.error);
        else showMessage("success", `Proposta enviada para revisão:\n${result.pullUrl}`);
        await refreshSeeds();
      };
    }
    const action = document.createElement("button"); action.type = "button"; action.className = "secondary";
    action.textContent = "Detalhes"; action.onclick = () => showSeedDetails(seed.id);
    actions.append(publish, action); row.append(label, actions); return row;
  }));
}

async function refreshGitHub() {
  const status = await window.publisher.githubStatus();
  document.querySelector("#github-status").textContent = status.connected ?
    `Conectado como @${status.login}. Agora envie uma proposta para revisão.` : "Conta não conectada";
  document.querySelector("#github-login").classList.toggle("hidden", status.connected);
}

function formValue() {
  const values = Object.fromEntries(new FormData(form).entries());
  values.redistributionAllowed = form.elements.redistributionAllowed.checked;
  values.readyToRun = form.elements.readyToRun.checked;
  return values;
}

function showMessage(kind, lines) {
  messages.className = `messages ${kind}`;
  messages.textContent = Array.isArray(lines) ? lines.join("\n") : lines;
}

document.querySelector("#choose-package").addEventListener("click", async () => {
  const result = await window.publisher.choosePackage();
  if (!result) return;
  if (!result.ok) return showMessage("error", result.error);
  inspected = result.package;
  document.querySelector("#package-summary").textContent = `${inspected.fileName} · ${(inspected.sizeBytes / 1048576).toFixed(1)} MiB`;
  const details = document.querySelector("#package-details");
  details.classList.remove("hidden");
  details.innerHTML = `<div class="metric"><strong>SHA-256</strong>${inspected.sha256.slice(0, 20)}…</div><div class="metric"><strong>Estrutura</strong>${inspected.entryCount} arquivos · ${inspected.roots.length} raízes</div><div class="metric"><strong>Launchers</strong>${inspected.launchers.length || "nenhum"}</div>`;
  if (!form.elements.installPaths.value) form.elements.installPaths.value = inspected.roots.map((root) => inspected.entries.includes(`${root}/`) ? `${root}/` : root).join(", ");
  if (inspected.warnings.length) showMessage("warning", inspected.warnings);
  else messages.className = "messages hidden";
});

document.querySelector("#validate").addEventListener("click", async () => {
  const result = await window.publisher.validate(formValue(), inspected);
  if (result.errors.length) showMessage("error", result.errors.map((item) => `• ${item}`));
  else showMessage("success", ["Proposta válida.", "O pacote e os metadados estão prontos para exportação."]);
});

document.querySelector("#export").addEventListener("click", async () => {
  const result = await window.publisher.exportProposal(formValue(), inspected);
  if (result.canceled) return;
  if (result.errors.length) showMessage("error", result.errors.map((item) => `• ${item}`));
  else {
    const seed = result.seedStarted ? "Seed iniciado." : `Torrent gerado; seed pendente: ${result.seedWarning}`;
    showMessage(result.seedStarted ? "success" : "warning",
      `Proposta exportada. ${seed}\nInfohash: ${result.infoHash}\n${result.output}`);
    await refreshSeeds();
  }
});

refreshSeeds();
refreshGitHub();
setInterval(refreshSeeds, 10000);
setInterval(() => {
  if (seedModal.open && selectedSeedId) showSeedDetails(selectedSeedId, false);
}, 1000);
document.querySelector("#connect-github").addEventListener("click", async () => {
  const input = document.querySelector("#github-token");
  const result = await window.publisher.connectGitHub(input.value);
  input.value = "";
  if (!result.ok) showMessage("error", result.error);
  else {
    const persistence = result.persisted ? "A credencial foi armazenada pelo cofre do sistema." :
      "O cofre do sistema não está disponível; a credencial será esquecida ao fechar o aplicativo.";
    showMessage(result.persisted ? "success" : "warning", `GitHub conectado como @${result.login}. ${persistence}`);
    await refreshGitHub();
  }
});
document.querySelector("#sync-seeds").addEventListener("click", async () => {
  const result = await window.publisher.syncSeeds();
  if (!result.ok) showMessage("error", result.error);
  else showMessage(result.activated ? "success" : "warning",
    result.activated ? `${result.activated} publicação(ões) confirmada(s).` :
      `Catálogo ${result.sequence} verificado. A proposta continua aguardando publicação; o seed local permanece ativo.`);
  await refreshSeeds();
});
document.querySelector("#close-seed-modal").addEventListener("click", () => seedModal.close());
document.querySelector("#toggle-seed").addEventListener("click", async (event) => {
  if (!selectedSeedId) return;
  event.currentTarget.disabled = true;
  const result = event.currentTarget.dataset.running === "true" ?
    await window.publisher.stopSeed(selectedSeedId) : await window.publisher.startSeed(selectedSeedId);
  if (!result.ok) showMessage("error", result.error);
  await refreshSeeds(); await showSeedDetails(selectedSeedId, false);
  event.currentTarget.disabled = false;
});
document.querySelector("#export-seed-torrent").addEventListener("click", async () => {
  if (!selectedSeedId) return;
  const result = await window.publisher.exportTorrent(selectedSeedId);
  if (result.canceled) return;
  if (!result.ok) showMessage("error", result.error);
  else showMessage("success", `Torrent exportado para:\n${result.filePath}`);
});
