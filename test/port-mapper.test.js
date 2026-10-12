const test = require("node:test");
const assert = require("node:assert/strict");
const {PortMapper, addressScope, xmlValue} = require("../src/core/port-mapper");

test("classifies public, private and CGNAT addresses", () => {
  assert.equal(addressScope("100.70.1.2"), "cgnat");
  assert.equal(addressScope("192.168.1.2"), "private");
  assert.equal(addressScope("8.8.8.8"), "public");
  assert.equal(addressScope("2804:14d::1"), "public");
});

test("reads namespace qualified SOAP values", () => {
  assert.equal(xmlValue("<m:NewExternalIPAddress>203.0.113.4</m:NewExternalIPAddress>",
    "NewExternalIPAddress"), "203.0.113.4");
});

test("falls back to NAT-PMP and closes the mapping", async () => {
  let closed = false;
  const manager = new PortMapper(6881, {renewMilliseconds: 60000, factories: [
    async () => { throw new Error("UPnP ausente"); },
    async () => ({method: "nat-pmp", externalAddress: "8.8.8.8",
      renew: async () => {}, close: async () => { closed = true; }})]});
  const status = await manager.start();
  assert.equal(status.active, true);
  assert.equal(status.method, "nat-pmp");
  assert.equal(status.internetReachable, true);
  await manager.stop();
  assert.equal(closed, true);
});
