const test = require("node:test");
const assert = require("node:assert/strict");
const {findPublishedPackage} = require("../src/core/catalog-discovery");

test("matches only the published version and immutable package hash", () => {
  const record = {portId: "example", version: "1.0", sha256: "a".repeat(64)};
  const download = {sha256: "a".repeat(64), torrent: "ZA=="};
  const catalog = {schemaVersion: 3, items: [{id: "example", release: {version: "1.0",
    variants: [{download}]}}]};
  assert.equal(findPublishedPackage(catalog, record), download);
  assert.equal(findPublishedPackage(catalog, {...record, sha256: "b".repeat(64)}), null);
  assert.equal(findPublishedPackage(catalog, {...record, version: "2.0"}), null);
});
