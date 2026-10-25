const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");

test("keeps only one Publisher instance and restores its hidden window", () => {
  assert.match(source, /requestSingleInstanceLock\(\)/);
  assert.match(source, /app\.on\("second-instance", \(\) => createWindow\(\)\)/);
  assert.match(source, /mainWindow\.hide\(\)/);
});

test("does not force a display protocol on Linux", () => {
  assert.doesNotMatch(source, /appendSwitch\("ozone-platform"/);
});
