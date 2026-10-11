let inspected = null;
const form = document.querySelector("#publisher-form");
const messages = document.querySelector("#messages");

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
  else showMessage("success", `Proposta exportada em:\n${result.output}`);
});
