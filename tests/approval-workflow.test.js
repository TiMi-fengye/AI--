"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const path = require("node:path"), fs = require("node:fs"), os = require("node:os"), http = require("node:http"), crypto = require("node:crypto");
const { once } = require("node:events");
const auth = require(process.env.HR_APPROVAL_AUTH_TEST_MODULE || path.join(__dirname, "../server/auth-service"));
const workflow = require(process.env.HR_APPROVAL_WORKFLOW_MODULE || path.join(__dirname, "../server/approval-workflow"));
const { createApprovalSmsSender, deliverEvent } = require(process.env.HR_APPROVAL_NOTIFICATIONS_MODULE || path.join(__dirname, "../server/approval-notifications"));
const admin = { role: "admin", username: "admin", name: "合成管理员" };
const leader = { role: "leader", username: "leader", name: "合成楼长", employeeId: 1, buildings: ["A"] };
const regional = { role: "region_manager", username: "regional", name: "合成区域经理", employeeId: 3, regions: ["华北"] };
const member = { role: "user", username: "member", employeeId: 1 };
function snapshot(type = "compensatory") {
  return { ...auth.emptySnapshot(), revision: 1, employees: [
    { id: 1, name: "合成员工", phone: "13800000001", region: "华北", building: "A", resumeData: "private-synthetic-attachment", email: "private@example.com" },
    { id: 2, name: "其他区域", region: "华东", building: "B" },
    { id: 3, name: "区域经理本人", phone: "13800000003", region: "华东", building: "B", resumeData: "own-attachment" }
  ], overtime: [{ id: 10, employeeId: 1, date: "2026-11-23", hours: 4, overtimeType: "compensatory", reason: "合成", status: "pending" }],
  leaveRequests: [{ id: 20, employeeId: 1, type, startDate: "2026-11-23T09:00", endDate: "2026-11-23T10:00", hours: 1, days: 1, reason: "合成", status: "pending" }] };
}
function approve(current, kind, id, actor, decision = "approved") { return workflow.transition(current, kind, id, actor, decision, "2026-11-23T02:00:00.000Z"); }

test("both fee and compensatory overtime require leader then regional approval, including administrator substitution", () => {
  for (const overtimeType of ["fee", "compensatory"]) {
    const original = snapshot(); original.overtime[0].overtimeType = overtimeType;
    for (const firstActor of [leader, admin]) {
      const first = approve(original, "overtime", 10, firstActor);
      assert.equal(first.record.status, "pending"); assert.equal(first.record.approvalStage, "regional");
      assert.equal(first.record.approvalHistory.length, 1); assert.equal(original.overtime[0].approvalHistory, undefined);
      assert.throws(() => approve(first.snapshot, "overtime", 10, leader), error => error.status === 403);
      const final = approve(first.snapshot, "overtime", 10, regional);
      assert.equal(final.record.status, "approved"); assert.equal(final.record.approvalStage, "complete"); assert.equal(final.record.approvalHistory.length, 2);
      assert.throws(() => approve(final.snapshot, "overtime", 10, admin), error => error.status === 409);
    }
  }
});
test("three annual and paid-sick categories require final approval while existing other categories remain single-stage", () => {
  for (const type of ["statutoryAnnual", "welfareAnnual", "paidSick", "personal", "annual", "sick"]) {
    const first = approve(snapshot(type), "leaveRequests", 20, leader);
    const two = ["statutoryAnnual", "welfareAnnual", "paidSick"].includes(type);
    assert.equal(first.record.status, two ? "pending" : "approved");
    if (two) assert.equal(approve(first.snapshot, "leaveRequests", 20, regional).record.status, "approved");
    assert.equal(first.notification, null);
  }
});
test("compensatory and shift leave finalize at leader approval and persist one separate notification event", () => {
  for (const type of ["compensatory", "shift"]) {
    const result = approve(snapshot(type), "leaveRequests", 20, leader);
    assert.equal(result.record.status, "approved"); assert.equal(result.record.approvalStage, "complete");
    assert.equal(result.snapshot.approvalOutbox.length, 1); assert.equal(result.notification.region, "华北");
    assert.equal(result.notification.payload.employee, "合成员工"); assert.equal(JSON.stringify(result.notification).includes("13800000001"), false);
  }
});
test("wrong floor, wrong region, missing region, region changes and direct snapshot approval or metadata forgery are refused", () => {
  const source = snapshot();
  assert.throws(() => approve(source, "overtime", 10, regional), error => error.status === 403);
  assert.throws(() => approve(source, "overtime", 10, { ...leader, buildings: ["B"] }), error => error.status === 403);
  const first = approve(source, "overtime", 10, leader).snapshot;
  assert.throws(() => approve(first, "overtime", 10, { ...regional, regions: ["华东"] }), error => error.status === 403);
  first.employees[0].region = "华东";
  assert.throws(() => approve(first, "overtime", 10, admin), error => error.status === 409);
  source.employees[0].region = "";
  assert.throws(() => approve(source, "overtime", 10, leader), error => error.status === 400);
  const rejected = approve(source, "overtime", 10, leader, "rejected");
  assert.equal(rejected.record.status, "rejected"); assert.equal(rejected.record.approvalStage, "complete"); assert.equal(rejected.notification, null);
  for (const actor of [admin, leader, member]) {
    const current = snapshot(), incoming = auth.scopedSnapshot(current, actor); incoming.overtime[0].status = "approved";
    assert.throws(() => auth.mergeSnapshot(current, incoming, actor), error => error.status === 403);
  }
  for (const field of ["approvalStage", "approvalHistory", "approvalRegion"]) {
    const current = snapshot(), incoming = auth.scopedSnapshot(current, admin); incoming.overtime[0][field] = field === "approvalHistory" ? [{ role: "admin" }] : "forged";
    assert.throws(() => auth.mergeSnapshot(current, incoming, admin), error => error.status === 403);
  }
});
test("new imports cannot seed approved requests; submitted state is server-generated and edits lock after first approval", () => {
  const current = snapshot(); current.overtime = [];
  const incoming = auth.scopedSnapshot(current, admin); incoming.overtime.push({ ...snapshot().overtime[0], status: "approved" });
  assert.throws(() => auth.mergeSnapshot(current, incoming, admin), error => error.status === 403);
  incoming.overtime[0].status = "pending";
  const saved = auth.mergeSnapshot(current, incoming, admin);
  assert.equal(saved.overtime[0].approvalStage, "leader"); assert.deepEqual(saved.overtime[0].approvalHistory, []);
  const first = approve(saved, "overtime", 10, leader).snapshot;
  const edited = auth.scopedSnapshot(first, admin); edited.overtime[0].hours = 7;
  assert.throws(() => auth.mergeSnapshot(first, edited, admin), error => error.status === 403);
  const legacy = snapshot(); legacy.overtime[0].status = "approved";
  const preserved = auth.mergeSnapshot(legacy, auth.scopedSnapshot(legacy, admin), admin);
  assert.equal(preserved.overtime[0].approvalStage, undefined); assert.equal(preserved.overtime[0].approvalHistory, undefined);
});
test("regional managers receive only approval-needed fields plus their own profile and can maintain only themselves", () => {
  const current = snapshot(), scoped = auth.scopedSnapshot(current, regional);
  assert.deepEqual(scoped.employees.map(employee => employee.id), [1, 3]);
  assert.equal(scoped.employees[0].phone, undefined); assert.equal(scoped.employees[0].resumeData, undefined); assert.equal(scoped.employees[0].email, undefined);
  assert.equal(scoped.employees[1].resumeData, "own-attachment");
  scoped.employees[1].email = "own-new@example.com";
  const result = auth.mergeSnapshot(current, scoped, regional);
  assert.equal(result.employees.find(employee => employee.id === 3).email, "own-new@example.com");
  assert.equal(result.employees.find(employee => employee.id === 1).resumeData, "private-synthetic-attachment");
  scoped.employees[0].name = "forged";
  assert.throws(() => auth.mergeSnapshot(current, scoped, regional), error => error.status === 403);
});
test("notification outbox is hidden from every client and cannot be replaced through administrator import", () => {
  const current = approve(snapshot("shift"), "leaveRequests", 20, leader).snapshot;
  for (const actor of [admin, leader, member, regional]) assert.equal(auth.scopedSnapshot(current, actor).approvalOutbox, undefined);
  const incoming = auth.scopedSnapshot(current, admin); incoming.approvalOutbox = [{ phone: "forged" }];
  const result = auth.mergeSnapshot(current, incoming, admin);
  assert.deepEqual(result.approvalOutbox, current.approvalOutbox);
});
test("notification delivery persists before send, blocks missing configuration and never automatically resends uncertain outcomes", async () => {
  const event = approve(snapshot(), "leaveRequests", 20, leader).notification, account = { regional: { ...regional, phone: "13800000009" } };
  let saves = 0, sends = 0;
  await deliverEvent(event, account, null, async () => saves++);
  assert.equal(event.status, "blocked"); assert.equal(event.reason, "sms_not_configured"); assert.equal(sends, 0);
  await deliverEvent(event, account, async input => { sends++; assert.ok(saves >= 2); assert.equal(event.deliveries.regional.status, "sending"); assert.equal(input.phone, "13800000009"); throw new Error("synthetic unknown outcome"); }, async () => saves++);
  assert.equal(event.status, "uncertain"); assert.equal(sends, 1);
  await deliverEvent(event, account, async () => { sends++; return { ok: true }; }, async () => saves++);
  assert.equal(sends, 1); assert.equal(event.status, "uncertain");
  const noManager = approve(snapshot(), "leaveRequests", 20, leader).notification;
  await deliverEvent(noManager, {}, async () => ({ ok: true }), async () => {});
  assert.equal(noManager.status, "blocked"); assert.equal(noManager.reason, "no_region_manager");
});

async function fixture(t, sender) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hr-approval-")), password = "synthetic-approval-password", salt = "synthetic-salt";
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  fs.writeFileSync(path.join(dir, "auth-users.json"), JSON.stringify(Object.fromEntries(Object.entries({ admin, leader, regional: { ...regional, phone: "13800000003" }, member }).map(([username, actor]) => [username, { ...actor, name: actor.name || "合成员工", passwordSalt: salt, passwordHash: hash }]))));
  let state = snapshot();
  const service = auth.createAuthService({ dataDir: dir, readSnapshot: async () => structuredClone(state), writeSnapshot: async next => { state = structuredClone(next); }, approvalSmsSender: sender });
  const server = http.createServer(async (req, res) => { if (!(await service.handle(req, res, new URL(req.url, "http://localhost").pathname))) { res.writeHead(404); res.end(); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); const target = path.resolve(dir); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.match(path.basename(target), /^hr-approval-/); fs.rmSync(target, { recursive: true, force: true }); });
  const base = "http://127.0.0.1:" + server.address().port;
  async function request(url, method = "GET", body, cookie = "") {
    const response = await fetch(base + url, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  }
  const cookies = {};
  for (const username of ["admin", "leader", "regional", "member"]) { const result = await request("/api/auth/login", "POST", { username, password }); assert.equal(result.status, 200); cookies[username] = result.cookie; }
  return { request, cookies, get state() { return state; }, reset(value) { state = structuredClone(value); } };
}
test("approval HTTP endpoint uses revision and current role, enforces two steps and keeps effective balances final-only", async t => {
  const f = await fixture(t);
  const url = "/api/approvals/overtime/10";
  assert.equal((await f.request(url, "POST", { decision: "approved", expectedRevision: 1 })).status, 401);
  assert.equal((await f.request("/api/approvals/overtime/fake", "POST", { decision: "approved" })).status, 401);
  assert.equal((await f.request("/api/approvals/unknown", "GET")).status, 401);
  assert.equal((await f.request(url, "POST", { decision: "approved", expectedRevision: 1 }, f.cookies.member)).status, 403);
  assert.equal((await f.request(url, "POST", { decision: "approved" }, f.cookies.admin)).status, 409);
  let result = await f.request(url, "POST", { decision: "approved", expectedRevision: 1 }, f.cookies.leader);
  assert.equal(result.status, 200); assert.equal(result.data.record.status, "pending");
  assert.equal((await f.request(url, "POST", { decision: "approved", expectedRevision: 1 }, f.cookies.admin)).status, 409);
  result = await f.request(url, "POST", { decision: "approved", expectedRevision: f.state.revision }, f.cookies.regional);
  assert.equal(result.status, 200); assert.equal(result.data.record.status, "approved");
  result = await f.request("/api/approvals/leaveRequests/20", "POST", { decision: "approved", expectedRevision: f.state.revision }, f.cookies.leader);
  assert.equal(result.status, 200); assert.equal(result.data.record.status, "approved"); assert.equal(result.data.notification.status, "blocked");
  assert.equal((await f.request("/api/approvals/notifications", "GET", undefined, f.cookies.member)).status, 403);
  const notices = await f.request("/api/approvals/notifications", "GET", undefined, f.cookies.regional);
  assert.equal(notices.status, 200); assert.equal(notices.data.notifications.length, 1); assert.doesNotMatch(JSON.stringify(notices.data), /1380000000/);
  const retry = "/api/approvals/notifications/" + result.data.notification.id + "/retry";
  assert.equal((await f.request(retry, "POST", {}, f.cookies.regional)).status, 403);
  const insufficient = snapshot(); f.reset(insufficient);
  assert.equal((await f.request("/api/approvals/leaveRequests/20", "POST", { decision: "approved", expectedRevision: insufficient.revision }, f.cookies.leader)).status, 400);
  assert.equal(f.state.leaveRequests[0].status, "pending"); assert.equal(f.state.approvalOutbox, undefined);
});
test("uncertain delivery requires explicit administrator confirmation and persists a successful manual retry", async t => {
  let sends = 0;
  const f = await fixture(t, async () => { if (++sends === 1) throw new Error("synthetic acceptance unknown"); return { ok: true }; });
  f.reset(snapshot("shift"));
  const approved = await f.request("/api/approvals/leaveRequests/20", "POST", { decision: "approved", expectedRevision: f.state.revision }, f.cookies.leader);
  assert.equal(approved.status, 200); assert.equal(approved.data.record.status, "approved");
  async function waitStatus(status) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (f.state.approvalOutbox?.[0].status === status && Object.values(f.state.approvalOutbox[0].deliveries).every(row => row.status !== "sending")) return;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail("Synthetic queue did not reach " + status);
  }
  await waitStatus("uncertain");
  const retry = "/api/approvals/notifications/" + approved.data.notification.id + "/retry";
  assert.equal((await f.request(retry, "POST", {}, f.cookies.admin)).status, 409);
  assert.equal(sends, 1);
  assert.equal((await f.request(retry, "POST", { confirmDuplicateRisk: true }, f.cookies.admin)).status, 200);
  await waitStatus("sent");
  assert.equal(sends, 2); assert.equal(f.state.approvalOutbox[0].attempts, 2);
  const notices = await f.request("/api/approvals/notifications", "GET", undefined, f.cookies.admin);
  assert.doesNotMatch(JSON.stringify(notices.data), /13800000003|deliveries|payload/);
});
test("only administrators can configure regional accounts and regions and a usable phone are mandatory", async t => {
  const f = await fixture(t);
  const body = { username: "newRegional", name: "合成区域经理乙", role: "region_manager", password: "synthetic-account-password", regions: ["华南"], phone: "13800000008" };
  assert.equal((await f.request("/api/auth/users", "POST", body, f.cookies.leader)).status, 403);
  assert.equal((await f.request("/api/auth/users", "POST", { ...body, regions: [] }, f.cookies.admin)).status, 400);
  assert.equal((await f.request("/api/auth/users", "POST", { ...body, phone: "" }, f.cookies.admin)).status, 400);
  const created = await f.request("/api/auth/users", "POST", body, f.cookies.admin);
  assert.equal(created.status, 200); assert.equal(created.data.user.role, "region_manager"); assert.deepEqual(created.data.user.regions, ["华南"]);
  assert.deepEqual(created.data.user.buildings, []);
});
test("independent notification adapter cannot open OTP sending or arbitrary endpoints and sanitizes vendor failures", async () => {
  assert.equal(createApprovalSmsSender({ enabled: false }), null);
  const settings = { enabled: true, accessKeyId: "synthetic-key", accessKeySecret: "synthetic-secret", signName: "合成签名", templateCode: "SMS_TEST" };
  assert.equal(createApprovalSmsSender({ ...settings, endpoint: "https://example.com" }), null);
  let observed;
  const sender = createApprovalSmsSender(settings, { fetchImpl: async (url, options) => { observed = { url: new URL(url), options }; return { ok: true, text: async () => '{"Code":"OK"}' }; } });
  assert.deepEqual(await sender({ phone: "13800000009", parameters: { employee: "合成", type: "调休请假", start: "2026-11-23T09:00", end: "2026-11-23T10:00", hours: "1" } }), { ok: true });
  assert.equal(observed.url.hostname, "dysmsapi.aliyuncs.com"); assert.equal(observed.options.redirect, "error"); assert.match(observed.options.headers.authorization, /^ACS3-HMAC-SHA256 /);
  const failed = createApprovalSmsSender(settings, { fetchImpl: async () => { throw new Error("synthetic-secret phone=13800000009"); } });
  await assert.rejects(failed({ phone: "13800000009", parameters: {} }), error => !/synthetic-secret|13800000009/.test(error.message));
});
