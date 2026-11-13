"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const python = process.platform === "win32" ? "python" : "python3";
const script = path.resolve(__dirname, "../deploy/apply-dashboard-leaders.py");
const canonical = value => value.replace(/\r\n/g, "\n").trimEnd() + "\n";
const sha = value => crypto.createHash("sha256").update(canonical(value)).digest("hex");
const current = canonical(fs.readFileSync(path.resolve(__dirname, "../server/auth-service.js"), "utf8"));
const bridge = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('reviewed_leaders',sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
value=json.loads(sys.stdin.buffer.read().decode('utf-8'))
if value.get('patches'):
 print(json.dumps(module.PATCHES))
else:
 try:
  result=module.patch_auth(value['text'].encode('utf-8'),value['expected'])
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
const patches = invoke({ patches: true });
assert.equal(patches.length, 3, "This release contains three reviewed organization-view edits");
// The fixture comes from public source, so tests require neither a production
// backup nor the private .delivery directory. Other auth behavior is untouched.
let baseline = current;
for (const [old, replacement] of patches) {
  assert.equal(baseline.split(replacement).length, 2, "Reviewed replacement must occur exactly once in public auth source");
  baseline = baseline.replace(replacement, old);
}
const patch = (text, expected = sha(text)) => invoke({ text, expected });

test("楼长定向补丁恢复审阅源码，保留无关认证代码并兼容CRLF基线", () => {
  assert.deepEqual(patch(baseline), { ok: true, result: current });
  assert.deepEqual(patch(baseline.replace(/\n/g, "\r\n") + "\r\n  ", sha(baseline)), { ok: true, result: current });
  const sentinel = "// Unrelated authentication code must survive this release.\n";
  assert.deepEqual(patch(sentinel + baseline), { ok: true, result: sentinel + current });
  assert.equal(patch(baseline, sha(current)).ok, false);
  assert.equal(patch(baseline + "// unreviewed deployment change\n", sha(baseline)).ok, false);
});

test("摘要正确也不能应用缺失、重复、部分应用或已完成的楼长补丁", () => {
  for (const [old, replacement] of patches) {
    assert.equal(patch(baseline.replace(old, "/* missing anchor */")).ok, false);
    assert.equal(patch(baseline + "\n" + old + "\n").ok, false);
    assert.equal(patch(baseline.replace(old, replacement)).ok, false);
  }
  assert.equal(patch(current).ok, false);
  assert.equal(patch(baseline, "z".repeat(64)).ok, false);
  assert.equal(patch(baseline.replace("const fs", "\rconst fs")).ok, false);
  assert.equal(patch(baseline + "\0").ok, false);
});

test("楼长发布CLI错误参数在访问服务器和修改服务之前拒绝", () => {
  for (const args of [[], ["--source", "."], ["--source", ".", "--expected-auth-sha256", "bad"], ["--source", ".", "--expected-auth-sha256", "a".repeat(63)]]) {
    const result = spawnSync(python, [script, ...args], { encoding: "utf8", timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--expected-auth-sha256/);
    assert.doesNotMatch(result.stderr, /Preflight passed|Traceback|systemctl/);
  }
  const help = spawnSync(python, [script, "--help"], { encoding: "utf8", timeout: 15000 });
  assert.ifError(help.error);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--expected-auth-sha256/);
});
