"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { emptySnapshot, scopedSnapshot, mergeSnapshot } = require(process.env.HR_LEAVE_AUTH_TEST_MODULE || path.join(__dirname, "../server/auth-service"));

const admin = { role: "admin" };
const leader = { role: "leader", employeeId: 1, buildings: ["楼栋A"] };
const member = { role: "user", employeeId: 1, buildings: [] };

function snapshot() {
  return { ...emptySnapshot(), employees: [
    { id: 1, name: "本人测试", phone: "13800000001", building: "楼栋A" },
    { id: 2, name: "其他楼栋测试", building: "楼栋B" },
    { id: 3, name: "同楼栋测试", building: "楼栋A" }
  ] };
}

function leave(overrides = {}) {
  return { id: 101, employeeId: 1, type: "statutoryAnnual", startDate: "2026-11-18T09:05", endDate: "2026-11-18T17:35", days: 1, hours: 0, reason: "合成测试", status: "pending", ...overrides };
}

function add(source, user, record) {
  const incoming = scopedSnapshot(source, user);
  incoming.leaveRequests.push(record);
  return mergeSnapshot(source, incoming, user);
}

test("three new leave types can be submitted by each role without losing minute precision or changing the supplied days", () => {
  for (const user of [admin, leader, member]) {
    for (const type of ["statutoryAnnual", "welfareAnnual", "paidSick"]) {
      const source = snapshot();
      const result = add(source, user, leave({ type }));
      const saved = result.leaveRequests[0];
      assert.equal(saved.type, type);
      assert.equal(saved.startDate, "2026-11-18T09:05");
      assert.equal(saved.endDate, "2026-11-18T17:35");
      assert.equal(saved.days, 1);
      assert.equal(saved.status, "pending");
      assert.deepEqual(source.leaveRequests, []);
    }
  }
});

test("real leap-day and cross-midnight minute ranges are accepted without timezone conversion", () => {
  const result = add(snapshot(), member, leave({ startDate: "2028-02-29T23:59", endDate: "2028-03-01T00:00", days: 2 }));
  assert.equal(result.leaveRequests[0].startDate, "2028-02-29T23:59");
  assert.equal(result.leaveRequests[0].endDate, "2028-03-01T00:00");
  assert.equal(result.leaveRequests[0].days, 2);
});

test("invalid calendar, time, precision and reversed or empty minute ranges are refused before persistence", () => {
  const invalid = [
    { startDate: "2026-02-29T09:00", endDate: "2026-03-01T09:00" },
    { startDate: "2028-02-30T09:00", endDate: "2028-03-01T09:00" },
    { startDate: "2026-13-01T09:00", endDate: "2027-01-01T09:00" },
    { startDate: "0000-01-01T09:00", endDate: "0001-01-01T09:00" },
    { startDate: "2026-11-18T24:00", endDate: "2026-11-19T01:00" },
    { startDate: "2026-11-18T09:60" },
    { endDate: "2026-11-18T17:35:00" },
    { endDate: "2026-11-18T17:35+08:00" },
    { endDate: "2026-11-18T17:35Z" },
    { startDate: "2026-11-18 09:05" },
    { startDate: "2026-11-18" },
    { endDate: "2026-11-18" },
    { endDate: "2026-11-18T09:05" },
    { endDate: "2026-11-18T09:04" },
    { startDate: "2026-02-30", endDate: "2026-03-01" },
    { startDate: null },
    { endDate: [] }
  ];
  for (const user of [admin, leader, member]) {
    for (const range of invalid) {
      const source = snapshot();
      assert.throws(() => add(source, user, leave(range)), error => error.status === 400 && /起止日期或时间/.test(error.message), JSON.stringify(range));
      assert.deepEqual(source.leaveRequests, []);
    }
  }
});

test("legacy annual and sick date-only requests retain their dates and cannot bypass the dedicated approval endpoint", () => {
  for (const type of ["annual", "sick"]) {
    const source = snapshot();
    source.leaveRequests.push(leave({ type, startDate: "2026-11-18", endDate: "2026-11-18" }));
    for (const manager of [admin, leader]) {
      const incoming = scopedSnapshot(source, manager);
      incoming.leaveRequests[0].status = "approved";
      assert.throws(() => mergeSnapshot(source, incoming, manager), error => error.status === 403);
      const result = mergeSnapshot(source, scopedSnapshot(source, manager), manager);
      assert.equal(result.leaveRequests[0].type, type);
      assert.equal(result.leaveRequests[0].status, "pending");
      assert.equal(result.leaveRequests[0].startDate, "2026-11-18");
      assert.equal(result.leaveRequests[0].endDate, "2026-11-18");
    }
    assert.equal(mergeSnapshot(source, scopedSnapshot(source, member), member).leaveRequests[0].startDate, "2026-11-18");
  }
});

test("minute precision leaves employee ownership, approval and building boundaries intact", () => {
  const source = snapshot();
  assert.throws(() => add(source, member, leave({ employeeId: 3 })), error => error.status === 403);
  assert.throws(() => add(source, member, leave({ status: "approved" })), error => error.status === 403);
  assert.throws(() => add(source, leader, leave({ employeeId: 2 })), error => error.status === 403);

  const withOther = { ...snapshot(), leaveRequests: [leave({ id: 202, employeeId: 2, type: "paidSick" })] };
  const result = add(withOther, leader, leave({ type: "welfareAnnual" }));
  assert.deepEqual(result.leaveRequests.find(row => row.id === 202), withOther.leaveRequests[0]);
  assert.equal(result.leaveRequests.find(row => row.id === 101).employeeId, 1);

  const own = add(source, member, leave());
  const edited = scopedSnapshot(own, member);
  edited.leaveRequests[0].startDate = "2026-11-18T09:06";
  assert.throws(() => mergeSnapshot(own, edited, member), error => error.status === 403);
});

test("existing type, day count and compensatory balance validation still applies to minute requests", () => {
  assert.throws(() => add(snapshot(), member, leave({ type: "unrecognized" })), error => error.status === 400 && /请假类型/.test(error.message));
  for (const days of [0, -1, "invalid", 3661]) assert.throws(() => add(snapshot(), member, leave({ days })), error => error.status === 400 && /请假天数/.test(error.message));
  assert.throws(() => add(snapshot(), member, leave({ type: "compensatory", hours: 0 })), error => error.status === 400 && /调休小时/.test(error.message));
  const source = snapshot();
  source.leaveRequests.push(leave({ type: "compensatory", hours: 2 }));
  const incoming = scopedSnapshot(source, leader);
  incoming.leaveRequests[0].status = "approved";
  assert.throws(() => mergeSnapshot(source, incoming, leader), error => error.status === 403 && /审批/.test(error.message));
});
