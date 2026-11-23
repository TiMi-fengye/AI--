"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const python = process.platform === "win32" ? "python" : "python3";
const script = path.resolve(__dirname, "../deploy/apply-personnel-export.py");
const canonical = text => text.replace(/\r\n/g, "\n").trimEnd() + "\n";
const sha = text => crypto.createHash("sha256").update(canonical(text)).digest("hex");

const bridge = `import base64,importlib.util,json,sys
spec=importlib.util.spec_from_file_location('reviewed_personnel_export',sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
value=json.loads(sys.stdin.buffer.read().decode('utf-8'))
if value.get('manifest'):
 print(json.dumps({'auth':module.PATCHES,'index':module.INDEX_PATCHES,'files':module.FILES,'vendorSha256':module.VENDOR_SHA256}))
else:
 try:
  raw=base64.b64decode(value['base64']) if 'base64' in value else value['text'].encode('utf-8')
  function=module.patch_auth if value['kind']=='auth' else module.patch_index
  result=function(raw,value['expected'])
  print(json.dumps({'ok':True,'result':result.decode('utf-8')}))
 except module.Refused as error:
  print(json.dumps({'ok':False,'message':str(error)}))
`;
function invoke(value) {
  const result = spawnSync(python, ["-c", bridge, script], { input: JSON.stringify(value), encoding: "utf8", timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
const manifest = invoke({ manifest: true });
assert.equal(manifest.auth.length, 3);
assert.equal(manifest.index.length, 2);

// This historical publisher keeps its original reviewed public route fragments.
// New approval routing has superseded those anchors in current auth-service.js;
// no production backup, credentials or ignored .delivery file is a test dependency.
const current = {
  auth: canonical(manifest.auth.map(pair => pair[1]).join("\n")),
  index: canonical(fs.readFileSync(path.resolve(__dirname, "../index.html"), "utf8"))
};
const baseline = {};
for (const kind of ["auth", "index"]) {
  baseline[kind] = current[kind];
  for (const [old, replacement] of manifest[kind]) {
    assert.equal(baseline[kind].split(replacement).length, 2, `Public ${kind} source must contain the complete reviewed replacement exactly once`);
    baseline[kind] = baseline[kind].replace(replacement, old);
  }
}
const patch = (kind, text, expected = sha(text)) => invoke({ kind, text, expected });

test("人员导出AUTH定向补丁精确恢复公开源码并保留其他认证及短信状态", () => {
  assert.deepEqual(patch("auth", baseline.auth), { ok: true, result: current.auth });
  assert.deepEqual(patch("auth", baseline.auth.replace(/\n/g, "\r\n") + "\r\n  ", sha(baseline.auth)), { ok: true, result: current.auth });
  const sentinel = "// Other deployed authentication and configuration must survive unchanged.\n";
  assert.deepEqual(patch("auth", sentinel + baseline.auth), { ok: true, result: sentinel + current.auth });
});

test("人员导出INDEX定向补丁仅增加导出入口和资源版本且保留原页面其他资源", () => {
  assert.deepEqual(patch("index", baseline.index), { ok: true, result: current.index });
  assert.deepEqual(patch("index", baseline.index.replace(/\n/g, "\r\n") + "\r\n\r\n", sha(baseline.index)), { ok: true, result: current.index });
  const sentinel = "<!-- Other existing frontend version references must survive. -->\n";
  assert.deepEqual(patch("index", sentinel + baseline.index), { ok: true, result: sentinel + current.index });
  assert.equal(current.index.split('src="js/personnel-export.js?').length, 2);
  assert.equal(current.index.split('src="js/xlsx.full.min.js?').length, 2);
});

test("基线摘要不符或锚点缺失、重复、部分应用和已完成时拒绝导出补丁", () => {
  for (const kind of ["auth", "index"]) {
    assert.equal(patch(kind, baseline[kind], sha(current[kind])).ok, false);
    assert.equal(patch(kind, baseline[kind] + "\nUNREVIEWED\n", sha(baseline[kind])).ok, false);
    assert.equal(patch(kind, baseline[kind], "z".repeat(64)).ok, false);
    for (const [old, replacement] of manifest[kind]) {
      assert.equal(patch(kind, baseline[kind].replace(old, "REMOVED_ANCHOR")).ok, false);
      assert.equal(patch(kind, baseline[kind] + "\n" + old + "\n").ok, false);
      assert.equal(patch(kind, baseline[kind].replace(old, replacement)).ok, false);
    }
    assert.equal(patch(kind, current[kind]).ok, false);
    assert.equal(patch(kind, "\r" + baseline[kind]).ok, false);
    assert.equal(patch(kind, baseline[kind] + "\0").ok, false);
    assert.equal(invoke({ kind, base64: Buffer.from([0xff, 0xfe, 0xff]).toString("base64"), expected: "a".repeat(64) }).ok, false);
  }
});

test("人员导出发布CLI必须同时提供两份有效基线摘要，错误参数先于服务器操作拒绝", () => {
  const valid = "a".repeat(64);
  const invalidArgs = [
    [], ["--source", "."],
    ["--source", ".", "--expected-auth-sha256", valid],
    ["--source", ".", "--expected-index-sha256", valid],
    ["--source", ".", "--expected-auth-sha256", "bad", "--expected-index-sha256", valid],
    ["--source", ".", "--expected-auth-sha256", valid, "--expected-index-sha256", "bad"],
    ["--source", ".", "--expected-auth-sha256", valid, "--expected-index-sha256", "a".repeat(63)]
  ];
  for (const args of invalidArgs) {
    const result = spawnSync(python, [script, ...args], { encoding: "utf8", timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--expected-(?:auth|index)-sha256/);
    assert.doesNotMatch(result.stderr, /Preflight passed|Traceback|systemctl|Run this production deployment/);
  }
  const help = spawnSync(python, [script, "--help"], { encoding: "utf8", timeout: 15000 });
  assert.ifError(help.error);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--expected-auth-sha256/);
  assert.match(help.stdout, /--expected-index-sha256/);
});

test("发布的表格库匹配审阅摘要并随附许可证，不引入未上线短信或运行数据文件", () => {
  const vendor = fs.readFileSync(path.resolve(__dirname, "../js/xlsx.full.min.js"));
  assert.equal(crypto.createHash("sha256").update(vendor).digest("hex"), manifest.vendorSha256);
  assert.ok(manifest.files.includes("LICENSE-SheetJS.txt"));
  assert.ok(manifest.files.includes("js/personnel-export.js"));
  assert.ok(manifest.files.includes("人力资源管理系统开发架构.html"));
  assert.ok(fs.statSync(path.resolve(__dirname, "../LICENSE-SheetJS.txt")).isFile());
  assert.ok(!manifest.files.some(file => /sms|server\/data|config\.json|auth-users/.test(file)));
});
