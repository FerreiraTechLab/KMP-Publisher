let inspected = null;
const form = document.querySelector("#publisher-form");
const messages = document.querySelector("#messages");
const STATUS_LABELS = {"awaiting-publication": "aguardando publicação", ready: "pronto",
  checking: "verificando", seeding: "semeando", stopped: "parado", error: "erro"};

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
    if (seed.running) { action.textContent = "Parar seed"; action.onclick = async () => { await window.publisher.stopSeed(seed.id); await refreshSeeds(); }; }
    else { action.textContent = "Começar seed"; action.onclick = async () => { const result = await window.publisher.startSeed(seed.id); if (!result.ok) showMessage("error", result.error); await refreshSeeds(); }; }
    actions.append(publish, action); row.append(label, actions); return row;
  }));
}

async function refreshGitHub() {
  const status = await window.publisher.githubStatus();
  document.querySelector("#github-status").textContent = status.connected ?
    `Conectado como @${status.login}` : "Conta não conectada";
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
