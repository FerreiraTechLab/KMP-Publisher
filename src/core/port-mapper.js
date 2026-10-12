const dgram = require("node:dgram");
const fs = require("node:fs/promises");
const net = require("node:net");
const {execFile} = require("node:child_process");
const {promisify} = require("node:util");

const run = promisify(execFile);
const SERVICES = ["WANIPConnection", "WANPPPConnection"];

function addressScope(address) {
  if (!net.isIP(address)) return "unknown";
  if (address.includes(":")) {
    const value = address.toLowerCase();
    return value === "::1" || value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd") ? "private" : "public";
  }
  const parts = address.split(".").map(Number);
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return "cgnat";
  if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 169 && parts[1] === 254)) return "private";
  return "public";
}

function xmlValue(xml, name) {
  const match = String(xml).match(new RegExp(`<(?:[^:>]+:)?${name}[^>]*>([^<]*)<\\/(?:[^:>]+:)?${name}>`, "i"));
  return match ? match[1].trim() : null;
}

function localIpv4For(target) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", (error) => { socket.close(); reject(error); });
    socket.connect(9, target, () => {
      const address = socket.address().address;
      socket.close(); resolve(address);
    });
  });
}

async function defaultGateway() {
  if (process.platform === "linux") {
    const routes = await fs.readFile("/proc/net/route", "utf8");
    for (const line of routes.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length >= 4 && fields[1] === "00000000" && (parseInt(fields[3], 16) & 2)) {
        const hex = fields[2];
        return [3, 2, 1, 0].map((index) => parseInt(hex.slice(index * 2, index * 2 + 2), 16)).join(".");
      }
    }
  } else if (process.platform === "darwin") {
    const {stdout} = await run("route", ["-n", "get", "default"]);
    return stdout.match(/gateway:\s+(\S+)/)?.[1] || null;
  } else if (process.platform === "win32") {
    const {stdout} = await run("powershell.exe", ["-NoProfile", "-Command",
      "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1).NextHop"]);
    return stdout.trim() || null;
  }
  return null;
}

function discoverUpnp(timeout = 2200) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const locations = new Set();
    const finish = () => { socket.close(); resolve([...locations]); };
    socket.on("message", (data) => {
      const match = data.toString("latin1").match(/(?:^|\r\n)location:\s*([^\r\n]+)/i);
      if (match) locations.add(match[1].trim());
    });
    socket.once("error", (error) => { socket.close(); reject(error); });
    socket.bind(0, () => {
      const request = Buffer.from("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n");
      socket.send(request, 1900, "239.255.255.250", (error) => { if (error) reject(error); });
      setTimeout(finish, timeout).unref();
    });
  });
}

async function soap(controlUrl, serviceType, action, args = {}) {
  const values = Object.entries(args).map(([key, value]) => `<${key}>${value}</${key}>`).join("");
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${serviceType}">${values}</u:${action}></s:Body></s:Envelope>`;
  const response = await fetch(controlUrl, {method: "POST", signal: AbortSignal.timeout(5000),
    headers: {"Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${serviceType}#${action}"`}, body});
  if (!response.ok) throw new Error(`UPnP respondeu HTTP ${response.status}.`);
  return response.text();
}

async function upnpService(location) {
  const locationUrl = new URL(location);
  if (locationUrl.protocol !== "http:" || addressScope(locationUrl.hostname) !== "private")
    throw new Error("Descrição UPnP insegura.");
  const response = await fetch(location, {signal: AbortSignal.timeout(5000)});
  if (!response.ok) throw new Error(`Descrição UPnP respondeu HTTP ${response.status}.`);
  const xml = await response.text();
  for (const block of xml.match(/<service(?:\s[^>]*)?>[\s\S]*?<\/service>/gi) || []) {
    const serviceType = xmlValue(block, "serviceType");
    const control = xmlValue(block, "controlURL");
    if (serviceType && control && SERVICES.some((name) => serviceType.includes(name)))
      return {controlUrl: new URL(control, location).href, serviceType};
  }
  throw new Error("Serviço de gateway UPnP não encontrado.");
}

async function upnpMapping(port) {
  const errors = [];
  for (const location of await discoverUpnp()) {
    try {
      const service = await upnpService(location);
      const mapping = {method: "upnp", port, ...service,
        localAddress: await localIpv4For(new URL(service.controlUrl).hostname)};
      mapping.renew = async () => {
        for (const protocol of ["TCP", "UDP"]) {
          const args = {NewRemoteHost: "", NewExternalPort: port, NewProtocol: protocol,
            NewInternalPort: port, NewInternalClient: mapping.localAddress, NewEnabled: 1,
            NewPortMappingDescription: "KMP Publisher BitTorrent", NewLeaseDuration: 3600};
          try { await soap(mapping.controlUrl, mapping.serviceType, "AddPortMapping", args); }
          catch { args.NewLeaseDuration = 0; await soap(mapping.controlUrl, mapping.serviceType, "AddPortMapping", args); }
        }
      };
      mapping.close = async () => {
        for (const protocol of ["TCP", "UDP"]) {
          try { await soap(mapping.controlUrl, mapping.serviceType, "DeletePortMapping",
            {NewRemoteHost: "", NewExternalPort: port, NewProtocol: protocol}); } catch {}
        }
      };
      await mapping.renew();
      try { mapping.externalAddress = xmlValue(await soap(mapping.controlUrl, mapping.serviceType,
        "GetExternalIPAddress"), "NewExternalIPAddress"); } catch {}
      return mapping;
    } catch (error) { errors.push(error.message); }
  }
  throw new Error(`UPnP indisponível${errors.length ? `: ${errors.join("; ")}` : ""}`);
}

function natPmpRequest(gateway, payload, opcode, timeout = 1200) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => { socket.close(); reject(new Error("NAT-PMP não respondeu.")); }, timeout);
    socket.once("error", (error) => { clearTimeout(timer); socket.close(); reject(error); });
    socket.on("message", (response, sender) => {
      if (sender.address !== gateway || response.length < 8 || response[0] !== 0 || response[1] !== opcode + 128) return;
      clearTimeout(timer); socket.close();
      const code = response.readUInt16BE(2);
      code ? reject(new Error(`NAT-PMP recusou a solicitação (${code}).`)) : resolve(response);
    });
    socket.send(payload, 5351, gateway);
  });
}

async function natPmpMapping(port) {
  const gateway = await defaultGateway();
  if (!gateway) throw new Error("Gateway padrão não encontrado.");
  const map = async (opcode, lifetime) => {
    const request = Buffer.alloc(12); request[1] = opcode;
    request.writeUInt16BE(port, 4); request.writeUInt16BE(port, 6); request.writeUInt32BE(lifetime, 8);
    const response = await natPmpRequest(gateway, request, opcode);
    if (response.length < 16 || response.readUInt16BE(10) !== port)
      throw new Error("NAT-PMP atribuiu uma porta externa diferente.");
  };
  const mapping = {method: "nat-pmp", port, gateway,
    renew: async () => { await map(2, 3600); await map(1, 3600); },
    close: async () => { for (const opcode of [2, 1]) try { await map(opcode, 0); } catch {} }};
  await mapping.renew();
  try {
    const response = await natPmpRequest(gateway, Buffer.from([0, 0]), 0);
    if (response.length >= 12) mapping.externalAddress = [...response.subarray(8, 12)].join(".");
  } catch {}
  return mapping;
}

class PortMapper {
  constructor(port, options = {}) {
    this.port = port;
    this.renewMilliseconds = options.renewMilliseconds || 20 * 60 * 1000;
    this.factories = options.factories || [upnpMapping, natPmpMapping];
    this.mapping = null; this.timer = null;
    this.status = {active: false, method: null, port, addressScope: "unknown",
      internetReachable: false, errors: []};
  }
  async start() {
    if (this.mapping) return this.status;
    const errors = [];
    for (const factory of this.factories) {
      try { this.mapping = await factory(this.port); break; }
      catch (error) { errors.push(error.message); }
    }
    if (!this.mapping) { this.status = {...this.status, errors}; return this.status; }
    const scope = addressScope(this.mapping.externalAddress);
    this.status = {active: true, method: this.mapping.method, port: this.port,
      externalAddress: this.mapping.externalAddress || null, addressScope: scope,
      internetReachable: scope === "public", errors};
    this.timer = setInterval(() => this.mapping?.renew().catch((error) => {
      this.status = {...this.status, active: false, internetReachable: false, errors: [error.message]};
    }), this.renewMilliseconds);
    this.timer.unref();
    return this.status;
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.mapping) await this.mapping.close();
    this.mapping = null;
    this.status = {...this.status, active: false, internetReachable: false};
  }
  details() { return {...this.status}; }
}

module.exports = {PortMapper, addressScope, defaultGateway, xmlValue};
