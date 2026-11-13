#!/usr/bin/env python3
"""Deploy the reviewed personnel fields without enabling undeployed SMS code.

Run as root on the existing ECS host. --source is the reviewed extracted source;
--expected-auth-sha256 is the reviewed baseline auth-service.js SHA-256 after
normalizing CRLF to LF and trailing whitespace to one final LF. Only three frontend files, the architecture HTML and
three narrowly patched statements in the current auth service are installed.
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
FILES = ("js/employees.js", "js/self-profile.js", "js/employee-profile.js",
         "人力资源管理系统开发架构.html")
AUTH = "server/auth-service.js"
DOCS = ("2026-11-13.md", "updates/2026-11-13.md", "技术文档/系统开发架构.source.json")
PATCHES = (
    ('const PROFILE_FIELDS = ["name", "gender",',
     'const PROFILE_FIELDS = ["name", "employeeNo", "gender",'),
    ('      const max = field.endsWith("Data") ? 8 * 1024 * 1024 : (field === "_resumeText" || field === "aiProfile" ? 50000 : 1000);',
     '      const max = field === "employeeNo" ? 80 : (field.endsWith("Data") ? 8 * 1024 * 1024 : (field === "_resumeText" || field === "aiProfile" ? 50000 : 1000));'),
    ('    validateRows(next.employees, "人员");\n    const ids = new Set(next.employees.map(e => e.id));',
     '    validateRows(next.employees, "人员");\n    next.employees = next.employees.map(employee => ({ ...employee, ...profileData(employee, ["employeeNo"]) }));\n    const ids = new Set(next.employees.map(e => e.id));'),
)


def expected_sha(value):
    if not re.fullmatch(r"[a-fA-F0-9]{64}", value):
        raise argparse.ArgumentTypeError("Expected a reviewed 64-hex baseline SHA-256")
    return value.lower()


def patch_auth(raw, expected):
    """Pure, fail-closed baseline check and exactly three reviewed replacements."""
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
    for old, new in PATCHES:
        require(text.count(old) == 1 and new not in text,
                "A reviewed auth patch anchor is missing, duplicated or already applied")
        text = text.replace(old, new, 1)
    return text.encode("utf-8")


def backup_directory():
    helper.checked_path(helper.BACKUPS)
    helper.BACKUPS.mkdir(mode=0o700, exist_ok=True)
    info = helper.BACKUPS.stat()
    require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700,
            "Backup root must be owned by root with mode 0700")
    prefix = datetime.datetime.now().strftime("%Y-%m-%d-personnel-%H%M%S-")
    return pathlib.Path(tempfile.mkdtemp(prefix=prefix, dir=helper.BACKUPS))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--expected-auth-sha256", required=True, type=expected_sha)
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
    # Baseline matching precedes runtime inspection, staging and service changes.
    existing = [AUTH]
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
    release_hashes = {AUTH: helper.digest(staged_auth)}
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
        for relative in (AUTH, *FILES):
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
        for relative in FILES:
            if relative.endswith(".js"):
                code, body = helper.get("http://127.0.0.1:" + str(port), "/" + relative)
                require(code == 200 and hashlib.sha256(body).hexdigest() == release_hashes[relative],
                        "Published frontend file differs from the reviewed release")
        (backup / "mysql-after.txt").write_bytes(helper.mysql_snapshot(database))
        (backup / "PERSONNEL_FIELDS_OK").write_text("Personnel fields deployed; production accounts, settings and snapshots unchanged.\n", encoding="utf-8")
        print(json.dumps({"status": "PERSONNEL_FIELDS_OK", "backup": str(backup),
                          "installedFiles": [AUTH, *FILES], "counts": counts,
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
        print("Personnel deployment stopped: " + (str(error) if isinstance(error, Refused) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
