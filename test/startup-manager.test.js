const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {desktopQuote, StartupManager} = require("../src/core/startup-manager");

test("quotes AppImage paths used by Linux autostart", () => {
  assert.equal(desktopQuote("/home/dev/KMP Publisher.AppImage"), '"/home/dev/KMP Publisher.AppImage"');
  assert.throws(() => desktopQuote("bad\npath"), /Caminho inválido/);
});

test("creates and removes the Linux autostart entry", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kmp-autostart-"));
  context.after(() => fs.rm(directory, {recursive: true, force: true}));
  const desktopPath = path.join(directory, "autostart", "kmp-publisher.desktop");
  const manager = new StartupManager({}, {platform: "linux", desktopPath,
    environment: {APPIMAGE: "/home/dev/KMP Publisher.AppImage"}, execPath: "/tmp/mount/kmp-publisher"});
  const enabled = await manager.setEnabled(true);
  const document = await fs.readFile(desktopPath, "utf8");
  assert.equal(enabled.executable, "/home/dev/KMP Publisher.AppImage");
  assert.match(document, /Exec="\/home\/dev\/KMP Publisher\.AppImage" --background/);
  await manager.setEnabled(false);
  await assert.rejects(fs.access(desktopPath), {code: "ENOENT"});
});

test("uses the operating system login API on Windows and macOS", async () => {
  const calls = [];
  const manager = new StartupManager({setLoginItemSettings: (value) => calls.push(value)},
    {platform: "win32", execPath: "C:\\KMP\\Publisher.exe"});
  await manager.setEnabled(true);
  assert.deepEqual(calls[0], {openAtLogin: true, path: "C:\\KMP\\Publisher.exe", args: ["--background"]});
});
