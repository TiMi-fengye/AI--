#!/usr/bin/env python3
"""Publish reviewed leave types and minute precision without deploying SMS code.

Default is a read-only preflight apart from temporary public-code staging.
--apply makes and verifies a full private daily backup before briefly stopping
the HR service, then installs only the patched production auth, leave.js and
offline architecture HTML. The existing daily timer and business data remain.
"""
import argparse
import contextlib
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
import time


sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('leave_release_helpers', pathlib.Path(__file__).with_name('apply-organization-fix.py'))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
Refused = helper.Refused
require = helper.require
APP = helper.APP
SERVICE = helper.SERVICE
OWNER = helper.OWNER
AUTH = 'server/auth-service.js'
LEAVE = 'js/leave.js'
HTML = '人力资源管理系统开发架构.html'
FILES = (AUTH, LEAVE, HTML)
DOCS = ('README.md', '2026-11-18.md', 'updates/2026-11-18.md', '技术文档/系统开发架构.source.json',
        '技术文档/07-手机号账号与数据权限.md', '技术文档/05-阿里云部署手册.md')
DAILY_COMMAND = pathlib.Path('/usr/local/sbin/hr-system-backup')
DAILY_DIRECTORY = pathlib.Path('/var/backups/hr-system/daily')
TIMER = 'hr-system-backup.timer'
BACKUP_NAME = re.compile(r'\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\+0800-[0-9a-f]{12}')
HELPER_ANCHOR = 'function validateRequest(record, kind) {'
LEAVE_TIMESTAMP = '''function leaveTimestamp(value) {
  if (typeof value !== "string" || !/^\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2})?$/.test(value) || value.slice(0, 4) === "0000") return null;
  // Treat the supplied components as wall-clock values; do not apply the host timezone.
  const date = new Date(value.length === 10 ? value + "T00:00:00.000Z" : value + ":00.000Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, value.length) === value ? date.getTime() : null;
}
'''
OLD_VALIDATION = '''    if (!["leave", "compensatory", "shift", "sick", "personal", "annual", "marriage", "maternity", "other"].includes(record.type)) fail(400, "请假类型无效");
    const start = new Date(record.startDate), end = new Date(record.endDate);
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(record.startDate || "") || !/^\\d{4}-\\d{2}-\\d{2}$/.test(record.endDate || "") || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) fail(400, "请假起止日期无效");
'''
NEW_VALIDATION = '''    if (!["leave", "compensatory", "shift", "sick", "personal", "annual", "statutoryAnnual", "welfareAnnual", "paidSick", "marriage", "maternity", "other"].includes(record.type)) fail(400, "请假类型无效");
    const start = leaveTimestamp(record.startDate), end = leaveTimestamp(record.endDate);
    if (start === null || end === null || record.startDate.length !== record.endDate.length || end < start || (record.startDate.length > 10 && end === start)) fail(400, "请假起止日期或时间无效");
'''
PATCHES = ((HELPER_ANCHOR, LEAVE_TIMESTAMP + HELPER_ANCHOR), (OLD_VALIDATION, NEW_VALIDATION))


def reviewed_hash(value):
    if not re.fullmatch(r'[a-fA-F0-9]{64}', value):
        raise argparse.ArgumentTypeError('Expected a reviewed 64-hex SHA256')
    return value.lower()


def canonical(raw):
    text = raw.decode('utf-8').replace('\r\n', '\n').rstrip() + '\n'
    require('\0' not in text and '\r' not in text, 'Unexpected public source encoding')
    return text


def canonical_hash(raw):
    return hashlib.sha256(canonical(raw).encode()).hexdigest()


def patch_auth(raw, expected):
    text = canonical(raw)
    require(hashlib.sha256(text.encode()).hexdigest() == expected, 'Production authentication source differs from the reviewed baseline')
    for old, replacement in PATCHES:
        require(text.count(old) == 1 and replacement not in text, 'Authentication patch anchor is missing, duplicated or already applied')
        text = text.replace(old, replacement, 1)
    return text.encode()


def regular_file(path):
    path = helper.checked_path(path, 'file')
    info = path.stat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'Deployment files must be ordinary single-link files')
    return path


def protected_source(path, gid, directory=False):
    helper.checked_path(path, 'dir' if directory else 'file')
    info = path.stat()
    require(info.st_uid == 0 and info.st_gid == gid and stat.S_IMODE(info.st_mode) == (0o750 if directory else 0o640),
            'Expected existing root-owned source protection')
    if not directory:
        regular_file(path)


def timer_state():
    result = {'active': helper.run(['systemctl', 'show', TIMER, '-p', 'ActiveState', '--value']).decode().strip(),
              'enabled': helper.run(['systemctl', 'is-enabled', TIMER]).decode().strip()}
    require(result == {'active': 'active', 'enabled': 'enabled'}, 'Existing daily backup timer is not enabled and active')
    for name in ('hr-system-backup.service', TIMER):
        path = regular_file(pathlib.Path('/etc/systemd/system') / name)
        info = path.stat()
        result[name] = (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode), helper.digest(path))
    return result


@contextlib.contextmanager
def publication_lock():
    import fcntl
    target = pathlib.Path('/run/hr-leave-types-time.lock')
    descriptor = os.open(target, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'a+b') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0 and
                stat.S_IMODE(info.st_mode) == 0o600, 'Unsafe publication lock')
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused('Another leave publication is running')
        yield


def atomic_install(target, content, gid):
    """Keep source root-owned even during rollback; never change the service user."""
    helper.checked_path(target.parent, 'dir')
    regular_file(target)
    descriptor, name = tempfile.mkstemp(prefix='.leave-types-time-', dir=target.parent)
    pending = pathlib.Path(name)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchown(stream.fileno(), 0, gid)
            os.fchmod(stream.fileno(), 0o640)
        os.replace(pending, target)
        directory = os.open(target.parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if pending.exists():
            pending.unlink()


def data_hashes(data):
    result = helper.protected_hashes(data)
    for path in helper.regular_tree(data):
        regular_file(path)
        result[str(path)] = helper.digest(path)
    return result


def full_daily_backup():
    info = regular_file(DAILY_COMMAND).stat()
    require(info.st_uid == 0 and info.st_gid == 0 and stat.S_IMODE(info.st_mode) == 0o700, 'Daily backup command is not root-private')
    raw = helper.run([DAILY_COMMAND, '--run'], timeout=5500)
    result = json.loads(raw.decode().splitlines()[-1])
    value = result.get('backup')
    require(result.get('status') == 'DAILY_BACKUP_OK' and isinstance(value, str), 'A complete daily backup was not confirmed')
    path = pathlib.PurePosixPath(value)
    require(path.parent == pathlib.PurePosixPath(DAILY_DIRECTORY.as_posix()) and BACKUP_NAME.fullmatch(path.name), 'Unexpected full backup location')
    verified = json.loads(helper.run([DAILY_COMMAND, '--verify', path], timeout=5500).decode().splitlines()[-1])
    require(verified.get('status') == 'DAILY_BACKUP_VERIFIED' and verified.get('backup') == str(path), 'Full daily backup verification failed')
    return str(path)


def freeze_release(source, stage, current, expected_auth, expected_leave):
    require(canonical_hash(current[LEAVE]) == expected_leave, 'Production leave.js differs from the reviewed baseline')
    candidates = {AUTH: patch_auth(current[AUTH], expected_auth)}
    for name in (LEAVE, HTML):
        candidates[name] = regular_file(source / name).read_bytes()
    for name in DOCS:
        regular_file(source / name)
    for name, content in candidates.items():
        target = stage / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        target.write_bytes(content)
        os.chmod(target, 0o600)
        if name.endswith('.js'):
            helper.run(['node', '--check', target])
    environment = {key: value for key, value in os.environ.items() if not key.startswith('HR_')}
    environment['HR_LEAVE_AUTH_TEST_MODULE'] = str(stage / AUTH)
    test = regular_file(source / 'tests/leave-validation.test.js')
    helper.run(['node', '--test', test], cwd=source, env=environment)
    helper.run(['node', regular_file(source / 'scripts/generate-architecture.cjs'), '--check'], cwd=source, env=environment)
    return candidates


def wait_health(port):
    for _ in range(30):
        try:
            code, body = helper.get('http://127.0.0.1:' + str(port), '/api/auth/status')
            status = json.loads(body)
            if code == 200 and status.get('ok') is True and status.get('setupRequired') is False:
                return
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise Refused('Previous application code did not return to a healthy state')


def publish(current, candidates, data, port, database, gid, timer, backup, full_backup):
    """Stop only after the verified backup; never restore or write business data."""
    changed, stopped = [], False
    try:
        require(timer_state() == timer, 'Daily backup timer changed before publication')
        for name in FILES:
            require((APP / name).read_bytes() == current[name], 'Production source changed during preflight')
            protected_source(APP / name, gid)
        stopped = True
        helper.run(['systemctl', 'stop', SERVICE])
        require(helper.system_value('ActiveState') == 'inactive', 'Application did not stop for publication')
        # Capture after stopping: ordinary writes during preflight are retained.
        hashes = data_hashes(data)
        before = helper.mysql_snapshot(database)
        for name in FILES:
            changed.append(name)
            atomic_install(APP / name, candidates[name], gid)
            helper.run(['runuser', '-u', OWNER, '--', 'test', '-r', APP / name])
            protected_source(APP / name, gid)
        require(data_hashes(data) == hashes and helper.mysql_snapshot(database) == before,
                'Existing data changed while the application was stopped')
        helper.run(['systemctl', 'start', SERVICE])
        helper.verify(port, data / 'organization-settings.json', hashes, database, before)
        require(data_hashes(data) == hashes, 'Runtime files changed during publication verification')
        require(helper.get('http://127.0.0.1:' + str(port), '/api/employees/export')[0] == 401, 'Anonymous personnel export boundary changed')
        code, body = helper.get('http://127.0.0.1:' + str(port), '/js/leave.js')
        require(code == 200 and body == candidates[LEAVE], 'Published leave.js is not served')
        require(timer_state() == timer, 'Daily backup timer changed during publication')
        for name in FILES:
            protected_source(APP / name, gid)
            require((APP / name).read_bytes() == candidates[name], 'Installed source changed during verification')
        (backup / 'LEAVE_TYPES_TIME_OK').write_text('Reviewed leave types and minute precision; business data and source protection retained.\n', encoding='utf-8')
        return {'status': 'LEAVE_TYPES_TIME_OK', 'backup': str(backup), 'dataBackup': full_backup,
                'installedFiles': list(FILES), 'serviceRestarted': True, 'sourceProtected': True,
                'dailyBackupTimerPreserved': True, 'businessDataWritten': False,
                'authSha256': canonical_hash(candidates[AUTH]), 'leaveSha256': hashlib.sha256(candidates[LEAVE]).hexdigest()}
    except BaseException:
        errors = []
        if changed:
            try:
                helper.run(['systemctl', 'stop', SERVICE])
                for name in reversed(changed):
                    observed = regular_file(APP / name).read_bytes()
                    require(observed in (current[name], candidates[name]), 'Changed source preserved for administrator review')
                    if observed != current[name]:
                        atomic_install(APP / name, current[name], gid)
                    protected_source(APP / name, gid)
            except BaseException:
                errors.append('restore-code')
        if stopped:
            try:
                helper.run(['systemctl', 'start', SERVICE])
                wait_health(port)
            except BaseException:
                errors.append('start-previous-code')
        if errors:
            (backup / 'ROLLBACK_NEEDS_ATTENTION').write_text('\n'.join(errors) + '\n', encoding='utf-8')
            raise Refused('Code rollback needs administrator review in the publication backup directory')
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--expected-auth-sha256', required=True, type=reviewed_hash)
    parser.add_argument('--expected-leave-sha256', required=True, type=reviewed_hash)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--check', action='store_true', help='Check only; default')
    modes.add_argument('--apply', action='store_true', help='Back up, publish and restart the HR service')
    args = parser.parse_args(argv)
    require(os.name == 'posix' and os.geteuid() == 0, 'Run as root on the existing Linux server')
    source = helper.checked_path(args.source, 'dir')
    require(source != APP and APP not in source.parents and source not in APP.parents, 'Reviewed release must be separate from production')
    import grp
    gid = grp.getgrnam(OWNER).gr_gid
    with publication_lock() if args.apply else contextlib.nullcontext():
        data, port, database = helper.runtime()
        for directory in (APP, APP / 'js', APP / 'server'):
            protected_source(directory, gid, directory=True)
        for name in FILES:
            protected_source(APP / name, gid)
        timer = timer_state()
        current = {name: regular_file(APP / name).read_bytes() for name in FILES}
        code, body = helper.get('http://127.0.0.1:' + str(port), '/js/leave.js')
        require(code == 200 and body == current[LEAVE], 'Service does not serve the reviewed production directory')
        with tempfile.TemporaryDirectory(prefix='hr-leave-preflight-') as temporary:
            candidates = freeze_release(source, pathlib.Path(temporary), current, args.expected_auth_sha256, args.expected_leave_sha256)
            if not args.apply:
                result = {'status': 'LEAVE_TYPES_TIME_CHECK', 'readyToApply': True, 'serviceRestarted': False, 'sourcePermissionsChanged': False}
            else:
                full_backup = full_daily_backup()
                helper.checked_path(helper.BACKUPS)
                helper.BACKUPS.mkdir(mode=0o700, exist_ok=True)
                info = helper.BACKUPS.stat()
                require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700, 'Publication backups must be root-owned 0700')
                backup = pathlib.Path(tempfile.mkdtemp(prefix=datetime.datetime.now().strftime('%Y-%m-%d-leave-types-time-%H%M%S-'), dir=helper.BACKUPS))
                for prefix, values in (('previous-code', current), ('reviewed-release', candidates)):
                    for name, content in values.items():
                        target = backup / prefix / name
                        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                        target.write_bytes(content)
                for name in DOCS:
                    target = backup / 'reviewed-release' / name
                    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                    target.write_bytes((source / name).read_bytes())
                result = publish(current, candidates, data, port, database, gid, timer, backup, full_backup)
            print(json.dumps(result), flush=True)


if __name__ == '__main__':
    os.umask(0o077)
    def interrupted(signum, frame):
        raise KeyboardInterrupt()
    for name in ('SIGTERM', 'SIGHUP'):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), interrupted)
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        print('Leave types/time publication stopped: ' + (str(error) if isinstance(error, Refused) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
