const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {AppUpdater, compareVersions, assetPattern, parseChecksums, selectRelease} = require("../src/core/app-updater");

const installer = Buffer.from("instalador novo do publisher");
const digest = crypto.createHash("sha256").update(installer).digest("hex");
const asset = (name, size = installer.length) => ({name, size, browser_download_url: `https://example.test/${name}`});
const releases = [
  {tag_name: "client-v0.2.56", draft: false, html_url: "c", assets: [asset("KMP-v0.2.56.zip"), asset("SHA256SUMS.txt")]},
  {tag_name: "publisher-v0.4.0", draft: true, html_url: "d", assets: [asset("KMP-Publisher-0.4.0-linux-x64.AppImage"), asset("SHA256SUMS.txt")]},
  {tag_name: "publisher-v0.3.10", draft: false, html_url: "n", assets: [asset("KMP-Publisher-0.3.10-macos-arm64.dmg"), asset("SHA256SUMS.txt")]},
  {tag_name: "publisher-v0.3.9", draft: false, html_url: "p", body: "notas", assets: [
    asset("KMP-Publisher-0.3.9-linux-x64.AppImage"), asset("KMP-Publisher-0.3.9-windows-x64-setup.exe"), asset("SHA256SUMS.txt")]}
];

function response(body, status = 200) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  return {ok: status >= 200 && status < 300, status, json: async () => JSON.parse(bytes), text: async () => bytes.toString(),
    body: new ReadableStream({start(controller) { controller.enqueue(new Uint8Array(bytes)); controller.close(); }})};
}

function fakeFetch(files) {
  return async (url) => {
    if (url.startsWith("https://api.github.com/")) return response(releases);
    const name = url.split("/").pop();
    return name in files ? response(files[name]) : response("", 404);
  };
}

test("compares dotted versions numerically", () => {
  assert.ok(compareVersions("0.3.10", "0.3.9") > 0);
  assert.ok(compareVersions("0.3.8", "0.3.8") === 0);
  assert.ok(compareVersions("0.3.7", "1.0.0") < 0);
});

test("maps each supported system to its installer", () => {
  assert.ok(assetPattern("linux", "x64").test("KMP-Publisher-1.0.0-linux-x64.AppImage"));
  assert.ok(assetPattern("darwin", "arm64").test("KMP-Publisher-1.0.0-macos-arm64.dmg"));
  assert.equal(assetPattern("linux", "arm64"), null);
});

test("picks the newest complete Publisher release for this system", () => {
  assert.equal(selectRelease(releases, "linux", "x64").version, "0.3.9");
  assert.equal(selectRelease(releases, "darwin", "arm64").version, "0.3.10");
  assert.equal(selectRelease(releases, "darwin", "x64"), null);
});

test("parses SHA256SUMS lines", () => {
  const sums = parseChecksums(`${digest}  KMP-Publisher-0.3.9-linux-x64.AppImage\n${"0".repeat(64)} *other.exe\n`);
  assert.equal(sums.get("KMP-Publisher-0.3.9-linux-x64.AppImage"), digest);
  assert.equal(sums.get("other.exe"), "0".repeat(64));
});

test("reports newer, current and unsupported states", async () => {
  const states = [];
  const newer = new AppUpdater({currentVersion: "0.3.8", platform: "linux", arch: "x64", directory: "/tmp/x",
    fetch: fakeFetch({}), onState: (state) => states.push(state.status)});
  assert.equal((await newer.check()).status, "available");
  assert.equal(newer.state.version, "0.3.9");
  assert.deepEqual(states, ["checking", "available"]);
  const current = new AppUpdater({currentVersion: "0.3.9", platform: "linux", arch: "x64", directory: "/tmp/x", fetch: fakeFetch({})});
  assert.equal((await current.check()).status, "current");
  const unsupported = new AppUpdater({currentVersion: "0.3.8", platform: "linux", arch: "arm64", directory: "/tmp/x", fetch: fakeFetch({})});
  assert.equal((await unsupported.check()).status, "unsupported");
});

test("downloads the installer only when the checksum matches", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kmp-updater-"));
  context.after(() => fs.rm(directory, {recursive: true, force: true}));
  const name = "KMP-Publisher-0.3.9-linux-x64.AppImage";
  const good = new AppUpdater({currentVersion: "0.3.8", platform: "linux", arch: "x64", directory,
    fetch: fakeFetch({[name]: installer, "SHA256SUMS.txt": `${digest}  ${name}\n`})});
  await good.check();
  const file = await good.download();
  assert.deepEqual(await fs.readFile(file), installer);
  assert.equal(good.state.status, "ready");

  const bad = new AppUpdater({currentVersion: "0.3.8", platform: "linux", arch: "x64", directory,
    fetch: fakeFetch({[name]: Buffer.from("adulterado"), "SHA256SUMS.txt": `${digest}  ${name}\n`})});
  await bad.check();
  await assert.rejects(bad.download(), /SHA-256/);
  assert.equal(bad.state.status, "error");
  await assert.rejects(fs.access(path.join(directory, name)));
});
