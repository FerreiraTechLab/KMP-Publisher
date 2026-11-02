const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {GitHubPublisher, safeSegment} = require("../src/core/github-publisher");
const {generateTorrent} = require("../src/core/torrent-builder");

function response(status, body) {
  return {ok: status >= 200 && status < 300, status,
    text: async () => body === null ? "" : JSON.stringify(body)};
}

test("normalizes branch and proposal path segments", () => {
  assert.equal(safeSegment("Meu Port 1.0!"), "meu-port-1.0");
});

test("uploads proposal artifacts and opens a pull request", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kmp-github-"));
  context.after(() => fs.rm(directory, {recursive: true, force: true}));
  const packages = path.join(directory, "packages");
  const torrents = path.join(directory, "torrents");
  await fs.mkdir(packages); await fs.mkdir(torrents);
  await fs.writeFile(path.join(directory, "submission.json"), JSON.stringify({project: {id: "demo", name: "Demo"}, release: {version: "1.0"}}));
  await fs.writeFile(path.join(packages, "demo.zip"), "zip");
  await fs.writeFile(path.join(torrents, "demo.torrent"), "torrent");
  const calls = [];
  const gitCalls = [];
  const fetch = async (url, options = {}) => {
    const route = new URL(url).pathname; calls.push([route, options]);
    if (route === "/user") return response(200, {login: "developer"});
    if (route === "/repos/FerreiraTechLab/KMP-catalog") return response(200, {default_branch: "main"});
    if (route === "/repos/developer/KMP-catalog") return response(200, {fork: true});
    if (route === "/repos/developer/KMP-catalog/merge-upstream") return response(200, {message: "up to date"});
    if (route.endsWith("/pulls")) return response(201, {number: 12, html_url: "https://github.com/FerreiraTechLab/KMP-catalog/pull/12"});
    return response(404, {message: route});
  };
  const publisher = new GitHubPublisher("secret", {fetch,
    git: async (args, options) => { gitCalls.push([args, options]); }});
  const result = await publisher.publish({portId: "demo", version: "1.0", proposalPath: directory,
    packagePath: path.join(packages, "demo.zip"), torrentPath: path.join(torrents, "demo.torrent"),
    sha256: "a".repeat(64), infoHash: "b".repeat(40)});
  assert.equal(result.pullNumber, 12);
  assert.ok(calls.every(([route]) => !route.endsWith("/merge-upstream")));
  assert.ok(gitCalls.some(([args]) => args[0] === "push"));
  const fetchBase = gitCalls.find(([args]) => args[0] === "fetch")[0];
  assert.deepEqual(fetchBase.slice(-2), ["origin", "main"]);
  const add = gitCalls.find(([args]) => args[0] === "add")[0];
  assert.ok(add.some((value) => value.endsWith("/submission.json")));
  assert.ok(add.some((value) => value.endsWith("/demo.torrent")));
  assert.ok(add.some((value) => value.endsWith("/demo.zip")));
  assert.ok(gitCalls.every(([, options]) => !options.env.GIT_CONFIG_VALUE_0.includes("secret")));
});

async function largeProposal(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kmp-github-large-"));
  context.after(() => fs.rm(directory, {recursive: true, force: true}));
  await fs.mkdir(path.join(directory, "packages"));
  await fs.writeFile(path.join(directory, "submission.json"), JSON.stringify({project: {id: "large", name: "Large"}, release: {version: "1.0"}}));
  const packagePath = path.join(directory, "packages", "large.zip");
  await fs.writeFile(packagePath, Buffer.alloc(1));
  await fs.truncate(packagePath, 101 * 1024 * 1024);
  const torrent = await generateTorrent(packagePath, path.join(directory, "torrents", "large.torrent"));
  return {portId: "large", version: "1.0", proposalPath: directory, packagePath,
    torrentPath: torrent.torrentPath, sha256: "a".repeat(64), infoHash: torrent.infoHash};
}

const SEED_URL = "https://github.com/developer/KMP-catalog/releases/download/kmp-seed-large-1.0-aaaaaaaaaaaa/large.zip";

test("seeds a package larger than GitHub's file limit through a fork release", async (context) => {
  const record = await largeProposal(context);
  const calls = [];
  let pushedTorrent;
  const fetch = async (url, options = {}) => {
    const {hostname, pathname: route} = new URL(url); calls.push([hostname, route, options]);
    if (route === "/user") return response(200, {login: "developer"});
    if (route === "/repos/FerreiraTechLab/KMP-catalog") return response(200, {default_branch: "main"});
    if (route === "/repos/developer/KMP-catalog") return response(200, {fork: true});
    if (route.includes("/releases/tags/")) return response(404, {message: "Not Found"});
    if (route === "/repos/developer/KMP-catalog/releases") return response(201, {id: 5, assets: [],
      upload_url: "https://uploads.github.com/repos/developer/KMP-catalog/releases/5/assets{?name,label}"});
    if (hostname === "uploads.github.com") {
      for await (const chunk of options.body) uploaded += chunk.length;
      return response(201, {browser_download_url: SEED_URL});
    }
    if (route.endsWith("/pulls")) return response(201, {number: 13, html_url: "https://example.test/pull/13"});
    return response(404, {message: route});
  };
  let uploaded = 0;
  const progress = [];
  const gitCalls = [];
  const git = async (args, options) => {
    gitCalls.push(args);
    if (args[0] === "add") pushedTorrent = await fs.readFile(path.join(options.cwd, args.find((value) => value.endsWith(".torrent"))));
  };
  const result = await new GitHubPublisher("secret", {fetch, git,
    onProgress: (event) => progress.push(event)}).publish(record);
  assert.equal(result.pullNumber, 13);
  assert.equal(result.seedUrl, SEED_URL);
  assert.equal(uploaded, 0, "o pull request abre antes do upload ao Release");
  assert.equal(await result.upload(), SEED_URL);
  assert.equal(uploaded, 101 * 1024 * 1024);
  const stages = progress.map((event) => event.stage);
  assert.deepEqual([...new Set(stages)], ["Identificação da conta", "Leitura do catálogo", "Preparação do fork",
    "Preparação do Release do fork", "Envio da branch", "Abertura do pull request", "Envio do pacote ao Release do fork"]);
  const last = progress.filter((event) => event.sent !== undefined).at(-1);
  assert.deepEqual([last.sent, last.total], [101 * 1024 * 1024, 101 * 1024 * 1024]);
  assert.ok(gitCalls.find((args) => args[0] === "add").every((value) => !value.endsWith(".zip")));
  const created = calls.find(([, route, options]) => route.endsWith("/releases") && options.method === "POST");
  assert.equal(JSON.parse(created[2].body).prerelease, true);
  const upload = calls.find(([hostname]) => hostname === "uploads.github.com");
  assert.equal(upload[1], "/repos/developer/KMP-catalog/releases/5/assets");
  assert.equal(upload[2].headers["Content-Length"], String(101 * 1024 * 1024));
  const bencode = (await import("bencode")).default;
  const torrent = bencode.decode(pushedTorrent);
  assert.deepEqual([].concat(torrent["url-list"]).map((value) => Buffer.from(value).toString()), [SEED_URL]);
  assert.equal(crypto.createHash("sha1").update(bencode.encode(torrent.info)).digest("hex"), record.infoHash);
  const original = bencode.decode(await fs.readFile(record.torrentPath));
  assert.equal(original["url-list"], undefined);
});

test("reuses an uploaded seed asset instead of uploading again", async (context) => {
  const record = await largeProposal(context);
  const hosts = [];
  const fetch = async (url) => {
    const {hostname, pathname: route} = new URL(url); hosts.push(hostname);
    if (route === "/user") return response(200, {login: "developer"});
    if (route === "/repos/FerreiraTechLab/KMP-catalog") return response(200, {default_branch: "main"});
    if (route === "/repos/developer/KMP-catalog") return response(200, {fork: true});
    if (route.includes("/releases/tags/")) return response(200, {id: 5, upload_url: "https://uploads.github.com/x{?name}",
      assets: [{id: 9, state: "uploaded", size: 101 * 1024 * 1024, browser_download_url: SEED_URL}]});
    if (route.endsWith("/pulls")) return response(201, {number: 14, html_url: "https://example.test/pull/14"});
    return response(404, {message: route});
  };
  const result = await new GitHubPublisher("secret", {fetch, git: async () => {}}).publish(record);
  assert.equal(result.seedUrl, SEED_URL);
  assert.equal(result.upload, null);
  assert.ok(!hosts.includes("uploads.github.com"));
});

test("reports a failed GitHub validation with its message", async () => {
  const fetch = async (url) => {
    const route = new URL(url).pathname;
    if (route.endsWith("/pulls/7")) return response(200, {state: "open", merged_at: null,
      html_url: "https://example.test/pull/7", head: {sha: "abc"}});
    if (route.endsWith("/commits/abc/check-runs")) return response(200, {check_runs: [{name: "Validate catalog",
      status: "completed", conclusion: "failure", details_url: "https://example.test/check/1",
      output: {summary: "download BitTorrent falhou"}}]});
    return response(404, {message: route});
  };
  const status = await new GitHubPublisher("secret", {fetch}).reviewStatus(7);
  assert.equal(status.state, "failure");
  assert.match(status.message, /BitTorrent/);
  assert.equal(status.url, "https://example.test/check/1");
});

test("does not classify a merged pull request as closed", async () => {
  const fetch = async (url) => {
    const route = new URL(url).pathname;
    if (route.endsWith("/pulls/8")) return response(200, {state: "closed", merged_at: "2026-11-01T20:00:00Z",
      html_url: "https://example.test/pull/8", head: {sha: "def"}});
    if (route.endsWith("/commits/def/check-runs")) return response(200, {check_runs: [{name: "Validate catalog",
      status: "completed", conclusion: "failure", details_url: "https://example.test/check/2",
      output: {summary: "pacote ausente"}}]});
    return response(404, {message: route});
  };
  const status = await new GitHubPublisher("secret", {fetch}).reviewStatus(8);
  assert.equal(status.state, "failure");
  assert.match(status.label, /Mesclado/);
  assert.doesNotMatch(status.label, /encerrada/i);
});
