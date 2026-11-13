"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");

const PHONE = /^1[3-9]\d{9}$/;
const CHALLENGE = /^[a-f0-9]{64}$/;
const CODE = /^\d{6}$/;
const TTL = 5 * 60 * 1000;
const COOLDOWN = 60 * 1000;
const WINDOW = 10 * 60 * 1000;
const MAX_ERRORS = 5;
const MAX_PHONE_DAY = 10;
const MAX_IP_WINDOW = 5;
const MAX_IP_DAY = 50;
const MAX_TOTAL_DAY = 200;
const UNAVAILABLE = "短信验证服务暂不可用，请稍后重试";
const INVALID = "验证码无效或已过期，请重新获取";

class SmsVerificationError extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.status = status;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}
function fail(status, message, retryAfter) { throw new SmsVerificationError(status, message, retryAfter); }
function dayAt(time) { return new Date(time + 8 * 60 * 60 * 1000).toISOString().slice(0, 10); }
function dailyRetryAfter(day, time) { return Math.max(0, Math.min(86400, Math.ceil((Date.parse(day + "T00:00:00+08:00") + 86400000 - time) / 1000))); }
function fingerprint(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function context(phone, purpose) {
  if (typeof phone !== "string" || !PHONE.test(phone) || !["register", "login"].includes(purpose)) fail(400, "请输入有效手机号并选择注册或登录用途");
  return fingerprint(phone) + ":" + purpose;
}
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function plain(value) { return !!value && typeof value === "object" && !Array.isArray(value); }

// The existing application uses one Node.js process. All disk reservations below
// run synchronously before the first await, including across factory instances.
// Challenge records and the HMAC key stay in memory; a restart invalidates codes
// while the persisted counters retain delivery quotas and resend cooldowns.
function createSmsVerification({ dataDir, enabled = false, sendCode, now = Date.now, random = crypto.randomInt } = {}) {
  const required = !!enabled;
  const configured = typeof sendCode === "function";
  const directory = dataDir ? path.resolve(dataDir) : null;
  const rateFile = directory && path.join(directory, "sms-rate-limits.json");
  const secret = crypto.randomBytes(32);
  const records = new Map(), latest = new Map(), tickets = new WeakMap();

  function available() {
    if (!required || !configured || !directory) fail(503, UNAVAILABLE);
  }
  function clock() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0 || value > 8e15) fail(503, UNAVAILABLE);
    return value;
  }
  function digest(id, phone, purpose, code) {
    return crypto.createHmac("sha256", secret).update(JSON.stringify([id, phone, purpose, code])).digest();
  }
  function remove(record) {
    if (records.get(record.id) === record) records.delete(record.id);
    if (latest.get(record.key) === record.id) latest.delete(record.key);
  }
  function prune(time) {
    for (const record of records.values()) if (record.expires <= time) remove(record);
  }
  function safeDirectory() {
    let current = path.parse(directory).root;
    for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const info = fs.lstatSync(current, { throwIfNoEntry: false });
      if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("Unsafe data path");
    }
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  function readRates(time) {
    const info = fs.lstatSync(rateFile, { throwIfNoEntry: false });
    if (!info) return { schemaVersion: 1, day: dayAt(time), updatedAt: time, total: 0, phones: {}, ips: {} };
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error("Invalid SMS counters");
    const value = JSON.parse(fs.readFileSync(rateFile, "utf8"));
    if (!plain(value) || value.schemaVersion !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(value.day) || !integer(value.updatedAt) || !integer(value.total) || !plain(value.phones) || !plain(value.ips)) throw new Error("Invalid SMS counters");
    for (const [type, entries] of [["phones", value.phones], ["ips", value.ips]]) {
      if (Object.keys(entries).length > 5000) throw new Error("Oversized SMS counters");
      for (const [key, entry] of Object.entries(entries)) {
        if (!/^[a-f0-9]{64}$/.test(key) || !plain(entry) || !/^\d{4}-\d{2}-\d{2}$/.test(entry.day) || !integer(entry.count)) throw new Error("Invalid SMS counters");
        if (type === "phones" ? !integer(entry.nextAllowed) : !integer(entry.windowStart) || !integer(entry.windowCount)) throw new Error("Invalid SMS counters");
      }
    }
    return value;
  }
  function writeRates(value) {
    const temporary = rateFile + "." + crypto.randomBytes(12).toString("hex") + ".tmp";
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(value));
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor); descriptor = undefined;
      fs.renameSync(temporary, rateFile);
      if (process.platform !== "win32") {
        const handle = fs.openSync(directory, "r");
        try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  function reserve(phone, ip, time) {
    try {
      safeDirectory();
      const state = readRates(time);
      // Counter time never moves backwards across a restart or clock adjustment.
      time = Math.max(time, state.updatedAt);
      const day = dayAt(time);
      if (state.day !== day) { state.day = day; state.total = 0; }
      for (const [key, entry] of Object.entries(state.phones)) if (entry.day !== day && entry.nextAllowed <= time) delete state.phones[key];
      for (const [key, entry] of Object.entries(state.ips)) if (entry.day !== day && entry.windowStart + WINDOW <= time) delete state.ips[key];
      const phoneKey = fingerprint(phone), ipKey = fingerprint(ip);
      const phoneState = state.phones[phoneKey] || { day, count: 0, nextAllowed: 0 };
      const ipState = state.ips[ipKey] || { day, count: 0, windowStart: time, windowCount: 0 };
      if (phoneState.day !== day) { phoneState.day = day; phoneState.count = 0; }
      if (ipState.day !== day) { ipState.day = day; ipState.count = 0; }
      if (ipState.windowStart + WINDOW <= time) { ipState.windowStart = time; ipState.windowCount = 0; }
      if (phoneState.nextAllowed > time) fail(429, "验证码发送过于频繁，请稍后重试", Math.ceil((phoneState.nextAllowed - time) / 1000));
      if (state.total >= MAX_TOTAL_DAY || phoneState.count >= MAX_PHONE_DAY || ipState.count >= MAX_IP_DAY) fail(429, "今日短信次数已达上限，请明日重试", dailyRetryAfter(day, time));
      if (ipState.windowCount >= MAX_IP_WINDOW) fail(429, "验证码发送过于频繁，请稍后重试", Math.ceil((ipState.windowStart + WINDOW - time) / 1000));
      phoneState.count++; phoneState.nextAllowed = time + COOLDOWN;
      ipState.count++; ipState.windowCount++;
      state.phones[phoneKey] = phoneState; state.ips[ipKey] = ipState;
      state.total++; state.updatedAt = time;
      writeRates(state);
      return phoneState.nextAllowed;
    } catch (error) {
      if (error instanceof SmsVerificationError) throw error;
      fail(503, UNAVAILABLE);
    }
  }
  async function requestCode({ phone, purpose, ip } = {}) {
    available();
    const key = context(phone, purpose);
    if (typeof ip !== "string" || !net.isIP(ip) || ip.length > 64) fail(400, "请求来源无效");
    const time = clock();
    prune(time);
    const number = random(0, 1000000);
    if (!Number.isInteger(number) || number < 0 || number >= 1000000) fail(503, UNAVAILABLE);
    const code = String(number).padStart(6, "0");
    const nextAllowed = reserve(phone, ip, time);
    const previous = records.get(latest.get(key));
    if (previous) remove(previous);
    const id = crypto.randomBytes(32).toString("hex");
    const record = { id, key, digest: digest(id, phone, purpose, code), errors: 0, expires: time + TTL, ready: false };
    records.set(id, record); latest.set(key, id);
    try {
      await sendCode({ phone, code, purpose });
      const sentAt = clock();
      if (records.get(id) !== record || record.expires <= sentAt) { remove(record); fail(503, UNAVAILABLE); }
      record.ready = true;
      record.expires = sentAt + TTL;
      return { challengeId: id, expiresIn: TTL / 1000, retryAfter: COOLDOWN / 1000 };
    } catch (_) {
      remove(record);
      let current;
      try { current = clock(); } catch (_) { current = time; }
      fail(503, UNAVAILABLE, Math.max(0, Math.min(86400, Math.ceil((nextAllowed - current) / 1000))));
    }
  }
  // The caller must execute verify -> business write/session -> consume inside
  // its authentication transaction queue. Failed business writes do not consume.
  function verify({ phone, purpose, challengeId, code } = {}) {
    available();
    const key = context(phone, purpose), time = clock();
    prune(time);
    const record = typeof challengeId === "string" && CHALLENGE.test(challengeId) ? records.get(challengeId) : null;
    if (!record || !record.ready || record.key !== key || latest.get(key) !== record.id) fail(400, INVALID);
    if (typeof code !== "string" || !CODE.test(code) || !crypto.timingSafeEqual(record.digest, digest(record.id, phone, purpose, code))) {
      if (++record.errors >= MAX_ERRORS) remove(record);
      fail(400, INVALID);
    }
    const ticket = Object.freeze(Object.create(null));
    tickets.set(ticket, record);
    return ticket;
  }
  function consume(ticket) {
    const record = tickets.get(ticket);
    if (!record) return;
    tickets.delete(ticket);
    if (records.get(record.id) === record) remove(record);
  }
  return { required, configured, requestCode, verify, consume };
}

module.exports = { createSmsVerification, SmsVerificationError };
