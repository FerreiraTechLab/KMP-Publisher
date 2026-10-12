const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {spawn} = require("node:child_process");

const UPSTREAM = "FerreiraTechLab/KMP-catalog";
const MAX_GITHUB_FILE = 95 * 1024 * 1024;

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
  }

  async request(route, options = {}) {
    const response = await this.fetch(`https://api.github.com${route}`, {
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

  async step(label, operation) {
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

  async synchronizeFork(login, repository, baseBranch) {
    return this.request(`/repos/${login}/${repository}/merge-upstream`, {method: "POST",
      body: JSON.stringify({branch: baseBranch})});
  }

  async validateFileSize(filePath) {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_GITHUB_FILE)
      throw new Error(`${path.basename(filePath)} excede o limite de arquivo do GitHub (95 MiB).`);
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
    await this.step("Sincronização do fork", () => this.synchronizeFork(user.login, repository, baseBranch));
    const prefix = `submissions/${safeSegment(record.portId)}/${safeSegment(record.version)}`;
    const files = [
      [submissionPath, `${prefix}/submission.json`],
      [record.packagePath, `${prefix}/packages/${path.basename(record.packagePath)}`],
      [torrentPath, `${prefix}/torrents/${path.basename(torrentPath)}`]
    ];
    await this.step("Validação do tamanho dos arquivos", () =>
      Promise.all(files.map(([source]) => this.validateFileSize(source))));
    const branch = `publisher/${safeSegment(record.portId)}-${safeSegment(record.version)}-${Date.now()}`;
    await this.step("Envio da branch", () => this.pushBranch(user.login, repository, baseBranch, branch, files));
    const pull = await this.step("Abertura do pull request", () => this.request(`/repos/${owner}/${repository}/pulls`, {method: "POST",
      body: JSON.stringify({title: `Publicar ${submission.project.name} ${record.version}`,
        head: `${user.login}:${branch}`, base: baseBranch,
        body: `Proposta criada pelo KMP Publisher.\n\n- Port: \`${record.portId}\`\n- Versão: \`${record.version}\`\n- SHA-256: \`${record.sha256}\`\n- Infohash: \`${record.infoHash}\``})}));
    return {login: user.login, pullNumber: pull.number, pullUrl: pull.html_url};
  }
}

module.exports = {GitHubPublisher, safeSegment, runGit, UPSTREAM};
