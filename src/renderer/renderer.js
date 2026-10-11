let inspected = null;
const form = document.querySelector("#publisher-form");
const messages = document.querySelector("#messages");

async function refreshSeeds() {
  const seeds = await window.publisher.listSeeds();
  const active = seeds.filter((seed) => seed.running).length;
  const waiting = seeds.filter((seed) => seed.status === "awaiting-publication").length;
  document.querySelector("#seed-status").textContent = active ? `${active} semeando` :
    waiting ? `${waiting} aguardando publicação` : seeds.length ? `${seeds.length} parado(s)` :
    "Nenhuma proposta registrada";
  const list = document.querySelector("#seed-list");
  list.replaceChildren(...seeds.map((seed) => {
    const row = document.createElement("div"); row.className = "seed-row";
    const label = document.createElement("span"); label.textContent = `${seed.portId} ${seed.version} · ${seed.status}`;
    const action = document.createElement("button"); action.type = "button"; action.className = "secondary";
    if (!seed.torrentPath) { action.textContent = "Adicionar torrent oficial"; action.onclick = async () => { const result = await window.publisher.attachTorrent(seed.id); if (result?.error) showMessage("error", result.error); await refreshSeeds(); }; }
    else if (seed.running) { action.textContent = "Parar seed"; action.onclick = async () => { await window.publisher.stopSeed(seed.id); await refreshSeeds(); }; }
    else { action.textContent = "Começar seed"; action.onclick = async () => { const result = await window.publisher.startSeed(seed.id); if (!result.ok) showMessage("error", result.error); await refreshSeeds(); }; }
    row.append(label, action); return row;
  }));
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
  else { showMessage("success", `Proposta exportada em:\n${result.output}`); await refreshSeeds(); }
});

refreshSeeds();
