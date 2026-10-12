const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {GitHubPublisher, safeSegment} = require("../src/core/github-publisher");

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
  assert.ok(calls.some(([route]) => route.endsWith("/merge-upstream")));
  assert.ok(gitCalls.some(([args]) => args[0] === "push"));
  assert.ok(gitCalls.every(([, options]) => !options.env.GIT_CONFIG_VALUE_0.includes("secret")));
});
