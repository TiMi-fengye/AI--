#!/usr/bin/env python3
"""Apply the reviewed organization-options fix to the existing single ECS host.

Run as root with --source (reviewed extracted source) and --legacy-archive
(pre-upgrade application backup). No credentials, personnel, or option values
are printed. Existing runtime settings are never overwritten.
"""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import shutil
import signal
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request

APP = pathlib.Path("/opt/hr-system")
SERVICE = "hr-system.service"
OWNER = "hrsystem"
BACKUPS = pathlib.Path("/root/hr-system-backups")
FILES = ("index.html", "login.html", "sw.js", "js/store.js", "js/employees.js",
         "js/app.js", "js/permission.js", "js/dashboard.js", "server/auth-service.js")
OPTION_KEYS = {"companies", "personAttributes", "workAttributes", "positions",
               "departments", "statuses", "buildings", "regions", "rooms"}
CLIENT = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class Refused(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Refused(message)


def checked_path(value, kind=None):
    target = pathlib.Path(os.path.abspath(value))
    for entry in [*reversed(target.parents), target]:
        try:
            info = entry.lstat()
        except FileNotFoundError:
            continue
        require(not stat.S_ISLNK(info.st_mode), "Symbolic links are not allowed in deployment paths")
        if entry != target:
            require(stat.S_ISDIR(info.st_mode), "Deployment parent is not a directory")
    if kind == "file":
        require(target.is_file(), "Required deployment file is missing")
    if kind == "dir":
        require(target.is_dir(), "Required deployment directory is missing")
    return target


def run(arguments, *, cwd=None, output=None, env=None, timeout=300):
    result = subprocess.run([str(value) for value in arguments], cwd=cwd, env=env,
                            stdout=output if output is not None else subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout)
    require(result.returncode == 0, pathlib.Path(str(arguments[0])).name + " command failed")
    return result.stdout or b""


def system_value(name):
    return run(["systemctl", "show", SERVICE, "-p", name, "--value"]).decode().strip()


def digest(file):
    value = hashlib.sha256()
    with open(file, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def regular_tree(directory):
    for parent, directories, files in os.walk(directory, followlinks=False):
        for name in directories:
            checked_path(pathlib.Path(parent) / name, "dir")
        for name in files:
            yield checked_path(pathlib.Path(parent) / name, "file")


def runtime():
    checked_path(APP, "dir")
    require(system_value("User") == OWNER, "Unexpected service user")
    require(system_value("WorkingDirectory") == str(APP), "Unexpected systemd working directory")
    run(["systemctl", "is-active", "--quiet", SERVICE])
    pid = system_value("MainPID")
    require(re.fullmatch(r"[1-9][0-9]*", pid), "No running application PID")
    require(pathlib.Path("/proc", pid, "cwd").resolve(strict=True) == APP, "Unexpected running working directory")
    allowed = {"HR_DATA_DIR", "HR_PORT", "HR_MYSQL_ENABLED", "HR_MYSQL_HOST", "HR_MYSQL_PORT", "HR_MYSQL_DATABASE"}
    environment = {}
    for entry in pathlib.Path("/proc", pid, "environ").read_bytes().split(b"\0"):
        key, separator, value = entry.partition(b"=")
        if separator and key.decode("ascii", "ignore") in allowed:
            environment[key.decode("ascii")] = value.decode("utf-8")
    config_file = checked_path(APP / "server/config.json", "file")
    config = json.loads(config_file.read_text(encoding="utf-8"))
    mysql = config.get("mysql") or {}
    data = pathlib.Path(environment.get("HR_DATA_DIR") or APP / "server/data")
    if not data.is_absolute():
        data = APP / data
    data = checked_path(data, "dir")
    require(data not in (pathlib.Path("/"), pathlib.Path("/root"), APP, pathlib.Path("/tmp")), "Unsafe data directory")
    run(["runuser", "-u", OWNER, "--", "test", "-w", data])
    port = int(environment.get("HR_PORT") or config.get("port") or 8080)
    require(0 < port < 65536, "Invalid application port")
    enabled = (environment.get("HR_MYSQL_ENABLED") or str(bool(mysql.get("enabled")))).lower() == "true"
    host = environment.get("HR_MYSQL_HOST") or mysql.get("host") or "127.0.0.1"
    mysql_port = int(environment.get("HR_MYSQL_PORT") or mysql.get("port") or 3306)
    database = environment.get("HR_MYSQL_DATABASE") or mysql.get("database") or "hr_system"
    require(enabled and host in ("127.0.0.1", "localhost") and mysql_port == 3306, "This fix requires the existing local MySQL instance on port 3306")
    require(isinstance(database, str) and re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_-]{0,63}", database), "Invalid database name")
    require(run(["mysql", "--protocol=socket", "-uroot", "-NBe", "SELECT @@port"]).strip() == b"3306", "MySQL socket does not match port 3306")
    return data, port, database


def mysql_snapshot(database):
    raw = run(["mysql", "--protocol=socket", "-uroot", database, "-NBe",
               "SELECT SHA2(payload,256),COALESCE(JSON_LENGTH(payload,'$.employees'),0) FROM system_snapshots WHERE snapshot_key='default'"])
    require(re.fullmatch(rb"[a-fA-F0-9]{64}\t[0-9]+\n?", raw), "Expected exactly one existing MySQL snapshot")
    return raw


def protected_hashes(data):
    paths = [APP / "server/config.json", pathlib.Path("/etc/systemd/system") / SERVICE]
    paths.extend(file for file in regular_tree(data) if file.suffix == ".json")
    for directory in (pathlib.Path("/etc/hr-system"), pathlib.Path("/etc/nginx/sites-available")):
        if directory.exists():
            paths.extend(regular_tree(checked_path(directory, "dir")))
    return {str(file): digest(checked_path(file, "file")) for file in paths}


def tar_backup(target, directory, members):
    run(["tar", "-czpf", target, "-C", directory, "--", *members], timeout=600)
    require(target.stat().st_size > 0, "Backup archive is empty")
    run(["tar", "-tzf", target], timeout=600)


def get(base, route):
    try:
        with CLIENT.open(base + route, timeout=5) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def verify(port, settings_file, original_hashes, database, before):
    base = "http://127.0.0.1:" + str(port)
    for _ in range(30):
        try:
            code, body = get(base, "/api/auth/status")
            status = json.loads(body)
            if code == 200 and status.get("ok") is True:
                break
        except (OSError, ValueError):
            pass
        time.sleep(1)
    else:
        raise Refused("Application did not become healthy")
    require(status.get("setupRequired") is False, "Existing administrator was not preserved")
    code, body = get(base, "/api/organization/options")
    response = json.loads(body)
    settings = json.loads(settings_file.read_text(encoding="utf-8"))
    require(code == 200 and response.get("ok") is True and set(response) == {"ok", "options"}, "Public organization response is invalid")
    require(set(response["options"]) == OPTION_KEYS, "Public option keys do not match")
    for key in OPTION_KEYS:
        require(response["options"][key] == settings["options"][key], "Public options do not match the restored private settings")
    for route, expected in (("/api/data/snapshot.json", 401), ("/api/organization/settings", 401),
                            ("/server/config.json", 404), ("/server/data/auth-users.json", 404),
                            ("/server/data/organization-settings.json", 404), ("/%73erver/data/organization-settings.json", 404),
                            ("/api/wechat/login-config", 410), ("/api/feishu/login-config", 410)):
        require(get(base, route)[0] == expected, "Access boundary check failed for " + route)
    require(get(base, "/login.html")[0] == 200, "Login page is unavailable")
    for file, expected in original_hashes.items():
        require(digest(checked_path(file, "file")) == expected, "An existing protected production file changed")
    require(mysql_snapshot(database) == before, "Existing MySQL snapshot changed")
    run(["systemctl", "is-active", "--quiet", SERVICE])
    return {key: len(settings["options"][key]) for key in sorted(OPTION_KEYS)} | {"buildingLeaders": len(settings["buildingLeaders"])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--legacy-archive", required=True)
    args = parser.parse_args()
    require(os.name == "posix" and os.geteuid() == 0, "Run this production repair as root on the existing Linux host")
    source = checked_path(args.source, "dir")
    legacy = checked_path(args.legacy_archive, "file")
    require(source != APP and APP not in source.parents and source not in APP.parents, "Reviewed source must be separate from production")
    recovery = checked_path(source / "deploy/recover-organization-settings.py", "file")
    for file in FILES:
        checked_path(APP / file, "file")
        candidate = checked_path(source / file, "file")
        if file.endswith(".js"):
            run(["node", "--check", candidate])
    tests = sorted(checked_path(source / "tests", "dir").glob("*.test.js"))
    require(tests and (source / "tests/organization-recovery.test.js") in tests, "Reviewed regression tests are missing")
    for test in tests:
        checked_path(test, "file")
    # Regression tests must not inherit production HR_* settings.
    test_environment = {key: value for key, value in os.environ.items() if not key.startswith("HR_")}
    test_environment["HR_NO_OPEN"] = "1"
    test_log = run(["node", "--test", *tests], cwd=source, env=test_environment)
    data, port, database = runtime()
    target = checked_path(data / "organization-settings.json")
    require(not target.exists(), "Organization settings already exist; no production files were changed")
    preview = json.loads(run([sys.executable, recovery, "--archive", legacy, "--data-dir", data]))
    require(preview.get("applied") is False and preview["counts"].get("buildings", 0) > 0 and preview["counts"].get("buildingLeaders", 0) > 0, "Legacy backup did not contain the expected building and leader settings")
    checked_path(BACKUPS)
    BACKUPS.mkdir(mode=0o700, exist_ok=True)
    require(BACKUPS.stat().st_uid == 0 and stat.S_IMODE(BACKUPS.stat().st_mode) == 0o700, "Backup root must be owned by root with mode 0700")
    backup = BACKUPS / ("2026-11-12-org-" + datetime.datetime.now().strftime("%H%M%S") + "-" + str(os.getpid()))
    backup.mkdir(mode=0o700)
    (backup / "release-tests.log").write_bytes(test_log)
    (backup / "release-files.json").write_text(json.dumps({file: digest(source / file) for file in FILES}, indent=2), encoding="utf-8")
    print("Preflight and regression tests passed; backup:", backup, flush=True)
    stopped = changed = False
    created_identity = None
    try:
        stopped = True
        run(["systemctl", "stop", SERVICE])
        # All backups and hashes represent the same stopped-application state.
        require(not target.exists() and not target.is_symlink(), "Organization settings appeared during preflight; refusing to overwrite")
        hashes = protected_hashes(data)
        before = mysql_snapshot(database)
        (backup / "protected-file-hashes.json").write_text(json.dumps(hashes, indent=2), encoding="utf-8")
        (backup / "mysql-before.txt").write_bytes(before)
        tar_backup(backup / "application.tar.gz", APP, ["."])
        tar_backup(backup / "runtime-data.tar.gz", data, ["."])
        tar_backup(backup / "previous-code.tar.gz", APP, FILES)
        tar_backup(backup / "service-config.tar.gz", "/", ["etc/systemd/system/" + SERVICE, "etc/nginx/sites-available", "etc/nginx/sites-enabled"])
        if pathlib.Path("/etc/hr-system").exists():
            tar_backup(backup / "environment-config.tar.gz", "/", ["etc/hr-system"])
        with open(backup / "mysql.sql", "wb") as stream:
            run(["mysqldump", "--protocol=socket", "-uroot", "--single-transaction", "--no-tablespaces", "--routines", "--triggers", database], output=stream, timeout=600)
        require((backup / "mysql.sql").stat().st_size > 0, "MySQL dump is empty")
        recovered = json.loads(run([sys.executable, recovery, "--archive", legacy, "--data-dir", data, "--apply"]))
        require(recovered.get("applied") is True, "Organization recovery did not confirm creation")
        info = checked_path(target, "file").stat()
        created_identity = (info.st_dev, info.st_ino, digest(target))
        run(["runuser", "-u", OWNER, "--", "test", "-r", target])
        changed = True
        for file in FILES:
            checked_path(APP / file, "file")
            candidate = checked_path(source / file, "file")
            run(["install", "-m", "644", "-o", OWNER, "-g", OWNER, candidate, APP / file])
        run(["systemctl", "start", SERVICE])
        counts = verify(port, target, hashes, database, before)
        (backup / "verified-counts.json").write_text(json.dumps(counts, indent=2), encoding="utf-8")
        (backup / "mysql-after.txt").write_bytes(mysql_snapshot(database))
        (backup / "ORGANIZATION_FIX_OK").write_text("Existing production data and accounts preserved.\n", encoding="utf-8")
        print(json.dumps({"status": "ORGANIZATION_FIX_OK", "backup": str(backup), "counts": counts}), flush=True)
    except BaseException:
        print("Repair failed; restoring the previous application code. Backup:", backup, file=sys.stderr, flush=True)
        rollback_errors = []
        if changed:
            try:
                run(["systemctl", "stop", SERVICE])
            except BaseException:
                rollback_errors.append("stop")
            try:
                for file in FILES:
                    checked_path(APP / file, "file")
                run(["tar", "-xzpf", backup / "previous-code.tar.gz", "-C", APP, "--", *FILES])
            except BaseException:
                rollback_errors.append("restore-code")
        try:
            if created_identity and target.exists() and not target.is_symlink():
                info = target.stat()
                if (info.st_dev, info.st_ino, digest(target)) == created_identity:
                    # Move only the unchanged file created by this invocation.
                    shutil.move(str(target), str(backup / "recovered-organization-settings.json"))
        except BaseException:
            rollback_errors.append("preserve-created-settings")
        if stopped:
            try:
                run(["systemctl", "start", SERVICE])
            except BaseException:
                rollback_errors.append("restart")
        if rollback_errors:
            print("Automatic code rollback needs attention:", ",".join(rollback_errors), file=sys.stderr)
            (backup / "ROLLBACK_NEEDS_ATTENTION").write_text("\n".join(rollback_errors) + "\n", encoding="utf-8")
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
        print("Organization repair stopped: " + (str(error) if isinstance(error, Refused) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
