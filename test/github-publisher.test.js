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
  const fetch = async (url, options = {}) => {
    const route = new URL(url).pathname; calls.push([route, options]);
    if (route === "/user") return response(200, {login: "developer"});
    if (route === "/repos/FerreiraTechLab/KMP-catalog") return response(200, {default_branch: "main"});
    if (route.endsWith("/git/ref/heads/main")) return response(200, {object: {sha: "base"}});
    if (route.endsWith("/git/commits/base")) return response(200, {tree: {sha: "base-tree"}});
    if (route === "/repos/developer/KMP-catalog") return response(200, {fork: true});
    if (route.endsWith("/git/blobs")) return response(201, {sha: `blob-${calls.length}`});
    if (route.endsWith("/git/trees")) return response(201, {sha: "tree"});
    if (route.endsWith("/git/commits")) return response(201, {sha: "commit"});
    if (route.endsWith("/git/refs")) return response(201, {ref: "branch"});
    if (route.endsWith("/pulls")) return response(201, {number: 12, html_url: "https://github.com/FerreiraTechLab/KMP-catalog/pull/12"});
    return response(404, {message: route});
  };
  const publisher = new GitHubPublisher("secret", {fetch});
  const result = await publisher.publish({portId: "demo", version: "1.0", proposalPath: directory,
    packagePath: path.join(packages, "demo.zip"), torrentPath: path.join(torrents, "demo.torrent"),
    sha256: "a".repeat(64), infoHash: "b".repeat(40)});
  assert.equal(result.pullNumber, 12);
  assert.equal(calls.filter(([route]) => route.endsWith("/git/blobs")).length, 3);
  const treeCall = calls.find(([route]) => route.endsWith("/git/trees"));
  const tree = JSON.parse(treeCall[1].body).tree;
  assert.deepEqual(tree.map((item) => item.path), ["submissions/demo/1.0/submission.json",
    "submissions/demo/1.0/packages/demo.zip", "submissions/demo/1.0/torrents/demo.torrent"]);
});
