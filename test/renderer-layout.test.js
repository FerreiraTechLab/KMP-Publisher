const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const html = fs.readFileSync(path.join(__dirname, "../src/renderer/index.html"), "utf8");

test("contains loading, mandatory login and dashboard states", () => {
  for (const id of ["loading-screen", "login-screen", "dashboard-view", "editor-view"])
    assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /Downloads equivalentes/);
  assert.match(html, /Rede consumida/);
});
test("keeps port management actions accessible", () => {
  for (const id of ["add-port", "update-port", "seed-modal", "community-node"])
    assert.match(html, new RegExp(`id="${id}"`));
});
