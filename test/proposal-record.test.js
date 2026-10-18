const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {resolveProposalPath} = require("../src/core/proposal-record");

test("preserves the proposal path stored by current versions", () => {
  assert.equal(resolveProposalPath({proposalPath: "/ports/example-1.0.0"}),
    "/ports/example-1.0.0");
});

test("recovers the proposal path from a legacy package record", () => {
  const packagePath = path.join("/home/developer", "riptidegp1-1.0.0", "packages", "riptidegp1.zip");
  assert.equal(resolveProposalPath({packagePath}),
    path.join("/home/developer", "riptidegp1-1.0.0"));
});

test("reports an unrecoverable record without passing undefined to path", () => {
  assert.equal(resolveProposalPath({}), null);
});
