/**
 * 人员导入脚本 — 一键重置并导入默认人员数据
 * 在浏览器控制台执行 ImportData.run() 即可
 */
const ImportData = {
  /** 一键导入 */
  run() {
    // 清空所有数据，让 Store.init() 重新填充默认数据
    const prefix = "personnel_management_";
    const keys = [
      "initialized", "employees", "attendance", "leave_requests",
      "departments", "org_structure", "stats"
    ];
    keys.forEach(k => localStorage.removeItem(prefix + k));
    return { success: true, message: "已清除数据，刷新后将自动导入" };
  }
};
