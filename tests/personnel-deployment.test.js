"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const python = process.platform === "win32" ? "python" : "python3";
const script = path.resolve(__dirname, "../deploy/apply-personnel-fields.py");
const current = fs.readFileSync(path.resolve(__dirname, "../server/auth-service.js"), "utf8").replace(/\r\n/g, "\n").trimEnd() + "\n";
const replacements = [
  ['const PROFILE_FIELDS = ["name", "gender",', 'const PROFILE_FIELDS = ["name", "employeeNo", "gender",'],
  ['      const max = field.endsWith("Data") ? 8 * 1024 * 1024 : (field === "_resumeText" || field === "aiProfile" ? 50000 : 1000);', '      const max = field === "employeeNo" ? 80 : (field.endsWith("Data") ? 8 * 1024 * 1024 : (field === "_resumeText" || field === "aiProfile" ? 50000 : 1000));'],
  ['    validateRows(next.employees, "人员");\n    const ids = new Set(next.employees.map(e => e.id));', '    validateRows(next.employees, "人员");\n    next.employees = next.employees.map(employee => ({ ...employee, ...profileData(employee, ["employeeNo"]) }));\n    const ids = new Set(next.employees.map(e => e.id));']
];
let baseline = current;
for (const [old, replacement] of replacements) {
  assert.equal(baseline.split(replacement).length, 2, "Current auth must contain exactly one reviewed statement");
  baseline = baseline.replace(replacement, old);
}
const canonical = value => value.replace(/\r\n/g, "\n").trimEnd() + "\n";
const sha = value => crypto.createHash("sha256").update(canonical(value)).digest("hex");
function invoke(text, expected = sha(text)) {
  const code = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('reviewed_personnel',sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
value=json.loads(sys.stdin.buffer.read().decode('utf-8'))
try:
 result=module.patch_auth(value['text'].encode('utf-8'),value['expected'])
 print(json.dumps({'ok':True,'result':result.decode('utf-8')}))
except module.Refused as error:
 print(json.dumps({'ok':False,'message':str(error)}))
`;
  const result = spawnSync(python, ["-c", code, script], { input: JSON.stringify({ text, expected }), encoding: "utf8", timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("定向发布的纯补丁仅修改三处已审阅语句，保持其他代码及短信状态原样", () => {
  const result = invoke(baseline);
  assert.equal(result.ok, true);
  assert.equal(result.result, current);
  const crlf = invoke(baseline.replace(/\n/g, "\r\n") + "\r\n\r\n  ", sha(baseline));
  assert.deepEqual(crlf, result);
  assert.equal(invoke(baseline, sha(current)).ok, false);
  assert.equal(invoke(baseline + "// unreviewed change\n", sha(baseline)).ok, false);
  assert.equal(invoke(baseline, "x".repeat(64)).ok, false);
});

test("即使摘要匹配也拒绝缺失、重复和已应用的补丁锚点", () => {
  for (const [old] of replacements) {
    assert.equal(invoke(baseline.replace(old, "/* anchor removed */")).ok, false);
    assert.equal(invoke(baseline + "\n" + old + "\n").ok, false);
  }
  assert.equal(invoke(current).ok, false);
  assert.equal(invoke(baseline.replace("const fs", "\rconst fs")).ok, false);
  assert.equal(invoke(baseline + "\0").ok, false);
});

test("发布命令必须显式提供64位摘要，错误参数在任何服务器操作前被拒绝", () => {
  for (const args of [[], ["--source", "."], ["--source", ".", "--expected-auth-sha256", "bad"], ["--source", ".", "--expected-auth-sha256", "a".repeat(63)]]) {
    const result = spawnSync(python, [script, ...args], { encoding: "utf8", timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--expected-auth-sha256/);
    assert.doesNotMatch(result.stderr, /Preflight passed|Backup:|Traceback/);
  }
  const help = spawnSync(python, [script, "--help"], { encoding: "utf8", timeout: 15000 });
  assert.ifError(help.error);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--expected-auth-sha256/);
});
