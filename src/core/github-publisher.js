const fs = require("node:fs/promises");
const path = require("node:path");

const UPSTREAM = "FerreiraTechLab/KMP-catalog";
const MAX_GITHUB_FILE = 95 * 1024 * 1024;

function safeSegment(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

class GitHubPublisher {
  constructor(token, options = {}) {
    this.token = token;
    this.fetch = options.fetch || globalThis.fetch;
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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

  async ensureFork(login, repository) {
    try { return await this.request(`/repos/${login}/${repository}`); }
    catch (error) { if (error.status !== 404) throw error; }
    await this.request(`/repos/${this.upstream}/forks`, {method: "POST", body: JSON.stringify({default_branch_only: true})});
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await this.sleep(2000);
      try { return await this.request(`/repos/${login}/${repository}`); }
      catch (error) { if (error.status !== 404) throw error; }
    }
    throw new Error("O fork ainda está sendo criado pelo GitHub. Tente novamente em alguns segundos.");
  }

  async createBlob(owner, repository, filePath) {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_GITHUB_FILE)
      throw new Error(`${path.basename(filePath)} excede o limite de arquivo do GitHub (95 MiB).`);
    const content = (await fs.readFile(filePath)).toString("base64");
    return this.request(`/repos/${owner}/${repository}/git/blobs`, {method: "POST",
      body: JSON.stringify({content, encoding: "base64"})});
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
    const user = await this.identity();
    const upstream = await this.request(`/repos/${owner}/${repository}`);
    const baseBranch = upstream.default_branch;
    const baseRef = await this.request(`/repos/${owner}/${repository}/git/ref/heads/${baseBranch}`);
    const baseCommit = await this.request(`/repos/${owner}/${repository}/git/commits/${baseRef.object.sha}`);
    await this.ensureFork(user.login, repository);

    const prefix = `submissions/${safeSegment(record.portId)}/${safeSegment(record.version)}`;
    const files = [
      [submissionPath, `${prefix}/submission.json`],
      [record.packagePath, `${prefix}/packages/${path.basename(record.packagePath)}`],
      [torrentPath, `${prefix}/torrents/${path.basename(torrentPath)}`]
    ];
    const blobs = await Promise.all(files.map(([source]) => this.createBlob(user.login, repository, source)));
    const tree = await this.request(`/repos/${user.login}/${repository}/git/trees`, {method: "POST",
      body: JSON.stringify({base_tree: baseCommit.tree.sha, tree: files.map(([, target], index) =>
        ({path: target, mode: "100644", type: "blob", sha: blobs[index].sha}))})});
    const commit = await this.request(`/repos/${user.login}/${repository}/git/commits`, {method: "POST",
      body: JSON.stringify({message: `Submit ${record.portId} ${record.version}`, tree: tree.sha,
        parents: [baseRef.object.sha]})});
    const branch = `publisher/${safeSegment(record.portId)}-${safeSegment(record.version)}-${Date.now()}`;
    await this.request(`/repos/${user.login}/${repository}/git/refs`, {method: "POST",
      body: JSON.stringify({ref: `refs/heads/${branch}`, sha: commit.sha})});
    const pull = await this.request(`/repos/${owner}/${repository}/pulls`, {method: "POST",
      body: JSON.stringify({title: `Publicar ${submission.project.name} ${record.version}`,
        head: `${user.login}:${branch}`, base: baseBranch,
        body: `Proposta criada pelo KMP Publisher.\n\n- Port: \`${record.portId}\`\n- Versão: \`${record.version}\`\n- SHA-256: \`${record.sha256}\`\n- Infohash: \`${record.infoHash}\``})});
    return {login: user.login, pullNumber: pull.number, pullUrl: pull.html_url};
  }
}

module.exports = {GitHubPublisher, safeSegment, UPSTREAM};
