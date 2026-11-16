#!/usr/bin/env python3
"""Deploy role-scoped personnel export without enabling undeployed SMS code.

Run as root on the existing ECS host. --source is the reviewed extracted source;
--expected-auth-sha256 is the reviewed baseline auth-service.js SHA-256 after
normalizing CRLF to LF and trailing whitespace to one final LF. Only reviewed personnel frontend files, the verified spreadsheet library, architecture HTML,
and exact current auth/index patches are installed.
Existing accounts, organization settings, configuration and snapshots are not
written. A stopped-service backup precedes all production code changes.
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import signal
import stat
import sys
import tempfile


def load_helpers():
    location = pathlib.Path(__file__).with_name("apply-organization-fix.py")
    spec = importlib.util.spec_from_file_location("personnel_deploy_helpers", location)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # Its guarded main() is deliberately not called.
    return module


helper = load_helpers()
Refused = helper.Refused
require = helper.require
FILES = ("js/employees.js", "js/personnel-export.js", "js/xlsx.full.min.js",
         "LICENSE-SheetJS.txt", "人力资源管理系统开发架构.html")
VENDOR_SHA256 = "cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41"
AUTH = "server/auth-service.js"
DOCS = ("2026-11-16.md", "updates/2026-11-16.md", "技术文档/系统开发架构.source.json",
        "技术文档/07-手机号账号与数据权限.md", "README.md", "技术文档/05-阿里云部署手册.md")
PATCHES = (('function organizationSettings(value) {', 'const PERSONNEL_EXPORT_FIELDS = [\n  ["employeeNo", "工号"], ["name", "姓名"], ["gender", "性别"],\n  ["position", "工作岗位"], ["company", "人员性质"], ["personAttribute", "人员属性"],\n  ["workAttribute", "工作属性"], ["department", "部门"], ["status", "状态"],\n  ["region", "区域"], ["room", "机房"], ["building", "楼栋"],\n  ["phone", "手机号"], ["email", "邮箱"], ["joinDate", "入职日期"],\n  ["leaveDate", "离职日期"], ["aiProfile", "人员简介"], ["resumeName", "简历文件名"],\n  ["credentialName", "证件文件名"], ["_resumeText", "简历提取文本"]\n];\nfunction personnelExport(input, actor) {\n  const snapshot = normalizeSnapshot(input);\n  const fields = PERSONNEL_EXPORT_FIELDS.map(([key, label]) => ({ key, label }));\n  const buildings = actor.role === "leader" && Array.isArray(actor.buildings)\n    ? [...new Set(actor.buildings.filter(building => typeof building === "string" && building.trim()))] : [];\n  const rows = actor.role === "admin" ? snapshot.employees\n    : snapshot.employees.filter(employee => employee && typeof employee.building === "string" && employee.building.trim() && buildings.includes(employee.building));\n  const employees = rows.filter(employee => employee && typeof employee === "object" && !Array.isArray(employee)).map(employee => {\n    const result = { id: positiveId(employee.id) ? employee.id : null };\n    for (const { key } of fields) {\n      const value = employee[key];\n      // Export only scalar form values. Unknown and nested legacy metadata must\n      // never expose credentials or arbitrary business objects in the download.\n      result[key] = typeof value === "string" ? value\n        : typeof value === "number" && Number.isFinite(value) ? String(value)\n        : typeof value === "boolean" ? String(value) : "";\n    }\n    for (const key of ["resumeData", "credentialData"]) result[key] = typeof employee[key] === "string" ? employee[key] : "";\n    return result;\n  });\n  return { ok: true, generatedAt: new Date().toISOString(), scope: { role: actor.role, buildings }, fields, employees };\n}\nfunction organizationSettings(value) {'), ('    if (!(url.startsWith("/api/auth/") || url === "/api/data/snapshot.json" || url === "/api/organization/options" || url === "/api/organization/settings")) return false;', '    if (!(url.startsWith("/api/auth/") || url === "/api/data/snapshot.json" || url === "/api/organization/options" || url === "/api/organization/settings" || url === "/api/employees/export")) return false;'), ('      if (url === "/api/organization/options" && req.method === "GET") {', '      if (url === "/api/employees/export" && req.method === "GET") {\n        const initialActor = requireUser(req);\n        if (!["admin", "leader"].includes(initialActor.role)) fail(403, "仅管理员和楼长可导出人员信息");\n        await queue;\n        const snapshot = await readSnapshot();\n        // A queue/read wait may outlive a changed assignment or deleted session.\n        // Use current server permissions, never client filters or cached roles.\n        const actor = requireUser(req);\n        if (!["admin", "leader"].includes(actor.role)) fail(403, "仅管理员和楼长可导出人员信息");\n        sendJson(res, 200, personnelExport(snapshot, actor));\n      } else if (url === "/api/organization/options" && req.method === "GET") {'))
INDEX = "index.html"
INDEX_PATCHES = (
    ('<script src="js/employees.js?v=20261112org"></script>', '<script src="js/personnel-export.js?v=20261116export"></script><script src="js/employees.js?v=20261116export"></script>'),
    ('<script src="js/xlsx.full.min.js?v=20261112org"></script>', '<script src="js/xlsx.full.min.js?v=20261116export"></script>'),
)



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
    require(replacements, "Reviewed personnel export patches are missing")
    for old, new in replacements:
        require(text.count(old) == 1 and new not in text,
                "A reviewed auth patch anchor is missing, duplicated or already applied")
        text = text.replace(old, new, 1)
    return text.encode("utf-8")


def patch_auth(raw, expected):
    return patch_exact(raw, expected, PATCHES)


def patch_index(raw, expected):
    return patch_exact(raw, expected, INDEX_PATCHES)


def backup_directory():
    helper.checked_path(helper.BACKUPS)
    helper.BACKUPS.mkdir(mode=0o700, exist_ok=True)
    info = helper.BACKUPS.stat()
    require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700,
            "Backup root must be owned by root with mode 0700")
    prefix = datetime.datetime.now().strftime("%Y-%m-%d-personnel-export-%H%M%S-")
    return pathlib.Path(tempfile.mkdtemp(prefix=prefix, dir=helper.BACKUPS))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--expected-auth-sha256", required=True, type=expected_sha)
    parser.add_argument("--expected-index-sha256", required=True, type=expected_sha)
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
    # Baseline matching precedes runtime inspection, staging and service changes.
    existing = [AUTH, INDEX]
    require(helper.digest(helper.checked_path(source / "js/xlsx.full.min.js", "file")) == VENDOR_SHA256,
            "Spreadsheet library does not match the reviewed official build")
    for relative in FILES:
        helper.checked_path(source / relative, "file")
        target = helper.checked_path(app / relative)
        if relative.endswith(".js"):
            if relative != "js/personnel-export.js":
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
    release_hashes = {AUTH: helper.digest(staged_auth), INDEX: helper.digest(staged_index)}
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
        for relative in (AUTH, INDEX, *FILES):
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
        for relative in (INDEX, *FILES):
            if relative.endswith((".js", ".html")) and relative != "人力资源管理系统开发架构.html":
                code, body = helper.get("http://127.0.0.1:" + str(port), "/" + relative)
                require(code == 200 and hashlib.sha256(body).hexdigest() == release_hashes[relative],
                        "Published frontend file differs from the reviewed release")
        require(helper.get("http://127.0.0.1:" + str(port), "/api/employees/export")[0] == 401, "Anonymous personnel export must be denied")
        (backup / "mysql-after.txt").write_bytes(helper.mysql_snapshot(database))
        (backup / "PERSONNEL_EXPORT_OK").write_text("Personnel export deployed; production accounts, settings and snapshots unchanged.\n", encoding="utf-8")
        print(json.dumps({"status": "PERSONNEL_EXPORT_OK", "backup": str(backup),
                          "installedFiles": [AUTH, INDEX, *FILES], "counts": counts,
                          "exportScope": "server-authorized-buildings", "exportFormats": 12,
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
        print("Personnel export deployment stopped: " + (str(error) if isinstance(error, Refused) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
