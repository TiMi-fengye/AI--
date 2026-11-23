"use strict";

const crypto = require("node:crypto");
const HOST = "dysmsapi.aliyuncs.com", ENDPOINT = "https://" + HOST + "/";
const PHONE = /^1[3-9]\d{9}$/;
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
function createApprovalSmsSender(config = {}, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  if (config.enabled !== true || !/^[A-Za-z0-9_.-]+$/.test(config.accessKeyId || "") || !config.accessKeySecret || !config.signName || !/^SMS_[A-Za-z0-9_]+$/.test(config.templateCode || "") || (config.endpoint && config.endpoint !== ENDPOINT) || typeof fetchImpl !== "function") return null;
  return async ({ phone, parameters }) => {
    if (!PHONE.test(phone) || !parameters || Object.keys(parameters).some(key => !["employee", "type", "start", "end", "hours"].includes(key))) throw new Error("Approval notification parameters invalid");
    const query = { PhoneNumbers: phone, SignName: config.signName, TemplateCode: config.templateCode, TemplateParam: JSON.stringify(parameters) };
    const headers = { host: HOST, "x-acs-action": "SendSms", "x-acs-content-sha256": digest(""), "x-acs-date": new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), "x-acs-signature-nonce": crypto.randomUUID(), "x-acs-version": "2017-05-25" };
    if (config.securityToken) headers["x-acs-security-token"] = config.securityToken;
    const canonicalQuery = Object.keys(query).sort().map(key => encode(key) + "=" + encode(query[key])).join("&");
    const signed = Object.keys(headers).sort();
    const canonicalHeaders = signed.map(key => key + ":" + String(headers[key]).trim() + "\n").join("");
    const request = ["POST", "/", canonicalQuery, canonicalHeaders, signed.join(";"), digest("")].join("\n");
    const signature = crypto.createHmac("sha256", config.accessKeySecret).update("ACS3-HMAC-SHA256\n" + digest(request)).digest("hex");
    headers.authorization = "ACS3-HMAC-SHA256 Credential=" + config.accessKeyId + ",SignedHeaders=" + signed.join(";") + ",Signature=" + signature;
    const controller = new AbortController();
    let timer;
    try {
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Approval SMS outcome unknown")); }, timeoutMs); });
      return await Promise.race([(async () => {
        const response = await fetchImpl(ENDPOINT + "?" + canonicalQuery, { method: "POST", headers, redirect: "error", signal: controller.signal });
        if (!response || !response.ok) throw new Error();
        const text = await response.text();
        if (text.length > 65536 || JSON.parse(text).Code !== "OK") throw new Error();
        return { ok: true };
      })(), deadline]);
    } catch (_) { throw new Error("审批短信发送结果不确定，请核对后再重试"); }
    finally { clearTimeout(timer); }
  };
}

async function deliverEvent(event, accounts, sender, persist, now = () => new Date().toISOString()) {
  const block = reason => { event.status = "blocked"; event.reason = reason; event.updatedAt = now(); };
  if (!sender) { block("sms_not_configured"); await persist(); return event; }
  const recipients = Object.entries(accounts).filter(([, user]) => user.role === "region_manager" && Array.isArray(user.regions) && user.regions.includes(event.region));
  if (!recipients.length) { block("no_region_manager"); await persist(); return event; }
  for (const [username, user] of recipients) {
    const previous = event.deliveries[username];
    if (previous && ["sent", "uncertain", "sending"].includes(previous.status)) continue;
    if (!PHONE.test(user.phone || "")) { event.deliveries[username] = { status: "blocked", reason: "manager_phone_missing" }; continue; }
    // Persist before I/O: a crash after provider acceptance must never auto-resend.
    event.deliveries[username] = { status: "sending" }; event.status = "uncertain"; event.reason = "delivery_unknown"; event.attempts++; event.updatedAt = now();
    await persist();
    try {
      if (accounts[username] !== user || user.role !== "region_manager" || !Array.isArray(user.regions) || !user.regions.includes(event.region)) {
        event.deliveries[username] = { status: "blocked", reason: "manager_scope_changed" };
        continue;
      }
      const result = await sender({ phone: user.phone, parameters: event.payload });
      if (!result || result.ok !== true) throw new Error();
      event.deliveries[username] = { status: "sent", at: now() };
    } catch (_) { event.deliveries[username] = { status: "uncertain", reason: "delivery_unknown" }; }
    event.updatedAt = now(); await persist();
  }
  const deliveries = recipients.map(([username]) => event.deliveries[username] || {});
  event.status = deliveries.every(row => row.status === "sent") ? "sent" : deliveries.some(row => ["uncertain", "sending"].includes(row.status)) ? "uncertain" : "blocked";
  event.reason = event.status === "sent" ? "" : event.status === "uncertain" ? "delivery_unknown" : (deliveries.find(row => row.reason) || {}).reason || "manager_phone_missing";
  event.updatedAt = now(); await persist(); return event;
}
module.exports = { createApprovalSmsSender, deliverEvent };
