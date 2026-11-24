"use strict";

// Read-only facts for AI and reports. No prompt, SQL, credentials or mutable state
// belongs in this module; every number is calculated from one supplied revision.
const LEAVE_TYPES = Object.freeze({
  leave: "请假", compensatory: "调休请假", shift: "替班请假",
  statutoryAnnual: "法定年假", welfareAnnual: "福利年假", paidSick: "带薪病假",
  annual: "年假（外包人员）", sick: "病假（外包人员）", personal: "事假",
  marriage: "婚假", maternity: "产假", other: "其他"
});
const DAY = 86400000;
const FILTERS = ["building", "department", "employeeName"];
const UNSUPPORTED = "目前支持授权范围内的人员人数与分布、考勤已有记录、加班、请假及月度、季度、年度报表查询；可使用本月、上月、今年、去年或指定年月、季度。请通过楼栋、部门、人员姓名筛选，不支持个人联系方式、薪资金额、修改数据或任意指令。";

class ReportingError extends Error {
  constructor(status, message) { super(message); this.name = "ReportingError"; this.status = status; }
}
function fail(status, message) { throw new ReportingError(status, message); }
function clean(value) { return typeof value === "string" ? value.trim() : ""; }
function list(value) { return Array.isArray(value) ? value : []; }
function round(value) { return Math.round((value + Number.EPSILON) * 1000000) / 1000000; }
function quantity(value, positive = false) {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value))) return null;
  const number = Number(value);
  return Number.isFinite(number) && number <= Number.MAX_SAFE_INTEGER && (positive ? number > 0 : number >= 0) ? number : null;
}
function wallTime(value, dateOnly = false) {
  if (typeof value !== "string" || !(dateOnly ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?$/).test(value) || value.startsWith("0000")) return null;
  const date = new Date(value.length === 10 ? value + "T00:00:00.000Z" : value + ":00.000Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, value.length) === value ? date.getTime() : null;
}
function instant(now) {
  const result = now === undefined ? new Date() : new Date(now);
  if (!Number.isFinite(result.getTime())) fail(400, "报表生成时间无效");
  return result;
}
function chinaCalendar(now) {
  const date = new Date(instant(now).getTime() + 8 * 60 * 60 * 1000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}
function integer(value, min, max, label) {
  const result = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(result) || result < min || result > max) fail(400, label + "无效");
  return result;
}
function monthStart(year, month) { return String(year).padStart(4, "0") + "-" + String(month).padStart(2, "0") + "-01"; }
function nextMonth(year, month) { return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 }; }
function periodOptions(options, now) {
  const source = options && typeof options === "object" ? options : {};
  const supplied = source.period && typeof source.period === "object" && !Array.isArray(source.period) ? { ...source, ...source.period } : source;
  const current = chinaCalendar(now);
  const type = supplied.periodType || supplied.type || "monthly";
  if (!["monthly", "quarterly", "annual"].includes(type)) fail(400, "报表周期只支持月度、季度、年度");
  const year = integer(supplied.year === undefined ? current.year : supplied.year, 1900, 9998, "年份");
  const month = type === "monthly" ? integer(supplied.month === undefined ? current.month : supplied.month, 1, 12, "月份") : type === "quarterly" ? (integer(supplied.quarter === undefined ? Math.ceil(current.month / 3) : supplied.quarter, 1, 4, "季度") - 1) * 3 + 1 : 1;
  const count = type === "monthly" ? 1 : type === "quarterly" ? 3 : 12;
  let after = { year, month };
  for (let i = 0; i < count; i++) after = nextMonth(after.year, after.month);
  const start = monthStart(year, month), endExclusive = monthStart(after.year, after.month);
  return {
    type, year, ...(type === "monthly" ? { month } : type === "quarterly" ? { quarter: Math.ceil(month / 3) } : {}),
    start, endExclusive, label: type === "monthly" ? year + "年" + month + "月" : type === "quarterly" ? year + "年第" + Math.ceil(month / 3) + "季度" : year + "年度",
    startTime: wallTime(start, true), endTime: wallTime(endExclusive, true), firstMonth: month, months: count
  };
}
function assertActor(actor) {
  if (!actor || !["admin", "leader"].includes(actor.role)) fail(403, "当前账号无权使用AI查询和报表");
}
function filtersFrom(options) {
  const source = options && typeof options === "object" ? options : {};
  const nested = source.filters && typeof source.filters === "object" && !Array.isArray(source.filters) ? source.filters : {};
  const result = {};
  for (const field of FILTERS) {
    const value = Object.prototype.hasOwnProperty.call(nested, field) ? nested[field] : source[field];
    if (value !== undefined && value !== null && value !== "") {
      if (typeof value !== "string" || value.length > 200) fail(400, "报表筛选条件无效");
      if (value.trim()) result[field] = value.trim();
    }
  }
  return result;
}
function scopedEmployees(bundle, actor, filters) {
  assertActor(actor);
  const buildings = actor.role === "leader" ? [...new Set(list(actor.buildings).filter(value => typeof value === "string" && value.trim()).map(value => value.trim()))] : [];
  if (actor.role === "leader" && filters.building && !buildings.includes(filters.building)) fail(403, "筛选条件超出当前授权范围");
  // Scope is established before inspecting names/departments or any business row.
  let employees = list(bundle && bundle.employees).filter(employee => employee && typeof employee === "object" && (actor.role === "admin" || (employee.building && buildings.includes(employee.building))));
  if (filters.building) employees = employees.filter(employee => employee.building === filters.building);
  if (filters.department) employees = employees.filter(employee => employee.department === filters.department);
  if (filters.employeeName) employees = employees.filter(employee => employee.name === filters.employeeName);
  return { employees, buildings };
}
function newQuality() {
  const counts = new Map();
  return {
    add(code, label, number = 1) { counts.set(code, { code, label, count: (counts.get(code)?.count || 0) + number }); },
    rows() { return [...counts.values()].sort((a, b) => a.code.localeCompare(b.code)); }
  };
}
function finalApproved(row) { return row.status === "approved" && (!row.approvalStage || row.approvalStage === "complete"); }
function approval(row, quality, kind) {
  if (finalApproved(row)) return "approved";
  if (row.status === "rejected") return "rejected";
  if (row.status === "pending" && (!row.approvalStage || row.approvalStage === "leader")) return "pendingLeader";
  if (row.status === "pending" && row.approvalStage === "regional") return "pendingRegional";
  quality.add(kind + "InvalidApproval", "审批状态或阶段待核对");
  return row.status === "pending" ? "pendingUnknown" : "otherStatus";
}
function recordRows(bundle, key, ids, quality) {
  const seen = new Set(), result = [];
  for (const row of list(bundle && bundle[key])) {
    if (!row || typeof row !== "object" || !ids.has(row.employeeId)) continue;
    if (!Number.isSafeInteger(row.id) || row.id <= 0 || seen.has(row.id)) { quality.add(key + "InvalidId", "记录编号无效或重复，未计入统计"); continue; }
    seen.add(row.id);
    result.push(row);
  }
  return result;
}
function prepare(bundle, employees, quality) {
  const seen = new Set(), people = [];
  for (const employee of employees) {
    if (!Number.isSafeInteger(employee.id) || employee.id <= 0 || seen.has(employee.id)) { quality.add("employeeInvalidId", "人员编号无效或重复，未计入统计"); continue; }
    seen.add(employee.id);
    const joinDate = clean(employee.joinDate), leaveDate = clean(employee.leaveDate);
    const joined = wallTime(joinDate, true), left = wallTime(leaveDate, true);
    if (!joinDate) quality.add("missingJoinDate", "人员未填写入职日期，无法归属期间入职统计");
    else if (joined === null) quality.add("invalidJoinDate", "入职日期无效，无法归属期间入职统计");
    if (leaveDate && left === null) quality.add("invalidLeaveDate", "离职日期无效，无法归属期间离职统计");
    if (!leaveDate && ["离职", "已离职", "resigned", "terminated", "left"].includes(employee.status)) quality.add("missingLeaveDate", "离职人员未填写离职日期，无法归属期间离职统计");
    people.push({ id: employee.id, name: clean(employee.name), department: clean(employee.department), building: clean(employee.building), status: clean(employee.status), joined, left });
  }
  const ids = new Set(people.map(person => person.id));
  const attendance = [];
  for (const row of recordRows(bundle, "attendance", ids, quality)) {
    const at = wallTime(row.date, true);
    if (at === null) { quality.add("invalidAttendanceDate", "考勤日期无效，未计入期间统计"); continue; }
    const status = ["present", "late", "absent"].includes(row.status) ? row.status : "other";
    if (status === "other") quality.add("unknownAttendanceStatus", "考勤状态待核对");
    attendance.push({ employeeId: row.employeeId, at, status });
  }
  const overtime = [];
  for (const row of recordRows(bundle, "overtime", ids, quality)) {
    const at = wallTime(row.date, true);
    if (at === null) { quality.add("invalidOvertimeDate", "加班日期无效，未计入期间统计"); continue; }
    const hours = quantity(row.hours, true), type = row.overtimeType || "fee";
    if (hours === null) quality.add("invalidOvertimeHours", "加班小时数无效，未计入时长汇总");
    if (!["fee", "compensatory"].includes(type)) quality.add("unknownOvertimeType", "加班类型待核对，未计入分类时长");
    overtime.push({ employeeId: row.employeeId, at, type, hours, approval: approval(row, quality, "overtime") });
  }
  const leaves = [];
  for (const row of recordRows(bundle, "leaveRequests", ids, quality)) {
    const start = wallTime(row.startDate), end = wallTime(row.endDate);
    if (start === null || end === null || row.startDate.length !== row.endDate.length || end < start || (row.startDate.length > 10 && start === end)) { quality.add("invalidLeaveDates", "请假起止日期或精度无效，未计入期间统计"); continue; }
    const hours = quantity(row.hours), days = quantity(row.days, true);
    if (hours === null || (row.type === "compensatory" && !hours)) quality.add("invalidLeaveHours", "请假小时数未填写或无效，未折算补齐");
    if (days === null) quality.add("invalidLeaveDays", "请假天数未填写或无效，未折算补齐");
    const type = Object.prototype.hasOwnProperty.call(LEAVE_TYPES, row.type) ? row.type : "unknown";
    if (type === "unknown") quality.add("unknownLeaveType", "请假类型待核对");
    const endExclusive = end + (row.endDate.length === 10 ? DAY : 0);
    leaves.push({
      id: row.id, employeeId: row.employeeId, type, typeLabel: LEAVE_TYPES[type] || "未识别类型",
      startDate: row.startDate, endDate: row.endDate, start, endExclusive, hours, days,
      approval: approval(row, quality, "leave"),
      crossMonth: new Date(start).toISOString().slice(0, 7) !== new Date(endExclusive - 1).toISOString().slice(0, 7)
    });
  }
  return { people, attendance, overtime, leaves };
}
function approvalTotals() { return { requests: 0, approvedRequests: 0, pendingLeader: 0, pendingRegional: 0, pendingUnknown: 0, rejected: 0, otherStatus: 0 }; }
function addApproval(target, row) {
  target.requests++;
  if (row.approval === "approved") target.approvedRequests++;
  else target[row.approval]++;
}
function contains(at, period) { return at !== null && at >= period.startTime && at < period.endTime; }
function summaryFor(data, period) {
  const result = {
    personnel: { total: data.people.length, joined: 0, left: 0 },
    attendance: { records: 0, employees: 0, statuses: { present: 0, late: 0, absent: 0, other: 0 } },
    overtime: { ...approvalTotals(), feeHours: 0, compensatoryHours: 0 },
    leave: { ...approvalTotals(), hours: 0, days: 0, crossMonthRequests: 0 }
  };
  for (const person of data.people) { if (contains(person.joined, period)) result.personnel.joined++; if (contains(person.left, period)) result.personnel.left++; }
  const attended = new Set();
  for (const row of data.attendance) if (contains(row.at, period)) { result.attendance.records++; result.attendance.statuses[row.status]++; attended.add(row.employeeId); }
  result.attendance.employees = attended.size;
  for (const row of data.overtime) if (contains(row.at, period)) {
    addApproval(result.overtime, row);
    if (row.approval === "approved" && row.hours !== null) {
      if (row.type === "fee") result.overtime.feeHours += row.hours;
      if (row.type === "compensatory") result.overtime.compensatoryHours += row.hours;
    }
  }
  for (const row of data.leaves) if (contains(row.start, period)) {
    addApproval(result.leave, row);
    if (row.crossMonth) result.leave.crossMonthRequests++;
    if (row.approval === "approved") { result.leave.hours += row.hours || 0; result.leave.days += row.days || 0; }
  }
  for (const key of ["feeHours", "compensatoryHours"]) result.overtime[key] = round(result.overtime[key]);
  for (const key of ["hours", "days"]) result.leave[key] = round(result.leave[key]);
  return result;
}
function counts(items, field) {
  const map = new Map();
  for (const item of items) { const label = item[field] || "未填写"; map.set(label, (map.get(label) || 0) + 1); }
  return [...map].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "zh-CN"));
}
function leaveGroups(data, period) {
  const map = new Map();
  for (const row of data.leaves) if (contains(row.start, period)) {
    if (!map.has(row.type)) map.set(row.type, { code: row.type, label: row.typeLabel, count: 0, approvedRequests: 0, hours: 0, days: 0 });
    const group = map.get(row.type); group.count++;
    if (row.approval === "approved") { group.approvedRequests++; group.hours += row.hours || 0; group.days += row.days || 0; }
  }
  return [...map.values()].map(group => ({ ...group, hours: round(group.hours), days: round(group.days) })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}
function exportRows(report) {
  const rows = [];
  function add(section, label, value, unit, month) { rows.push({ section, label, value, unit, ...(month ? { month } : {}) }); }
  function summary(summary, month) {
    add("人员", "当前档案人数（非历史期末人数）", summary.personnel.total, "人", month);
    add("人员", "期间入职", summary.personnel.joined, "人", month); add("人员", "期间离职", summary.personnel.left, "人", month);
    add("考勤", "已有考勤记录人次", summary.attendance.records, "人次", month); add("考勤", "有记录的去重人数", summary.attendance.employees, "人", month);
    for (const [key, label] of Object.entries({ present: "出勤记录", late: "迟到记录", absent: "缺勤记录", other: "其他状态记录" })) add("考勤", label, summary.attendance.statuses[key], "人次", month);
    for (const [key, label] of Object.entries({ requests: "申请数", approvedRequests: "最终批准", pendingLeader: "待楼长审批", pendingRegional: "待区域经理审批", pendingUnknown: "待审批阶段待核对", rejected: "已拒绝", otherStatus: "其他状态待核对" })) {
      add("加班", label, summary.overtime[key], "单", month); add("请假", "开始日期归属·" + label, summary.leave[key], "单", month);
    }
    add("加班", "最终批准费用加班", summary.overtime.feeHours, "小时", month); add("加班", "最终批准调休加班", summary.overtime.compensatoryHours, "小时", month);
    add("请假", "开始日期归属·最终批准已记录小时（未摊分）", summary.leave.hours, "小时", month);
    add("请假", "开始日期归属·最终批准已记录天数（未摊分）", summary.leave.days, "天", month);
    add("请假", "开始日期归属·跨月申请（未摊分）", summary.leave.crossMonthRequests, "单", month);
  }
  summary(report.summary);
  for (const month of report.monthlyBreakdown) summary(month.summary, month.month);
  for (const [key, label] of Object.entries({ statuses: "当前人员状态分布", departments: "当前部门分布", buildings: "当前楼栋分布" })) for (const row of report.groupings[key]) add(label, row.label, row.count, "人");
  for (const group of report.groupings.leaveTypes) { add("开始日期归属·请假类型", group.label + "申请数", group.count, "单"); add("开始日期归属·请假类型", group.label + "最终批准已记录小时", group.hours, "小时"); add("开始日期归属·请假类型", group.label + "最终批准已记录天数", group.days, "天"); }
  add("跨期提示", "上期开始且与本期重叠（未计入本期开始口径汇总）", report.leaveOverlap.overlappingFromPreviousPeriod, "单");
  add("跨期提示", "与本期边界相交的跨期申请（未摊分）", report.leaveOverlap.crossBoundaryRequests, "单");
  for (const row of report.details.leaves) {
    const label = (row.employeeName || "未填写姓名") + " · " + row.typeLabel;
    add("请假原始日期", label, row.startDate + " 至 " + row.endDate, "日期/时间");
    add("请假归属说明", label, (row.attributedToPeriod ? "开始日期归属本期" : "上期开始与本期重叠，不计入开始口径汇总") + (row.crossPeriod ? "；跨期未摊分" : "") + "；" + row.approval, "说明");
  }
  for (const issue of report.dataQuality) add("数据质量（授权筛选后的全部记录）", issue.label, issue.count, "项");
  for (const text of report.methodology) add("统计口径", text, "", "说明");
  return rows;
}

function buildReport(bundle, actor, options = {}, now) {
  assertActor(actor);
  const generatedAt = instant(now).toISOString(), period = periodOptions(options, generatedAt), filters = filtersFrom(options);
  const scoped = scopedEmployees(bundle, actor, filters), quality = newQuality();
  const data = prepare(bundle, scoped.employees, quality), summary = summaryFor(data, period);
  const revision = Number.isSafeInteger(bundle && bundle.revision) && bundle.revision >= 0 ? bundle.revision : 0;
  if (!(Number.isSafeInteger(bundle && bundle.revision) && bundle.revision >= 0)) quality.add("missingRevision", "未提供有效数据版本号");
  const monthlyBreakdown = [];
  for (let i = 0; i < period.months; i++) {
    const month = periodOptions({ periodType: "monthly", year: period.year, month: period.firstMonth + i }, generatedAt);
    monthlyBreakdown.push({ month: month.start.slice(0, 7), label: month.label, summary: summaryFor(data, month) });
  }
  const people = new Map(data.people.map(person => [person.id, person]));
  const overlapping = data.leaves.filter(row => row.start < period.endTime && row.endExclusive > period.startTime);
  const carried = overlapping.filter(row => row.start < period.startTime);
  const details = overlapping.map(row => {
    const employee = people.get(row.employeeId);
    return {
      id: row.id, employeeName: employee.name, department: employee.department, building: employee.building,
      type: row.type, typeLabel: row.typeLabel, startDate: row.startDate, endDate: row.endDate,
      hours: row.hours, days: row.days, approval: row.approval, attributedToPeriod: contains(row.start, period),
      crossPeriod: row.start < period.startTime || row.endExclusive > period.endTime,
      durationBasis: "recorded-unallocated"
    };
  }).sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id - b.id);
  const { startTime, endTime, firstMonth, months, ...publicPeriod } = period;
  const report = {
    schemaVersion: 1, mode: "facts", scope: { role: actor.role, buildings: actor.role === "leader" ? scoped.buildings : [...new Set(data.people.map(person => person.building).filter(Boolean))].sort(), filters, employeeCount: data.people.length },
    period: publicPeriod, revision, generatedAt, summary, monthlyBreakdown,
    groupings: { statuses: counts(data.people, "status"), departments: counts(data.people, "department"), buildings: counts(data.people, "building"), leaveTypes: leaveGroups(data, period) },
    leaveOverlap: { overlappingFromPreviousPeriod: carried.length, approvedOverlappingFromPreviousPeriod: carried.filter(row => row.approval === "approved").length, crossBoundaryRequests: details.filter(row => row.crossPeriod).length, allocation: "unallocated" },
    dataQuality: quality.rows(),
    methodology: [
      "所有事实来自同一服务器数据版本；楼长仅统计当前授权楼栋关联人员，不代表历史人员归属。",
      "人员总数和分布为当前档案存量，不能作为历史期末人数；期间入职、离职只按已填写且有效的对应日期统计。",
      "考勤按实际已有记录统计人次及去重人数；缺少工作日、排班与应出勤基数，不计算应出勤率。",
      "加班按发生日期归属，仅最终批准（含无审批阶段字段的历史已批准记录）计入费用/调休小时；待批、拒绝和异常审批状态均不计入已批准时长。",
      "请假按开始日期一次归属，完整汇总该申请已记录的小时与天数，两种单位分别展示、不相互换算。跨期申请列明原始日期/分钟与未摊分提示，不按8小时/日或工作日分摊。",
      "与本期重叠但开始于上期的请假单独列示，不再计入本期申请、已批准小时或天数；日期精度记录结束日按包含当日处理，分钟精度按结束时刻截止。",
      "季度/年度各月的入离职、记录人次、申请数量和开始口径时长可相加；当前档案人数为存量，有考勤记录人数为去重人数，均不可把月值相加。跨本报告边界指标是单独提示。",
      "不计算薪资、单价或费用金额；费用加班表示已批准小时，不代表已结算金额。数据质量提示基于授权且筛选后的全部记录，日期无效的记录无法归属期间。"
    ],
    details: { leaves: details }
  };
  report.exportRows = exportRows(report);
  return report;
}

function naturalPeriod(question, now) {
  const current = chinaCalendar(now);
  let rest = question, period = null;
  const matches = [];
  function take(pattern, convert) {
    rest = rest.replace(pattern, (...parts) => { matches.push(convert(parts)); return " "; });
  }
  take(/(\d{4})年\s*第?([一二三四1234])季度/g, part => ({ periodType: "quarterly", year: Number(part[1]), quarter: "一二三四".includes(part[2]) ? "一二三四".indexOf(part[2]) + 1 : Number(part[2]) }));
  take(/(\d{4})[年\-/](\d{1,2})月?/g, part => ({ periodType: "monthly", year: Number(part[1]), month: Number(part[2]) }));
  take(/(今年|去年|本年|上年)?\s*第?([一二三四1234])季度/g, part => ({ periodType: "quarterly", year: current.year - (["去年", "上年"].includes(part[1]) ? 1 : 0), quarter: "一二三四".includes(part[2]) ? "一二三四".indexOf(part[2]) + 1 : Number(part[2]) }));
  take(/(今年|去年|本年|上年)?\s*(\d{1,2})月/g, part => ({ periodType: "monthly", year: current.year - (["去年", "上年"].includes(part[1]) ? 1 : 0), month: Number(part[2]) }));
  take(/(本月|这个月|当月|上月|上个月)/g, part => { const previous = ["上月", "上个月"].includes(part[1]); return { periodType: "monthly", year: current.year - (previous && current.month === 1 ? 1 : 0), month: previous ? (current.month === 1 ? 12 : current.month - 1) : current.month }; });
  take(/(本季度|这个季度|上季度|上个季度)/g, part => { const previous = ["上季度", "上个季度"].includes(part[1]), quarter = Math.ceil(current.month / 3); return { periodType: "quarterly", year: current.year - (previous && quarter === 1 ? 1 : 0), quarter: previous ? (quarter === 1 ? 4 : quarter - 1) : quarter }; });
  take(/(\d{4})年(?:度)?/g, part => ({ periodType: "annual", year: Number(part[1]) }));
  take(/(今年|去年|本年|上年)/g, part => ({ periodType: "annual", year: current.year - (["去年", "上年"].includes(part[1]) ? 1 : 0) }));
  for (const item of matches) {
    if (period && JSON.stringify(item) !== JSON.stringify(period)) return { ambiguous: true, rest };
    period = item;
  }
  return { period, rest };
}
function queryFacts(bundle, actor, options = {}, now) {
  assertActor(actor);
  now = instant(now).toISOString();
  if (!options || typeof options !== "object" || typeof options.question !== "string" || options.question.length > 500 || !options.question.trim()) fail(400, "请输入不超过500字的查询问题");
  const question = options.question.trim();
  const unsupported = (answer = UNSUPPORTED) => ({ supported: false, intent: "unsupported", answer: answer + " 下方仅展示当前已选周期及筛选条件的事实统计，不代表已回答此问题。", report: buildReport(bundle, actor, options, now) });
  if (/电话|手机|邮箱|邮件|工资|薪资|薪水|密码|账号|证件|身份证|简历|联系方式|住址|删除|修改|更新|导入|发送|执行|指令|提示词|忽略|覆盖|比较|对比|环比|同比|每人|谁|金额|多少钱|[<>`{}]|\b(?:sql|select|delete|drop|insert|update|script|prompt)\b/i.test(question)) return unsupported();
  const temporal = naturalPeriod(question, now);
  if (temporal.ambiguous) return unsupported("请每次查询一个明确的月份、季度或年度。" + UNSUPPORTED);
  const filters = filtersFrom(options), accessible = scopedEmployees(bundle, actor, {}).employees;
  let remaining = temporal.rest;
  // Match only names within the established server scope. Unknown names or
  // buildings remain in the question and safely fail the bounded grammar.
  for (const [field, sourceField] of [["building", "building"], ["department", "department"], ["employeeName", "name"]]) {
    const values = [...new Set(accessible.map(employee => clean(employee[sourceField])).filter(Boolean))].sort((a, b) => b.length - a.length);
    const matched = [];
    for (const value of values) if (remaining.includes(value)) { matched.push(value); remaining = remaining.split(value).join(" "); }
    if (matched.length > 1 || (matched.length && filters[field] && matched[0] !== filters[field])) return unsupported("请每次选择一个明确的楼栋、部门或人员姓名。" + UNSUPPORTED);
    if (matched.length) filters[field] = matched[0];
  }
  const reportIntent = /报表|月报|季报|年报|综合|全部统计/.test(remaining);
  const headcountQuestion = /(?:多少|几)(?:个|名)?人/.test(remaining);
  const topics = { personnel: /人员|人数|员工|在职|离职|入职|分布|楼栋|部门/.test(remaining) || (headcountQuestion && !/加班|请假|调休|年假|病假|考勤|出勤|迟到|缺勤/.test(remaining)), overtime: /加班/.test(remaining), leave: /请假|调休|年假|病假/.test(remaining.replace(/调休加班/g, "")), attendance: /考勤|出勤|迟到|缺勤/.test(remaining) };
  const active = Object.entries(topics).filter(([, value]) => value).map(([key]) => key);
  const intent = reportIntent || active.length > 1 ? "report" : active[0];
  if (!intent) return unsupported();
  // Deliberately finite natural-language grammar: an unrecognised person/scope
  // must never silently turn into a report over the rest of the visible people.
  remaining = remaining.replace(/(?:请假申请|加班申请|福利年假|法定年假|带薪病假|费用加班|调休加班|人员姓名|人员人数|所有人员|全部人员|当前人员|本楼栋|当前楼栋|自己楼栋|总人数|人员|人数|员工|在职|离职|入职|分布|楼栋|部门|加班|请假|调休|年假|病假|考勤|出勤|迟到|缺勤|报表|月报|季报|年报|月度|年度|综合|全部统计|待楼长审批|待区域经理审批|待审批|已批准|最终批准|拒绝|申请|记录|小时数|小时|时长|天数|数量|汇总|统计|情况|明细|总共|一共有|一共|共有|有多少|多少|几个人|几人|几个|几名|几单|几条|几天|多久|多长时间|请帮我|帮我|请|查询|查一下|查下|查看|看一下|一下|生成|显示|看看|我想看|我要看|各个|分别|按照|现在|我们|系统|我|本|当前|全部|所有|各|按|以|的|中|在|有|和|与|及|人|名|个|单|条|吗|呢|是|季度|年|月|栋|号楼|楼)/g, " ").replace(/[\s，。！？、：:；;（）()“”‘’"'\/\-]+/g, "");
  if (remaining) return unsupported();
  const period = temporal.period || (reportIntent && /年报|年度报表/.test(question) ? { periodType: "annual", year: chinaCalendar(now).year } : reportIntent && /季报|季度报表/.test(question) ? { periodType: "quarterly", year: chinaCalendar(now).year, quarter: Math.ceil(chinaCalendar(now).month / 3) } : {});
  const report = buildReport(bundle, actor, { ...options, ...period, period: period.periodType ? undefined : options.period, filters }, now);
  const summary = report.summary;
  const lead = report.period.label + "，当前授权筛选范围内";
  let answer;
  if (intent === "personnel") answer = lead + "当前档案" + summary.personnel.total + "人；期间入职" + summary.personnel.joined + "人、离职" + summary.personnel.left + "人。人员分布见事实表，当前档案人数不代表历史期末人数。";
  else if (intent === "attendance") answer = lead + "已有考勤记录" + summary.attendance.records + "人次，涉及" + summary.attendance.employees + "名人员；出勤记录" + summary.attendance.statuses.present + "人次、迟到" + summary.attendance.statuses.late + "人次、缺勤" + summary.attendance.statuses.absent + "人次。缺少应出勤基数，不计算应出勤率。";
  else if (intent === "overtime") answer = lead + "加班申请" + summary.overtime.requests + "单；最终批准费用加班" + summary.overtime.feeHours + "小时、调休加班" + summary.overtime.compensatoryHours + "小时；待楼长" + summary.overtime.pendingLeader + "单、待区域经理" + summary.overtime.pendingRegional + "单、拒绝" + summary.overtime.rejected + "单。";
  else if (intent === "leave") {
    const type = Object.entries(LEAVE_TYPES).filter(([code]) => !["leave", "other"].includes(code)).sort((a, b) => b[1].length - a[1].length).find(([, label]) => question.includes(label));
    const group = type ? report.groupings.leaveTypes.find(row => row.code === type[0]) || { count: 0, hours: 0, days: 0 } : null;
    answer = lead + "按开始日期归属的" + (type ? type[1] : "请假") + "申请" + (group ? group.count : summary.leave.requests) + "单；最终批准已记录" + (group ? group.hours : summary.leave.hours) + "小时、" + (group ? group.days : summary.leave.days) + "天（分别汇总，不互相换算）。全部类型请假中，上期开始与本期重叠" + report.leaveOverlap.overlappingFromPreviousPeriod + "单单独列示，跨期未摊分。";
  }
  else answer = lead + "已生成事实报表：当前档案" + summary.personnel.total + "人、已有考勤" + summary.attendance.records + "人次、加班申请" + summary.overtime.requests + "单、开始日期归属的请假申请" + summary.leave.requests + "单。全部数值由服务器统计；请查看分项、跨期说明与数据质量提示。";
  return { supported: true, intent, answer, report };
}

module.exports = { ReportingError, LEAVE_TYPES, buildReport, queryFacts };
