#!/usr/bin/env python3
"""Deploy startup and HTTP performance changes without enabling undeployed SMS code.

Run as root on the existing ECS host. --source is the reviewed extracted source;
--expected-auth-sha256 is the reviewed baseline auth-service.js SHA-256 after
normalizing CRLF to LF and trailing whitespace to one final LF. Only reviewed startup frontend files, architecture HTML, and exact current
server/auth/index/client-auth patches are installed.
Existing accounts, organization settings, configuration and snapshots are not
written. A stopped-service backup precedes all production code changes.
"""
import argparse
import datetime
import hashlib
import gzip
import importlib.util
import json
import os
import pathlib
import re
import signal
import stat
import sys
import tempfile
import urllib.error
import urllib.request


def load_helpers():
    location = pathlib.Path(__file__).with_name("apply-organization-fix.py")
    spec = importlib.util.spec_from_file_location("personnel_deploy_helpers", location)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # Its guarded main() is deliberately not called.
    return module


helper = load_helpers()
Refused = helper.Refused
require = helper.require
FILES = ("js/store.js", "js/app.js", "js/dashboard.js", "人力资源管理系统开发架构.html")
AUTH = "server/auth-service.js"
DOCS = ("2026-11-16.md", "updates/2026-11-16.md", "技术文档/系统开发架构.source.json",
        "技术文档/07-手机号账号与数据权限.md", "README.md", "技术文档/05-阿里云部署手册.md")
PATCHES = (('const crypto = require("node:crypto");', 'const crypto = require("node:crypto");\nconst zlib = require("node:zlib");'), ('function sendJson(res, status, value) {\n  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });\n  res.end(JSON.stringify(value));\n}\n', 'function acceptsGzip(value) {\n  if (typeof value !== "string") return false;\n  let explicit = null, wildcard = null;\n  for (const entry of value.toLowerCase().split(",")) {\n    const parts = entry.trim().split(";").map(part => part.trim());\n    if (!["gzip", "*"].includes(parts[0])) continue;\n    let quality = 1;\n    if (parts.length > 1) {\n      const match = parts.length === 2 && /^q=(0(?:\\.\\d{0,3})?|1(?:\\.0{0,3})?)$/.exec(parts[1]);\n      quality = match ? Number(match[1]) : 0;\n    }\n    if (parts[0] === "gzip") explicit = explicit === null ? quality : Math.min(explicit, quality);\n    else wildcard = wildcard === null ? quality : Math.min(wildcard, quality);\n  }\n  return (explicit === null ? wildcard : explicit) > 0;\n}\nlet jsonGzipInFlight = 0;\nfunction sendJson(res, status, value) {\n  if (res.destroyed || res.writableEnded) return;\n  const body = JSON.stringify(value);\n  const vary = String(res.getHeader && res.getHeader("Vary") || "").split(",").map(item => item.trim()).filter(Boolean);\n  if (!vary.some(item => item === "*" || item.toLowerCase() === "accept-encoding")) vary.push("Accept-Encoding");\n  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Vary: vary.join(", ") };\n  // Authentication and role-scoped business responses never receive validators\n  // or enter the shared static cache, even when their wire body is compressed.\n  if (typeof res.removeHeader === "function") { res.removeHeader("ETag"); res.removeHeader("Last-Modified"); }\n  const finish = (data, compressed) => {\n    if (res.destroyed || res.writableEnded || res.headersSent) return;\n    res.writeHead(status, { ...headers, ...(compressed ? { "Content-Encoding": "gzip" } : {}), "Content-Length": Buffer.byteLength(data) });\n    res.end(res.req && res.req.method === "HEAD" ? undefined : data);\n  };\n  if (Buffer.byteLength(body) < 1024 || !acceptsGzip(res.req && res.req.headers["accept-encoding"]) || jsonGzipInFlight >= 4) {\n    finish(body, false); return;\n  }\n  jsonGzipInFlight++;\n  zlib.gzip(body, { level: zlib.constants.Z_BEST_SPEED }, (error, compressed) => {\n    jsonGzipInFlight--;\n    if (error) {\n      console.warn("JSON response compression failed; using the original response");\n      finish(body, false);\n    } else finish(compressed, true);\n  });\n}\n'), ('module.exports = { createAuthService, emptySnapshot, scopedSnapshot, mergeSnapshot, staticFile, readJson, sendJson, writeAtomic, HttpError };', 'module.exports = { createAuthService, emptySnapshot, scopedSnapshot, mergeSnapshot, staticFile, readJson, sendJson, writeAtomic, HttpError, acceptsGzip };'))
INDEX = "index.html"
INDEX_PATCHES = (('<script src="js/store.js?v=20261112org"></script>', '<script src="js/store.js?v=20261116perf"></script>'), ('<script src="js/auth.js?v=20261112org"></script>', '<script src="js/auth.js?v=20261116perf"></script>'), ('<script src="js/app.js?v=20261112org"></script>', '<script src="js/app.js?v=20261116perf"></script>'), ('<script src="js/dashboard.js?v=20261112org"></script>', '<script src="js/dashboard.js?v=20261116perf"></script>'))
SERVER = "server/server.js"
CLIENT_AUTH = "js/auth.js"
SERVER_PATCHES = (('const { createAuthService, staticFile, sendJson, writeAtomic } = require("./auth-service");', 'const { createAuthService, staticFile, sendJson, writeAtomic, acceptsGzip } = require("./auth-service");\nconst crypto = require("node:crypto");\nconst zlib = require("node:zlib");\nconst gzipStatic = require("node:util").promisify(zlib.gzip);'), ('// 代码类文件一律禁用缓存，保证前端更新立即生效\nconst NO_CACHE_EXT = [".html", ".js", ".css", ".json"];\nfunction cacheHeaders(ext) {\n  const headers = {};\n  if (NO_CACHE_EXT.indexOf(ext) >= 0) {\n    headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0";\n    headers["Pragma"] = "no-cache";\n    headers["Expires"] = "0";\n  }\n  return headers;\n}\n\n', '// Public resources may reuse bytes only after validation. Date query strings\n// are not immutable content hashes: a changed file must be visible immediately.\nconst STATIC_CACHE_MAX_ENTRIES = 64;\nconst STATIC_CACHE_MAX_BYTES = 16 * 1024 * 1024;\nconst staticCache = new Map();\nconst staticLoads = new Map();\nlet staticCacheBytes = 0;\nfunction cacheHeaders(resource, compressed) {\n  return { "Cache-Control": "public, max-age=0, must-revalidate", Vary: "Accept-Encoding",\n    ETag: compressed ? resource.gzipEtag : resource.etag, "Last-Modified": resource.modified };\n}\nfunction cacheStatic(file, resource) {\n  const old = staticCache.get(file);\n  if (old) { staticCacheBytes -= old.bytes; staticCache.delete(file); }\n  if (resource.bytes > STATIC_CACHE_MAX_BYTES) return;\n  staticCache.set(file, resource); staticCacheBytes += resource.bytes;\n  while (staticCache.size > STATIC_CACHE_MAX_ENTRIES || staticCacheBytes > STATIC_CACHE_MAX_BYTES) {\n    const oldest = staticCache.keys().next().value;\n    staticCacheBytes -= staticCache.get(oldest).bytes;\n    staticCache.delete(oldest);\n  }\n}\nasync function loadStatic(file, ext) {\n  const info = await fs.promises.stat(file, { bigint: true });\n  if (!info.isFile()) { const error = new Error("Not a file"); error.code = "ENOENT"; throw error; }\n  const stamp = String(info.size) + ":" + String(info.mtimeNs) + ":" + String(info.ctimeNs);\n  const cached = staticCache.get(file);\n  if (cached && cached.stamp === stamp) {\n    staticCache.delete(file); staticCache.set(file, cached);\n    return cached;\n  }\n  const pending = staticLoads.get(file);\n  if (pending && pending.stamp === stamp) return pending.promise;\n  const promise = (async () => {\n    const data = await fs.promises.readFile(file);\n    let compressed = null;\n    if (data.length >= 1024 && [".html", ".js", ".css", ".json", ".txt"].includes(ext)) {\n      try { compressed = await gzipStatic(data, { level: 6 }); }\n      catch (_) { console.warn("Static response compression failed; using the original response"); }\n    }\n    const etag = \'"\' + crypto.createHash("sha256").update(data).digest("hex") + \'"\';\n    const gzipEtag = compressed ? \'"\' + crypto.createHash("sha256").update(compressed).digest("hex") + \'"\' : null;\n    const resource = { stamp, data, compressed, etag, gzipEtag, modified: info.mtime.toUTCString(), bytes: data.length + (compressed ? compressed.length : 0) };\n    cacheStatic(file, resource);\n    return resource;\n  })();\n  // Bound both stored resources and in-flight deduplication metadata. Actual\n  // file authorization still comes solely from staticFile\'s public allowlist.\n  if (staticLoads.size < STATIC_CACHE_MAX_ENTRIES) staticLoads.set(file, { stamp, promise });\n  try { return await promise; }\n  finally { if (staticLoads.get(file)?.promise === promise) staticLoads.delete(file); }\n}\nfunction matchesStaticEtag(value, etag) {\n  return typeof value === "string" && value.split(",").some(item => {\n    const tag = item.trim();\n    return tag === "*" || tag.replace(/^W\\//, "") === etag;\n  });\n}\n\n'), ('  fs.readFile(fp, (err, data) => {\n    if (err) { res.writeHead(404); res.end("Not Found"); return; }\n    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "X-Content-Type-Options": "nosniff", ...cacheHeaders(ext) });\n    res.end(req.method === "HEAD" ? undefined : data);\n  });', '  try {\n    const resource = await loadStatic(fp, ext);\n    if (res.destroyed || res.writableEnded) return;\n    const compressed = !!resource.compressed && acceptsGzip(req.headers["accept-encoding"]);\n    const data = compressed ? resource.compressed : resource.data;\n    const headers = { "Content-Type": MIME[ext] || "application/octet-stream", "X-Content-Type-Options": "nosniff", ...cacheHeaders(resource, compressed), ...(compressed ? { "Content-Encoding": "gzip" } : {}) };\n    if (matchesStaticEtag(req.headers["if-none-match"], headers.ETag)) {\n      res.writeHead(304, headers); res.end(); return;\n    }\n    res.writeHead(200, { ...headers, "Content-Length": data.length });\n    res.end(req.method === "HEAD" ? undefined : data);\n  } catch (error) {\n    if (res.destroyed || res.writableEnded || res.headersSent) return;\n    const missing = ["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code);\n    if (!missing) console.warn("Public static resource could not be read");\n    res.writeHead(missing ? 404 : 500, { "Cache-Control": "no-store" });\n    res.end(req.method === "HEAD" ? undefined : missing ? "Not Found" : "Resource unavailable");\n  }'))
CLIENT_AUTH_PATCHES = (('  _users: {},\n  setupRequired: false,\n', '  _users: {},\n  _sessionSequence: 0,\n  setupRequired: false,\n'), ("  async init() {\n    const [session, status] = await Promise.all([this.request('session'), this.request('status')]);\n    this._user = session.user || null;\n", "  async init() {\n    const sequence = ++this._sessionSequence;\n    const [session, status] = await Promise.all([this.request('session'), this.request('status')]);\n    if (sequence !== this._sessionSequence) return null;\n    this._user = session.user || null;\n"), ("  async _authenticate(path, body) {\n    try {\n      const data = await this.request(path, { method: 'POST', body: JSON.stringify(body) });\n      this._user = data.user;\n", "  async _authenticate(path, body) {\n    const sequence = ++this._sessionSequence;\n    try {\n      const data = await this.request(path, { method: 'POST', body: JSON.stringify(body) });\n      if (sequence !== this._sessionSequence) return { success: false, message: '登录状态已变化，请重试' };\n      this._user = data.user;\n"), ('    if (this.isLeader()) {\n      const employee = Store.getEmployees().find(e => String(e.id) === String(id));\n', "    if (this.isLeader()) {\n      if (typeof Store.getEmployeeBuilding === 'function') {\n        const building = Store.getEmployeeBuilding(id);\n        return !!building && this.leaderBuildings().includes(building);\n      }\n      const employee = Store.getEmployees().find(e => String(e.id) === String(id));\n"), ("  async logout() {\n    if (typeof Store !== 'undefined' && Store._serverSyncReady) {\n", "  async logout() {\n    const sequence = ++this._sessionSequence;\n    if (typeof Store !== 'undefined' && Store._serverSyncReady) {\n"), ("    }\n    try {\n      await this.request('logout', { method: 'POST', body: '{}' });\n      this._user = null;\n", "    }\n    if (sequence !== this._sessionSequence) return;\n    try {\n      await this.request('logout', { method: 'POST', body: '{}' });\n      if (sequence !== this._sessionSequence) return;\n      this._user = null;\n"))
CLIENT_AUTH_BASELINE = "91ef4c132440b828cb8a4b1288368832e0e44f937eac765c783ebbf708a6d613"



def expected_sha(value):
    if not re.fullmatch(r"[a-fA-F0-9]{64}", value):
        raise argparse.ArgumentTypeError("Expected a reviewed 64-hex baseline SHA-256")
    return value.lower()


def patch_exact(raw, expected, replacements):
    """Pure, fail-closed baseline check and reviewed exact replacements."""
    require(isinstance(expected, str) and re.fullmatch(r"[a-fA-F0-9]{64}", expected),
            "Invalid reviewed baseline SHA-256")
    try:
        text = raw.decode("utf-8").replace("\r\n", "\n").rstrip() + "\n"
    except (AttributeError, UnicodeDecodeError):
        raise Refused("Baseline auth service must be UTF-8")
    require("\r" not in text and "\0" not in text, "Unexpected baseline auth encoding")
    normalized = text.encode("utf-8")
    require(hashlib.sha256(normalized).hexdigest() == expected.lower(),
            "Current auth service differs from the reviewed baseline; no production files were changed")
    require(replacements, "Reviewed performance patches are missing")
    for old, new in replacements:
        require(text.count(old) == 1 and new not in text,
                "A reviewed auth patch anchor is missing, duplicated or already applied")
        text = text.replace(old, new, 1)
    return text.encode("utf-8")


def patch_auth(raw, expected):
    return patch_exact(raw, expected, PATCHES)


def patch_index(raw, expected):
    return patch_exact(raw, expected, INDEX_PATCHES)


def patch_server(raw, expected):
    return patch_exact(raw, expected, SERVER_PATCHES)


def patch_client_auth(raw, expected=CLIENT_AUTH_BASELINE):
    return patch_exact(raw, expected, CLIENT_AUTH_PATCHES)


def verify_transport(port, expected_digest):
    base = "http://127.0.0.1:" + str(port)
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with client.open(urllib.request.Request(base + "/js/app.js", headers={"Accept-Encoding": "identity"}), timeout=10) as response:
        original = response.read()
        etag = response.headers.get("ETag")
        cache = response.headers.get("Cache-Control", "")
        require(response.status == 200 and etag and "max-age=0" in cache and "must-revalidate" in cache and "no-store" not in cache,
                "Static cache revalidation headers are missing")
        require(hashlib.sha256(original).hexdigest() == expected_digest, "Static response differs from reviewed code")
    try:
        response = client.open(urllib.request.Request(base + "/js/app.js", headers={"Accept-Encoding": "identity", "If-None-Match": etag}), timeout=10)
    except urllib.error.HTTPError as response:
        require(response.code == 304 and response.read() == b"", "Unchanged static response must be 304")
    else:
        response.close()
        raise Refused("Static ETag validation did not return 304")
    with client.open(urllib.request.Request(base + "/js/app.js", headers={"Accept-Encoding": "gzip"}), timeout=10) as response:
        compressed = response.read()
        require(response.headers.get("Content-Encoding") == "gzip", "Static gzip transfer is not enabled")
        require(gzip.decompress(compressed) == original, "Gzip response differs from reviewed code")
    with client.open(base + "/api/auth/status", timeout=10) as response:
        require(response.headers.get("Cache-Control") == "no-store" and not response.headers.get("ETag"),
                "Authentication responses must not enter the static cache")
    return {"staticEtag304": True, "gzip": True, "rawBytes": len(original), "gzipBytes": len(compressed), "authNoStore": True}


def backup_directory():
    helper.checked_path(helper.BACKUPS)
    helper.BACKUPS.mkdir(mode=0o700, exist_ok=True)
    info = helper.BACKUPS.stat()
    require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700,
            "Backup root must be owned by root with mode 0700")
    prefix = datetime.datetime.now().strftime("%Y-%m-%d-startup-performance-%H%M%S-")
    return pathlib.Path(tempfile.mkdtemp(prefix=prefix, dir=helper.BACKUPS))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--expected-auth-sha256", required=True, type=expected_sha)
    parser.add_argument("--expected-index-sha256", required=True, type=expected_sha)
    parser.add_argument("--expected-server-sha256", required=True, type=expected_sha)
    args = parser.parse_args(argv)
    require(os.name == "posix" and os.geteuid() == 0,
            "Run this production deployment as root on the existing Linux host")
    source = helper.checked_path(args.source, "dir")
    app = helper.checked_path(helper.APP, "dir")
    require(source != app and app not in source.parents and source not in app.parents,
            "Reviewed source must be separate from production")
    auth_target = helper.checked_path(app / AUTH, "file")
    original_auth = auth_target.read_bytes()
    patched_auth = patch_auth(original_auth, args.expected_auth_sha256)
    index_target = helper.checked_path(app / INDEX, "file")
    original_index = index_target.read_bytes()
    patched_index = patch_index(original_index, args.expected_index_sha256)
    server_target = helper.checked_path(app / SERVER, "file")
    original_server = server_target.read_bytes()
    patched_server = patch_server(original_server, args.expected_server_sha256)
    client_target = helper.checked_path(app / CLIENT_AUTH, "file")
    original_client = client_target.read_bytes()
    patched_client = patch_client_auth(original_client)
    # Baseline matching precedes runtime inspection, staging and service changes.
    existing = [AUTH, INDEX, SERVER, CLIENT_AUTH]
    for relative in FILES:
        helper.checked_path(source / relative, "file")
        target = helper.checked_path(app / relative)
        if relative.endswith(".js"):
            helper.checked_path(target, "file")
            helper.run(["node", "--check", source / relative])
        if target.exists():
            helper.checked_path(target, "file")
            existing.append(relative)
    for relative in DOCS:
        helper.checked_path(source / relative, "file")
    data, port, database = helper.runtime()
    settings = helper.checked_path(data / "organization-settings.json", "file")
    backup = backup_directory()
    stage = backup / "reviewed-release"
    stage.mkdir(mode=0o700)
    staged_auth = stage / AUTH
    staged_auth.parent.mkdir(mode=0o700)
    staged_auth.write_bytes(patched_auth)
    helper.run(["node", "--check", staged_auth])
    staged_index = stage / INDEX
    staged_index.write_bytes(patched_index)
    staged_server = stage / SERVER
    staged_server.write_bytes(patched_server)
    helper.run(["node", "--check", staged_server])
    staged_client = stage / CLIENT_AUTH
    staged_client.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    staged_client.write_bytes(patched_client)
    helper.run(["node", "--check", staged_client])
    release_hashes = {AUTH: helper.digest(staged_auth), INDEX: helper.digest(staged_index), SERVER: helper.digest(staged_server), CLIENT_AUTH: helper.digest(staged_client)}
    # Freeze the reviewed source before stopping the service; deployment never
    # installs additional files merely because they exist in a source archive.
    for relative in (*FILES, *DOCS):
        candidate = helper.checked_path(source / relative, "file")
        frozen = stage / relative
        frozen.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        frozen.write_bytes(candidate.read_bytes())
        release_hashes[relative] = helper.digest(frozen)
        if relative.endswith(".js"):
            helper.run(["node", "--check", frozen])
    (backup / "release-files.json").write_text(json.dumps(release_hashes, indent=2), encoding="utf-8")
    (backup / "baseline-auth-sha256.txt").write_text(args.expected_auth_sha256 + "\n", encoding="ascii")
    print("Preflight passed; stopped-service backups will be saved to:", backup, flush=True)
    stopped = changed = False
    created = {}
    try:
        stopped = True
        helper.run(["systemctl", "stop", helper.SERVICE])
        require(auth_target.read_bytes() == original_auth,
                "Auth service changed during preflight; no production code was changed")
        require(index_target.read_bytes() == original_index, "Index changed during preflight; no production code was changed")
        require(server_target.read_bytes() == original_server, "Server changed during preflight")
        require(client_target.read_bytes() == original_client, "Client auth changed during preflight")
        for relative in FILES:
            target = helper.checked_path(app / relative)
            require(target.exists() == (relative in existing),
                    "Deployment targets changed during preflight")
        hashes = helper.protected_hashes(data)
        before = helper.mysql_snapshot(database)
        (backup / "protected-file-hashes.json").write_text(json.dumps(hashes, indent=2), encoding="utf-8")
        (backup / "mysql-before.txt").write_bytes(before)
        helper.tar_backup(backup / "application.tar.gz", app, ["."])
        helper.tar_backup(backup / "runtime-data.tar.gz", data, ["."])
        helper.tar_backup(backup / "previous-code.tar.gz", app, existing)
        helper.tar_backup(backup / "service-config.tar.gz", "/",
                          ["etc/systemd/system/" + helper.SERVICE, "etc/nginx/sites-available", "etc/nginx/sites-enabled"])
        if pathlib.Path("/etc/hr-system").exists():
            helper.tar_backup(backup / "environment-config.tar.gz", "/", ["etc/hr-system"])
        with open(backup / "mysql.sql", "wb") as stream:
            helper.run(["mysqldump", "--protocol=socket", "-uroot", "--single-transaction",
                        "--no-tablespaces", "--routines", "--triggers", database], output=stream, timeout=600)
        require((backup / "mysql.sql").stat().st_size > 0, "MySQL backup is empty")
        changed = True
        for relative in (AUTH, INDEX, SERVER, CLIENT_AUTH, *FILES):
            candidate = helper.checked_path(stage / relative, "file")
            require(helper.digest(candidate) == release_hashes[relative], "Staged release file changed")
            target = helper.checked_path(app / relative)
            helper.run(["install", "-m", "644", "-o", helper.OWNER, "-g", helper.OWNER, candidate, target])
            require(helper.digest(helper.checked_path(target, "file")) == release_hashes[relative],
                    "Installed file does not match the reviewed release")
            if relative not in existing:
                info = target.stat()
                created[relative] = (info.st_dev, info.st_ino, release_hashes[relative])
        helper.run(["systemctl", "start", helper.SERVICE])
        counts = helper.verify(port, settings, hashes, database, before)
        counts.pop("buildingLeaders", None)  # Retired manual rows are not the live roster.
        for relative in (INDEX, CLIENT_AUTH, *FILES):
            if relative.endswith((".js", ".html")) and relative != "人力资源管理系统开发架构.html":
                code, body = helper.get("http://127.0.0.1:" + str(port), "/" + relative)
                require(code == 200 and hashlib.sha256(body).hexdigest() == release_hashes[relative],
                        "Published frontend file differs from the reviewed release")
        require(helper.get("http://127.0.0.1:" + str(port), "/api/employees/export")[0] == 401, "Anonymous personnel export must be denied")
        transport = verify_transport(port, release_hashes["js/app.js"])
        (backup / "transport-check.json").write_text(json.dumps(transport), encoding="utf-8")
        (backup / "mysql-after.txt").write_bytes(helper.mysql_snapshot(database))
        (backup / "STARTUP_PERFORMANCE_OK").write_text("Startup performance changes deployed; production accounts, settings and snapshots unchanged.\n", encoding="utf-8")
        print(json.dumps({"status": "STARTUP_PERFORMANCE_OK", "backup": str(backup),
                          "installedFiles": [AUTH, INDEX, SERVER, CLIENT_AUTH, *FILES], "counts": counts,
                          "staticResources": "etag-and-gzip", "businessCache": "no-store", "transport": transport,
                          "smsCodeDeployed": False}), flush=True)
    except BaseException:
        print("Deployment failed; restoring the previous application code. Backup:", backup, file=sys.stderr, flush=True)
        errors = []
        if changed:
            try:
                helper.run(["systemctl", "stop", helper.SERVICE])
            except BaseException:
                errors.append("stop")
            try:
                for relative in existing:
                    helper.checked_path(app / relative, "file")
                helper.run(["tar", "-xzpf", backup / "previous-code.tar.gz", "-C", app, "--", *existing])
            except BaseException:
                errors.append("restore-code")
            for relative, identity in created.items():
                try:
                    target = helper.checked_path(app / relative, "file")
                    info = target.stat()
                    require((info.st_dev, info.st_ino, helper.digest(target)) == identity,
                            "A newly installed document changed; preserving it for review")
                    target.unlink()
                except BaseException:
                    errors.append("preserve-new-document")
        if stopped:
            try:
                helper.run(["systemctl", "start", helper.SERVICE])
                if changed:
                    helper.verify(port, settings, hashes, database, before)
            except BaseException:
                errors.append("restart-or-verify")
        if errors:
            (backup / "ROLLBACK_NEEDS_ATTENTION").write_text("\n".join(errors) + "\n", encoding="utf-8")
            print("Automatic code rollback needs attention:", ",".join(errors), file=sys.stderr)
        raise


if __name__ == "__main__":
    os.umask(0o077)

    def interrupted(signum, frame):
        raise KeyboardInterrupt()

    for signal_name in ("SIGTERM", "SIGHUP"):
        if hasattr(signal, signal_name):
            signal.signal(getattr(signal, signal_name), interrupted)
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        print("Startup performance deployment stopped: " + (str(error) if isinstance(error, Refused) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
