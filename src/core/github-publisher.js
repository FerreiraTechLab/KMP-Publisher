const fs = require("node:fs/promises");
const {createReadStream} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawn} = require("node:child_process");
const {writeTorrentWithWebSeeds} = require("./torrent-builder");

const UPSTREAM = "FerreiraTechLab/KMP-catalog";
const MAX_GITHUB_FILE = 95 * 1024 * 1024;
const MAX_RELEASE_ASSET = 2 * 1024 * 1024 * 1024 - 1;

function safeSegment(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function runGit(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {cwd: options.cwd, env: options.env,
      windowsHide: true, stdio: ["ignore", "ignore", "pipe"]});
    let errorOutput = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { errorOutput = (errorOutput + chunk).slice(-8000); });
    child.on("error", (error) => reject(error.code === "ENOENT" ?
      new Error("Git não está instalado. Instale o Git para enviar propostas maiores ao GitHub.") : error));
    child.on("close", (code) => code === 0 ? resolve() :
      reject(new Error(errorOutput.trim() || `git encerrou com código ${code}.`)));
  });
}

class GitHubPublisher {
  constructor(token, options = {}) {
    this.token = token;
    this.fetch = options.fetch || globalThis.fetch;
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.git = options.git || runGit;
    this.upstream = options.upstream || UPSTREAM;
    this.onProgress = options.onProgress || (() => {});
  }

  async request(route, options = {}) {
    const response = await this.fetch(route.startsWith("https://") ? route : `https://api.github.com${route}`, {
      ...options,
      headers: {Accept: "application/vnd.github+json", Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", ...options.headers}
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = new Error(body?.message || `GitHub respondeu HTTP ${response.status}.`);
      error.status = response.status; error.response = body; throw error;
    }
    return body;
  }

  async identity() { return this.request("/user"); }

  async reviewStatus(pullNumber) {
    const [owner, repository] = this.upstream.split("/");
    const pull = await this.request(`/repos/${owner}/${repository}/pulls/${pullNumber}`);
    if (pull.state === "closed" && !pull.merged_at) return {state: "closed", label: "Revisão encerrada",
      message: "O pull request foi fechado sem publicação.", url: pull.html_url};
    const checks = await this.request(`/repos/${owner}/${repository}/commits/${pull.head.sha}/check-runs`);
    const runs = checks.check_runs || [];
    const failed = runs.find((run) => ["failure", "cancelled", "timed_out", "action_required"].includes(run.conclusion));
    if (failed) return {state: "failure", label: `${pull.merged_at ? "Mesclado, mas a validação falhou" : "Validação falhou"} · ${failed.name}`,
      message: failed.output?.summary || failed.output?.title || "Abra os detalhes do check para consultar o erro.",
      url: failed.details_url || pull.html_url};
    if (pull.merged_at) return {state: "merged", label: "Revisão mesclada",
      message: "A proposta foi aceita. Aguarde a publicação do próximo catálogo assinado.", url: pull.html_url};
    if (runs.length && runs.every((run) => run.status === "completed" && ["success", "neutral", "skipped"].includes(run.conclusion)))
      return {state: "success", label: "Validação aprovada",
        message: "Todos os checks terminaram com sucesso. A proposta está pronta para revisão ou publicação.", url: pull.html_url};
    const active = runs.find((run) => run.status !== "completed");
    return {state: "pending", label: active ? `Validando · ${active.name}` : "Aguardando validação",
      message: "Mantenha o Publisher aberto e semeando enquanto o GitHub obtém e verifica o pacote.",
      url: active?.details_url || pull.html_url};
  }

  async step(label, operation) {
    this.onProgress({stage: label});
    try { return await operation(); }
    catch (error) {
      const wrapped = new Error(`${label}: ${error.message}`);
      wrapped.cause = error;
      wrapped.status = error.status;
      wrapped.response = error.response;
      throw wrapped;
    }
  }

  async ensureFork(login, repository) {
    let fork;
    try { return await this.request(`/repos/${login}/${repository}`); }
    catch (error) { if (error.status !== 404) throw error; }
    await this.request(`/repos/${this.upstream}/forks`, {method: "POST", body: JSON.stringify({default_branch_only: true})});
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await this.sleep(2000);
      try { fork = await this.request(`/repos/${login}/${repository}`); break; }
      catch (error) { if (error.status !== 404) throw error; }
    }
    if (!fork) throw new Error("O fork ainda está sendo criado pelo GitHub. Tente novamente em alguns segundos.");
    return fork;
  }

  // Semente HTTP extra para pacotes fora do Git. O pull request abre antes do upload, que
  // segue em segundo plano: em conexões domésticas lentas ele leva mais de uma hora e uma
  // única pausa da rede o derruba, enquanto o swarm e o nó público recebem as peças de
  // forma retomável. A URL do asset é previsível, então já entra no torrent do PR.
  async prepareSeedRelease(login, repository, baseBranch, record) {
    const name = path.basename(record.packagePath);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return {seedUrl: null, upload: null};
    const tag = `kmp-seed-${safeSegment(record.portId)}-${safeSegment(record.version)}-${record.sha256.slice(0, 12)}`;
    const size = (await fs.stat(record.packagePath)).size;
    let release;
    try { release = await this.request(`/repos/${login}/${repository}/releases/tags/${encodeURIComponent(tag)}`); }
    catch (error) { if (error.status !== 404) throw error; }
    if (!release) release = await this.request(`/repos/${login}/${repository}/releases`, {method: "POST",
      body: JSON.stringify({tag_name: tag, target_commitish: baseBranch, prerelease: true,
        name: `Semente ${record.portId} ${record.version}`,
        body: `Semente HTTP do KMP Publisher.\n\n- SHA-256: \`${record.sha256}\`\n- Infohash: \`${record.infoHash}\``})});
    for (const asset of release.assets || []) {
      if (asset.state === "uploaded" && asset.size === size) return {seedUrl: asset.browser_download_url, upload: null};
      await this.request(`/repos/${login}/${repository}/releases/assets/${asset.id}`, {method: "DELETE"});
    }
    const uploadUrl = `${release.upload_url.replace(/\{.*\}$/, "")}?name=${encodeURIComponent(name)}`;
    return {seedUrl: `https://github.com/${login}/${repository}/releases/download/${tag}/${name}`,
      upload: () => this.step("Envio do pacote ao Release do fork", async () => (await this.request(uploadUrl, {
        method: "POST", duplex: "half", headers: {"Content-Type": "application/zip", "Content-Length": String(size)},
        body: this.countedStream(record.packagePath, size)})).browser_download_url)};
  }

  // O upload de um pacote grande leva minutos; o Publisher precisa mostrar que ele avança.
  async *countedStream(filePath, total) {
    let sent = 0, reportedAt = 0;
    for await (const chunk of createReadStream(filePath)) {
      sent += chunk.length;
      if (Date.now() - reportedAt >= 500 || sent === total) {
        reportedAt = Date.now();
        this.onProgress({stage: "Envio do pacote ao Release do fork", sent, total});
      }
      yield chunk;
    }
  }

  async pushBranch(login, repository, baseBranch, branch, files) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kmp-publisher-git-"));
    const authorization = Buffer.from(`x-access-token:${this.token}`).toString("base64");
    const env = {...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}`};
    const execute = (...args) => this.git(args, {cwd: directory, env});
    try {
      await execute("init", "--quiet");
      await execute("remote", "add", "origin", `https://github.com/${login}/${repository}.git`);
      await execute("fetch", "--quiet", "--depth=1", "origin", baseBranch);
      await execute("checkout", "--quiet", "-b", branch, "FETCH_HEAD");
      for (const [source, target] of files) {
        const destination = path.join(directory, ...target.split("/"));
        await fs.mkdir(path.dirname(destination), {recursive: true});
        await fs.copyFile(source, destination);
      }
      await execute("add", "--", ...files.map(([, target]) => target));
      await execute("-c", "user.name=KMP Publisher", "-c", "user.email=publisher@ferreiratechlab.dev",
        "commit", "--quiet", "-m", `Submit ${path.basename(path.dirname(path.dirname(files[0][1])))} ${path.basename(path.dirname(files[0][1]))}`);
      await execute("push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
    } finally { await fs.rm(directory, {recursive: true, force: true}); }
  }

  async publish(record) {
    if (!this.token) throw new Error("Conecte uma conta GitHub antes de publicar.");
    const submissionPath = path.join(record.proposalPath || path.dirname(path.dirname(record.packagePath)), "submission.json");
    const torrentPath = record.torrentPath;
    await Promise.all([fs.access(submissionPath), fs.access(record.packagePath), fs.access(torrentPath)]);
    const submission = JSON.parse(await fs.readFile(submissionPath, "utf8"));
    if (submission.project.id !== record.portId || submission.release.version !== record.version)
      throw new Error("A proposta exportada não corresponde ao seed registrado.");

    const [owner, repository] = this.upstream.split("/");
    const user = await this.step("Identificação da conta", () => this.identity());
    const upstream = await this.step("Leitura do catálogo", () => this.request(`/repos/${owner}/${repository}`));
    const baseBranch = upstream.default_branch;
    await this.step("Preparação do fork", () => this.ensureFork(user.login, repository));
    const prefix = `submissions/${safeSegment(record.portId)}/${safeSegment(record.version)}`;
    const packageSize = (await fs.stat(record.packagePath)).size;
    const packageIsHosted = packageSize <= MAX_GITHUB_FILE;
    const {seedUrl, upload} = packageIsHosted || packageSize > MAX_RELEASE_ASSET ? {seedUrl: null, upload: null} :
      await this.step("Preparação do Release do fork", () => this.prepareSeedRelease(user.login, repository, baseBranch, record));
    const scratch = seedUrl ? await fs.mkdtemp(path.join(os.tmpdir(), "kmp-publisher-torrent-")) : null;
    try {
      const submittedTorrent = scratch ? (await writeTorrentWithWebSeeds(torrentPath,
        path.join(scratch, path.basename(torrentPath)), [seedUrl])).torrentPath : torrentPath;
      const files = [
        [submissionPath, `${prefix}/submission.json`],
        ...(packageIsHosted ? [[record.packagePath, `${prefix}/packages/${path.basename(record.packagePath)}`]] : []),
        [submittedTorrent, `${prefix}/torrents/${path.basename(torrentPath)}`]
      ];
      const branch = `publisher/${safeSegment(record.portId)}-${safeSegment(record.version)}-${Date.now()}`;
      await this.step("Envio da branch", () => this.pushBranch(user.login, repository, baseBranch, branch, files));
      const hosting = packageIsHosted ? "no repositório" :
        seedUrl ? `swarm e nó público, com cópia no Release do fork${upload ? " enviada em segundo plano" : ""} (${seedUrl})` :
        "swarm e nó público";
      const pull = await this.step("Abertura do pull request", () => this.request(`/repos/${owner}/${repository}/pulls`, {method: "POST",
        body: JSON.stringify({title: `Publicar ${submission.project.name} ${record.version}`,
          head: `${user.login}:${branch}`, base: baseBranch,
          body: `Proposta criada pelo KMP Publisher.\n\n- Port: \`${record.portId}\`\n- Versão: \`${record.version}\`\n- SHA-256: \`${record.sha256}\`\n- Infohash: \`${record.infoHash}\`\n- Pacote: ${hosting}\n\n> Mantenha o Publisher aberto e semeando para reforçar o swarm durante a validação.`})}));
      return {login: user.login, pullNumber: pull.number, pullUrl: pull.html_url, seedUrl, upload};
    } finally { if (scratch) await fs.rm(scratch, {recursive: true, force: true}); }
  }
}

module.exports = {GitHubPublisher, safeSegment, runGit, UPSTREAM, MAX_GITHUB_FILE, MAX_RELEASE_ASSET};
