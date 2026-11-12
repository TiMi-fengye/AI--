"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const python = process.platform === "win32" ? "python" : "python3";
const script = path.resolve(__dirname, "../deploy/recover-organization-settings.py");
// The Windows sandbox permits this workspace while AppData ancestors can deny
// lstat; use an isolated workspace directory there without weakening path checks.
const temporaryParent = process.platform === "win32" ? path.resolve(__dirname, "..") : os.tmpdir();
const root = fs.mkdtempSync(path.join(temporaryParent, ".hr-organization-recovery-"));
after(() => {
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), path.resolve(temporaryParent));
  assert.match(path.basename(resolved), /^\.hr-organization-recovery-/);
  fs.rmSync(resolved, { recursive: true, force: true });
});
let sequence = 0;
const source = `/* Synthetic organization only. */
const Employees = {
 _buildingLeaders: [{building: '合成楼栋', leaders: ['测试负责人甲', "测试负责人乙",],},],
 _regionOptions: ['合成区域',], // comment
 _roomOptions: ["合成机房"],
 _buildingOptions: ['合成楼栋'],
 _companyOptions: ['合成公司', '合成公司', ''],
 _personAttributes: ['合成属性'],
 _workAttributes: ['合成班次'],
 _workPositions: ['合成岗位'],
 _departments: ['合成部门'],
 dangerousMethod() { throw new Error('OLD CODE MUST NOT RUN'); }
};
throw new Error('OLD SCRIPT MUST NOT RUN');`;

function runPython(args, input) {
  const result = spawnSync(python, args, { encoding: "utf8", input, timeout: 15000 });
  assert.ifError(result.error);
  return result;
}
function archive(text = source, members = [{ name: "./js/employees.js", type: "file" }]) {
  const target = path.join(root, "source-" + ++sequence + ".tar.gz");
  const code = `import io,json,sys,tarfile
target,members=sys.argv[1:]
raw=sys.stdin.buffer.read()
with tarfile.open(target,'w:gz') as archive:
 for item in json.loads(members):
  entry=tarfile.TarInfo(item['name'])
  if item['type']=='file':
   entry.size=len(raw); archive.addfile(entry,io.BytesIO(raw))
  else:
   entry.type=tarfile.SYMTYPE if item['type']=='symlink' else tarfile.LNKTYPE
   entry.linkname='../../outside'; archive.addfile(entry)
`;
  const result = runPython(["-c", code, target, JSON.stringify(members)], text);
  assert.equal(result.status, 0, result.stderr);
  return target;
}
function invoke(bundle, apply = false, directory = path.join(root, "data-" + ++sequence)) {
  const args = [script, "--archive", bundle, "--data-dir", directory];
  if (apply) {
    args.push("--apply");
    if (process.platform !== "win32") args.push("--owner", String(process.getuid()));
  }
  return { ...runPython(args), directory, target: path.join(directory, "organization-settings.json") };
}

test("默认只报告数量，不创建目录或输出合成组织值", () => {
  const result = invoke(archive());
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.applied, false);
  assert.equal(report.counts.companies, 1);
  assert.equal(report.counts.statuses, 2);
  assert.equal(report.counts.buildingLeaders, 1);
  assert.ok(!result.stdout.includes("合成"));
  assert.ok(!fs.existsSync(result.directory));
});

test("显式应用恢复字面量、顺序去重和楼长字符串，不执行旧JS", () => {
  const result = invoke(archive(), true);
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(fs.readFileSync(result.target, "utf8"));
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.revision, 0);
  assert.deepEqual(data.options.companies, ["合成公司"]);
  assert.deepEqual(data.options.statuses, ["在职", "离职"]);
  assert.deepEqual(data.buildingLeaders, [{ building: "合成楼栋", leaders: "测试负责人甲、测试负责人乙" }]);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(result.target).mode & 0o777, 0o600);
    assert.equal(fs.statSync(result.target).uid, process.getuid());
  }
  assert.equal(fs.readdirSync(result.directory).length, 1);
});

test("已有设置绝不覆盖，也不留下临时文件", () => {
  const bundle = archive();
  const first = invoke(bundle, true);
  assert.equal(first.status, 0, first.stderr);
  const before = fs.readFileSync(first.target);
  const second = invoke(bundle, true, first.directory);
  assert.notEqual(second.status, 0);
  assert.deepEqual(fs.readFileSync(first.target), before);
  assert.deepEqual(fs.readdirSync(first.directory), ["organization-settings.json"]);
});

test("兼容无点前缀成员、字符串楼长、单双引号及Unicode转义", () => {
  const text = source.replace("['测试负责人甲', \"测试负责人乙\",]", "'测试负责人甲、测试负责人乙'").replace("'合成区域'", "'合成\\u533a\\u57df'");
  const result = invoke(archive(text, [{ name: "js/employees.js", type: "file" }]), true);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.target, "utf8")).options.regions, ["合成区域"]);
});

test("拒绝选项内的调用、标识符、模板串和数组表达式", () => {
  for (const replacement of ["[steal()]", "window.secret", "[`template` ]", "['x'].concat(secret)"]) {
    const result = invoke(archive(source.replace("['合成区域',]", replacement)), true);
    assert.notEqual(result.status, 0, replacement);
    assert.ok(!fs.existsSync(result.target));
    assert.ok(!result.stderr.includes("测试负责人"));
  }
});

test("拒绝缺项、重复属性、错误类型和重复楼栋", () => {
  const cases = [
    source.replace(" _departments: ['合成部门'],", ""),
    source.replace(" _departments:", " _regionOptions: ['其他'], _departments:"),
    source.replace("['合成区域',]", "[{bad: 'value'}]"),
    source.replace("_buildingLeaders: [", "_buildingLeaders: [{building:'合成楼栋',leaders:''},"),
    source.replace("'合成区域'", JSON.stringify("x".repeat(201))),
  ];
  for (const text of cases) {
    const result = invoke(archive(text), true);
    assert.notEqual(result.status, 0);
    assert.ok(!fs.existsSync(result.target));
  }
});

test("拒绝归档软链接、硬链接、重复成员及伪造路径", () => {
  const cases = [
    [{ name: "./js/employees.js", type: "symlink" }],
    [{ name: "js/employees.js", type: "hardlink" }],
    [{ name: "js/employees.js", type: "file" }, { name: "./js/employees.js", type: "file" }],
    [{ name: "../js/employees.js", type: "file" }],
  ];
  for (const members of cases) {
    const result = invoke(archive(source, members), true);
    assert.notEqual(result.status, 0);
    assert.ok(!fs.existsSync(result.target));
  }
});

test("归档其他成员不被解压或执行", () => {
  const result = invoke(archive(source, [{ name: "../../outside", type: "file" }, { name: "./js/employees.js", type: "file" }]), true);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!fs.existsSync(path.join(root, "outside")));
  assert.deepEqual(fs.readdirSync(result.directory), ["organization-settings.json"]);
});

test("拒绝过大的源码成员", () => {
  const result = invoke(archive(source + " ".repeat(2 * 1024 * 1024)), true);
  assert.notEqual(result.status, 0);
  assert.ok(!fs.existsSync(result.target));
});

test("POSIX拒绝悬空输出链接和父目录链接", { skip: process.platform === "win32" }, () => {
  const bundle = archive();
  const directory = path.join(root, "symlink-data");
  fs.mkdirSync(directory);
  const outside = path.join(root, "outside.json");
  fs.symlinkSync(outside, path.join(directory, "organization-settings.json"));
  assert.notEqual(invoke(bundle, true, directory).status, 0);
  assert.ok(!fs.existsSync(outside));
  const alias = path.join(root, "linked-data");
  fs.symlinkSync(directory, alias);
  assert.notEqual(invoke(bundle, true, alias).status, 0);
});

test("root默认使用hrsystem，非root保持当前属主并拒绝其他用户", () => {
  const code = `import pathlib,sys,types
from unittest import mock
namespace={'__name__':'synthetic_ownership_check'}
exec(compile(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'),'<recovery-helper>','exec'),namespace)
service=types.SimpleNamespace(pw_uid=4242,pw_gid=4243)
current=types.SimpleNamespace(pw_uid=1001,pw_gid=1002)
fake=types.SimpleNamespace(getpwnam=lambda name: service if name=='hrsystem' else current,getpwuid=lambda uid: current)
with mock.patch.dict(sys.modules,{'pwd':fake}),mock.patch.object(namespace['os'],'name','posix'),mock.patch.object(namespace['os'],'geteuid',return_value=0,create=True):
 assert namespace['ownership'](None)==(4242,4243)
with mock.patch.dict(sys.modules,{'pwd':fake}),mock.patch.object(namespace['os'],'name','posix'),mock.patch.object(namespace['os'],'geteuid',return_value=1001,create=True),mock.patch.object(namespace['os'],'getegid',return_value=1002,create=True):
 assert namespace['ownership'](None)==(1001,1002)
 assert namespace['ownership']('1001')==(1001,1002)
 try: namespace['ownership']('hrsystem')
 except namespace['RecoveryError']: pass
 else: raise AssertionError('Non-root ownership change must be refused')
print('Ownership defaults verified without changing files')
`;
  const result = runPython(["-c", code, script]);
  assert.equal(result.status, 0, result.stderr);
});
