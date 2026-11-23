"use strict";

const { isDeepStrictEqual } = require("node:util");
const crypto = require("node:crypto");
const REGIONAL_LEAVE = new Set(["statutoryAnnual", "welfareAnnual", "paidSick"]);
const NOTICE_LEAVE = new Set(["compensatory", "shift"]);
const BUSINESS = {
  overtime: ["employeeId", "date", "hours", "reason", "overtimeType"],
  leaveRequests: ["employeeId", "type", "startDate", "endDate", "days", "hours", "reason"]
};
class ApprovalError extends Error { constructor(status, message) { super(message); this.status = status; } }
function reject(status, message) { throw new ApprovalError(status, message); }
function stage(record) { return record.status === "pending" ? record.approvalStage || "leader" : "complete"; }
function requiresRegional(kind, record) { return kind === "overtime" || REGIONAL_LEAVE.has(record.type); }
function business(record, kind) {
  return Object.fromEntries(BUSINESS[kind].map(key => [key, key === "reason" ? record[key] || "" : key === "overtimeType" ? record[key] || "fee" : ["hours", "days"].includes(key) ? Number(record[key]) || 0 : record[key]]));
}

function protectSnapshot(current, input) {
  const incoming = structuredClone(input);
  delete incoming.approvalOutbox;
  if (Array.isArray(current.approvalOutbox)) incoming.approvalOutbox = structuredClone(current.approvalOutbox);
  for (const kind of Object.keys(BUSINESS)) {
    if (!Array.isArray(incoming[kind])) continue;
    const existing = new Map((current[kind] || []).map(record => [record.id, record]));
    incoming[kind] = incoming[kind].map(record => {
      const old = existing.get(record && record.id);
      if (!old) {
        if (!record || record.status !== "pending" || record.approvalRegion !== undefined || (record.approvalStage !== undefined && record.approvalStage !== "leader") || (record.approvalHistory !== undefined && (!Array.isArray(record.approvalHistory) || record.approvalHistory.length))) reject(403, "新申请必须从楼长待审批开始");
        return { ...record, approvalStage: "leader", approvalHistory: [] };
      }
      if (record.status !== old.status || !isDeepStrictEqual(record.approvalStage, old.approvalStage) || !isDeepStrictEqual(record.approvalHistory, old.approvalHistory) || record.approvalRegion !== old.approvalRegion) reject(403, "请通过审批操作处理申请，不能直接修改审批状态");
      if ((old.status !== "pending" || stage(old) !== "leader") && !isDeepStrictEqual(business(record, kind), business(old, kind))) reject(403, "已进入区域审批或已完成的申请不能修改业务内容");
      return record;
    });
  }
  return incoming;
}

function transition(snapshot, kind, id, actor, decision, now = new Date().toISOString()) {
  if (!Object.hasOwn(BUSINESS, kind) || !["approved", "rejected"].includes(decision)) reject(400, "审批参数无效");
  const record = snapshot[kind].find(row => row.id === id);
  if (!record) reject(404, "申请不存在");
  const employee = snapshot.employees.find(row => row.id === record.employeeId);
  if (!employee) reject(400, "人员资料不存在，请联系管理员核对");
  if (record.status !== "pending") reject(409, "申请已经处理，请刷新后重试");
  const currentStage = stage(record);
  if (!["leader", "regional"].includes(currentStage)) reject(409, "审批阶段无效，请联系管理员");
  if (currentStage === "regional" && record.approvalRegion !== employee.region) reject(409, "初审后人员区域发生变化，请联系管理员核对");
  if (actor.role !== "admin") {
    if (currentStage === "leader" && !(actor.role === "leader" && employee.building && (actor.buildings || []).includes(employee.building))) reject(403, "仅负责楼栋的楼长可进行初审");
    if (currentStage === "regional" && !(actor.role === "region_manager" && employee.region && (actor.regions || []).includes(employee.region))) reject(403, "仅负责区域的区域经理可进行终审");
  }
  if (decision === "approved" && (requiresRegional(kind, record) || (kind === "leaveRequests" && NOTICE_LEAVE.has(record.type))) && !String(employee.region || "").trim()) reject(400, "请先联系管理员为该人员设置所属区域");
  const next = structuredClone(snapshot), updated = next[kind].find(row => row.id === id);
  const final = decision === "rejected" || currentStage === "regional" || !requiresRegional(kind, record);
  updated.status = final ? decision : "pending";
  updated.approvalStage = final ? "complete" : "regional";
  if (currentStage === "leader" && requiresRegional(kind, record)) updated.approvalRegion = employee.region;
  updated.approvalHistory = (record.approvalHistory || []).concat({ stage: currentStage, decision, actorId: crypto.createHash("sha256").update(String(actor.username || "")).digest("hex"), name: actor.name || "", role: actor.role, at: now });
  let notification = null;
  if (decision === "approved" && currentStage === "leader" && kind === "leaveRequests" && NOTICE_LEAVE.has(record.type)) {
    notification = { id: crypto.randomUUID(), kind, recordId: id, employeeId: employee.id, region: employee.region, status: "pending", reason: "", attempts: 0, createdAt: now, updatedAt: now,
      payload: { employee: employee.name || "", type: record.type === "shift" ? "替班请假" : "调休请假", start: record.startDate, end: record.endDate, hours: String(record.hours || 0) }, deliveries: {} };
    next.approvalOutbox = (next.approvalOutbox || []).concat(notification);
  }
  next.revision = (snapshot.revision || 0) + 1;
  next.settlements = [];
  return { snapshot: next, record: updated, notification };
}

function publicNotification(event) {
  return { id: event.id, kind: event.kind, recordId: event.recordId, status: event.status, reason: event.reason || "", attempts: event.attempts || 0, createdAt: event.createdAt, updatedAt: event.updatedAt };
}
module.exports = { ApprovalError, stage, transition, protectSnapshot, publicNotification, requiresRegional };
