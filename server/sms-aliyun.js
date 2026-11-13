"use strict";

const crypto = require("node:crypto");

// Official protocol and SendSms request location were checked on 2026-11-12:
// https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature
// https://help.aliyun.com/zh/sms/developer-reference/api-dysmsapi-2017-05-25-sendsms
const HOST = "dysmsapi.aliyuncs.com";
const ENDPOINT = "https://" + HOST + "/";
const ALGORITHM = "ACS3-HMAC-SHA256";
const ERROR_MESSAGE = "短信发送暂不可用，请稍后重试或联系管理员";
const PHONE = /^1[3-9]\d{9}$/;

class SmsProviderError extends Error {
  constructor(status = 502, message = ERROR_MESSAGE) {
    super(message);
    this.name = "SmsProviderError";
    this.status = status;
  }
}

function digest(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function encode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => "%" + character.charCodeAt(0).toString(16).toUpperCase());
}

// Exported for the official fixed-parameter signing vector, not for HTTP routing.
// No I/O occurs here; the sender below fixes the host, action and path.
function signAliyunRequest({ accessKeyId, accessKeySecret, headers, query, method = "POST", canonicalUri = "/", body = "" }) {
  const canonicalQuery = Object.keys(query).sort().map(key => encode(key) + "=" + encode(query[key])).join("&");
  const signedHeaders = Object.keys(headers).map(key => key.toLowerCase()).sort();
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value).trim()]));
  const canonicalHeaders = signedHeaders.map(key => key + ":" + normalized[key] + "\n").join("");
  const payloadHash = digest(body);
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders.join(";"), payloadHash].join("\n");
  const stringToSign = ALGORITHM + "\n" + digest(canonicalRequest);
  const signature = crypto.createHmac("sha256", accessKeySecret).update(stringToSign, "utf8").digest("hex");
  return {
    canonicalQuery,
    authorization: ALGORITHM + " Credential=" + accessKeyId + ",SignedHeaders=" + signedHeaders.join(";") + ",Signature=" + signature
  };
}

function text(value, max = 256) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? value.trim() : "";
}

function configuration(value) {
  if (!value || value.enabled !== true || (value.provider !== undefined && value.provider !== "aliyun")) return null;
  // No configurable URL, redirect, proxy or arbitrary third-party destination.
  if (value.endpoint !== undefined && ![HOST, ENDPOINT, ENDPOINT.slice(0, -1)].includes(value.endpoint)) return null;
  const accessKeyId = text(value.accessKeyId);
  const accessKeySecret = text(value.accessKeySecret, 2048);
  const signName = text(value.signName, 128);
  const templateCode = text(value.templateCode);
  const templateParamKey = value.templateParamKey === undefined ? "code" : text(value.templateParamKey, 64);
  const securityToken = value.securityToken === undefined || value.securityToken === "" ? "" : text(value.securityToken, 16384);
  if (!/^[A-Za-z0-9_.-]+$/.test(accessKeyId) || !accessKeySecret || !signName || !/^SMS_[A-Za-z0-9_]+$/.test(templateCode)) return null;
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(templateParamKey) || ["constructor", "prototype"].includes(templateParamKey)) return null;
  if (value.securityToken && (!securityToken || !/^[\x21-\x7e]+$/.test(securityToken))) return null;
  return { accessKeyId, accessKeySecret, signName, templateCode, templateParamKey, securityToken };
}

function createAliyunSmsSender(config, { fetchImpl = globalThis.fetch, now = Date.now, nonce = crypto.randomUUID, timeoutMs = 10000 } = {}) {
  const settings = configuration(config);
  if (!settings || typeof fetchImpl !== "function") return null;
  // timeoutMs is an adapter test hook, not a user-supplied request parameter.
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) return null;
  return async function sendCode({ phone, code, purpose } = {}) {
    if (typeof phone !== "string" || !PHONE.test(phone) || typeof code !== "string" || !/^\d{6}$/.test(code) || !["register", "login"].includes(purpose)) {
      throw new SmsProviderError(400, "短信发送参数无效");
    }
    const controller = new AbortController();
    let timer;
    try {
      const date = new Date(now());
      const signatureNonce = nonce();
      if (!Number.isFinite(date.getTime()) || typeof signatureNonce !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(signatureNonce)) throw new Error("Invalid signing inputs");
      const query = {
        PhoneNumbers: phone,
        SignName: settings.signName,
        TemplateCode: settings.templateCode,
        TemplateParam: JSON.stringify({ [settings.templateParamKey]: code })
      };
      const headers = {
        host: HOST,
        "x-acs-action": "SendSms",
        "x-acs-content-sha256": digest(""),
        "x-acs-date": date.toISOString().replace(/\.\d{3}Z$/, "Z"),
        "x-acs-signature-nonce": signatureNonce,
        "x-acs-version": "2017-05-25"
      };
      if (settings.securityToken) headers["x-acs-security-token"] = settings.securityToken;
      const signed = signAliyunRequest({ ...settings, headers, query });
      headers.authorization = signed.authorization;
      headers.accept = "application/json";
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new SmsProviderError()); }, timeoutMs);
      });
      const operation = (async () => {
        // RPC SendSms parameters belong in query. Omit body so fetch cannot
        // automatically add an unsigned Content-Type header for a string body.
        const response = await fetchImpl(ENDPOINT + "?" + signed.canonicalQuery, {
          method: "POST", headers, redirect: "error", signal: controller.signal
        });
        if (!response || !response.ok) throw new SmsProviderError();
        const raw = await response.text();
        if (raw.length > 65536) throw new SmsProviderError();
        const result = JSON.parse(raw);
        if (!result || typeof result !== "object" || Array.isArray(result) || result.Code !== "OK") throw new SmsProviderError();
        // Never forward provider messages, IDs, submitted parameters or secrets.
        return { ok: true };
      })();
      return await Promise.race([operation, timeout]);
    } catch (_) {
      // Upstream errors can contain CanonicalRequest, phone numbers or OTPs.
      // Do not attach a cause, raw response, URL, headers or vendor exception.
      throw new SmsProviderError();
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = { createAliyunSmsSender, signAliyunRequest, SmsProviderError };
