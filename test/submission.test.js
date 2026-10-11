const test = require("node:test");
const assert = require("node:assert/strict");
const {createSubmission, splitList} = require("../src/core/submission");

const input = {id:"example-port",name:"Example Port",description:"Port de teste",version:"1.0.0",revision:"1",license:"MIT",homepage:"https://example.org",source:"https://example.org/src",porterName:"Porter",porterUrl:"https://example.org/porter",licenseEvidence:"https://example.org/license",redistributionAllowed:true,architectures:"aarch64",firmwares:"darkos, rocknix",variantId:"aarch64-portmaster",minimumRamMB:"128",analogSticks:"1",renderers:"gles2",runtimes:"love_11_5",readyToRun:true,installPaths:"Example.sh, example/",userDataPaths:"example/conf/",channel:"stable",releaseNotes:"Primeira versão"};
const inspected = {fileName:"example-1.0.0.zip",sizeBytes:123,sha256:"a".repeat(64),roots:["Example.sh","example"],launchers:["Example.sh"]};

test("creates contract v1 submission",()=>{const result=createSubmission(input,inspected,new Date("2026-10-12T00:00:00Z"));assert.deepEqual(result.errors,[]);assert.equal(result.submission.schemaVersion,1);assert.equal(result.submission.release.variants[0].package.sha256,"a".repeat(64));assert.deepEqual(result.submission.release.variants[0].checks,["hash","zip-layout","launcher","license"])});
test("rejects invalid input and user path outside roots",()=>{const result=createSubmission({...input,id:"Bad ID",userDataPaths:"other/save/"},inspected);assert.ok(result.errors.some((error)=>error.includes("ID")));assert.ok(result.errors.some((error)=>error.includes("fora")))});
test("normalizes comma separated lists",()=>assert.deepEqual(splitList("a, b, a"),["a","b"]));
