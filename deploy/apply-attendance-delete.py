#!/usr/bin/env python3
"""Publish administrator-only attendance deletion without replacing SMS code.

Default is preflight. --apply verifies a full private backup, briefly stops the
existing service, and updates only five reviewed public files. Historical
publishers are imported only for their narrow safety helpers, never main().
"""
import argparse
import contextlib
import datetime
import hashlib
import importlib.util
import json
import os
import pathlib
import signal
import stat
import sys
import tempfile


sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('protected_release_primitives', pathlib.Path(__file__).with_name('apply-leave-types-time.py'))
primitives = importlib.util.module_from_spec(spec)
spec.loader.exec_module(primitives)
helper = primitives.helper
Refused, require = primitives.Refused, primitives.require
canonical, canonical_hash = primitives.canonical, primitives.canonical_hash
regular_file, protected_source = primitives.regular_file, primitives.protected_source
atomic_install, timer_state = primitives.atomic_install, primitives.timer_state
data_hashes, full_daily_backup = primitives.data_hashes, primitives.full_daily_backup
wait_health, publication_lock = primitives.wait_health, primitives.publication_lock
reviewed_hash = primitives.reviewed_hash
APP, SERVICE, OWNER = primitives.APP, primitives.SERVICE, primitives.OWNER
AUTH = 'server/auth-service.js'
FRONTEND = ('js/attendance.js', 'js/overtime.js', 'js/leave.js')
HTML = '人力资源管理系统开发架构.html'
FILES = (AUTH, *FRONTEND, HTML)
DOCS = ('README.md', '2026-11-18.md', 'updates/2026-11-18.md', '技术文档/系统开发架构.source.json',
        '技术文档/07-手机号账号与数据权限.md', '技术文档/05-阿里云部署手册.md')
OLD_CLEANUP = '''  // 楼长删除本楼栋人员时一并清理关联数据；其他楼栋记录始终保留。
  const keptIds = new Set(next.employees.map(e => e.id));
  for (const key of ["overtime", "leaveRequests", "attendance", "performance"]) next[key] = next[key].filter(r => keptIds.has(r.employeeId));
'''
ADMIN_DELETE_GUARD = '''  // 考勤、加班和请假记录仅管理员可删除，不能通过移除人员间接删除。
  const keptIds = new Set(next.employees.map(e => e.id));
  for (const key of ["overtime", "leaveRequests", "attendance"]) {
    const keptRecords = new Set(next[key].map(r => r.id));
    if (current[key].some(r => !keptRecords.has(r.id) || (allIds.has(r.employeeId) && !keptIds.has(r.employeeId)))) fail(403, "仅管理员可删除考勤、加班或请假记录；关联人员请联系管理员处理");
  }
  // 历史孤儿考勤记录保留原样，绩效仍沿用原来的人员清理规则。
  next.performance = next.performance.filter(r => keptIds.has(r.employeeId));
'''
PATCHES = ((OLD_CLEANUP, ADMIN_DELETE_GUARD),)


def patch_auth(raw, expected):
    text = canonical(raw)
    require(hashlib.sha256(text.encode()).hexdigest() == expected,
            'Production authentication source differs from the reviewed baseline')
    require(PATCHES, 'Reviewed administrator deletion guard is missing')
    for old, replacement in PATCHES:
        require(text.count(old) == 1 and replacement not in text,
                'Deletion guard anchor is missing, duplicated or already applied')
        text = text.replace(old, replacement, 1)
    return text.encode()


def freeze_release(source, stage, current, expected_auth, expected_frontend):
    require(set(expected_frontend) == set(FRONTEND), 'Three reviewed frontend baselines are required')
    for name in FRONTEND:
        require(canonical_hash(current[name]) == expected_frontend[name],
                'Production attendance frontend differs from the reviewed baseline: ' + name)
    candidates = {AUTH: patch_auth(current[AUTH], expected_auth)}
    for name in (*FRONTEND, HTML):
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
    environment['HR_ATTENDANCE_AUTH_TEST_MODULE'] = str(stage / AUTH)
    test = regular_file(source / 'tests/attendance-delete-permissions.test.js')
    helper.run(['node', '--test', test], cwd=source, env=environment)
    helper.run(['node', regular_file(source / 'scripts/generate-architecture.cjs'), '--check'], cwd=source, env=environment)
    return candidates


def publish(current, candidates, data, port, database, gid, timer, backup, full_backup):
    changed, stopped = [], False
    try:
        require(timer_state() == timer, 'Daily backup timer changed before publication')
        for name in FILES:
            require((APP / name).read_bytes() == current[name], 'Production source changed during preflight')
            protected_source(APP / name, gid)
        stopped = True
        helper.run(['systemctl', 'stop', SERVICE])
        require(helper.system_value('ActiveState') == 'inactive', 'Application did not stop for publication')
        # Ordinary writes during online preflight are retained, not rolled back.
        hashes, before = data_hashes(data), helper.mysql_snapshot(database)
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
        require(helper.get('http://127.0.0.1:' + str(port), '/api/employees/export')[0] == 401,
                'Anonymous personnel export boundary changed')
        for name in FRONTEND:
            code, body = helper.get('http://127.0.0.1:' + str(port), '/' + name)
            require(code == 200 and body == candidates[name], 'Updated attendance frontend is not served: ' + name)
        require(timer_state() == timer, 'Daily backup timer changed during publication')
        for name in FILES:
            protected_source(APP / name, gid)
            require((APP / name).read_bytes() == candidates[name], 'Installed source changed during verification')
        (backup / 'ATTENDANCE_DELETE_OK').write_text('Administrator-only attendance deletion; existing data and protections retained.\n', encoding='utf-8')
        return {'status': 'ATTENDANCE_DELETE_OK', 'backup': str(backup), 'dataBackup': full_backup,
                'installedFiles': list(FILES), 'serviceRestarted': True, 'sourceProtected': True,
                'dailyBackupTimerPreserved': True, 'businessDataWritten': False,
                'authSha256': canonical_hash(candidates[AUTH]),
                'frontendSha256': {name: hashlib.sha256(candidates[name]).hexdigest() for name in FRONTEND}}
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
    for name in ('attendance', 'overtime', 'leave'):
        parser.add_argument('--expected-' + name + '-sha256', required=True, type=reviewed_hash)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--check', action='store_true', help='Check only; default')
    modes.add_argument('--apply', action='store_true', help='Back up, publish and restart the HR service')
    args = parser.parse_args(argv)
    require(os.name == 'posix' and os.geteuid() == 0, 'Run as root on the existing Linux server')
    source = helper.checked_path(args.source, 'dir')
    require(source != APP and APP not in source.parents and source not in APP.parents,
            'Reviewed release must be separate from production')
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
        for name in FRONTEND:
            code, body = helper.get('http://127.0.0.1:' + str(port), '/' + name)
            require(code == 200 and body == current[name], 'Service does not serve the reviewed production directory')
        expected_frontend = dict(zip(FRONTEND, (args.expected_attendance_sha256, args.expected_overtime_sha256, args.expected_leave_sha256)))
        with tempfile.TemporaryDirectory(prefix='hr-attendance-delete-preflight-') as temporary:
            candidates = freeze_release(source, pathlib.Path(temporary), current, args.expected_auth_sha256, expected_frontend)
            if not args.apply:
                result = {'status': 'ATTENDANCE_DELETE_CHECK', 'readyToApply': True,
                          'serviceRestarted': False, 'sourcePermissionsChanged': False}
            else:
                full_backup = full_daily_backup()
                helper.checked_path(helper.BACKUPS)
                helper.BACKUPS.mkdir(mode=0o700, exist_ok=True)
                info = helper.BACKUPS.stat()
                require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700,
                        'Publication backups must be root-owned 0700')
                backup = pathlib.Path(tempfile.mkdtemp(prefix=datetime.datetime.now().strftime('%Y-%m-%d-attendance-delete-%H%M%S-'), dir=helper.BACKUPS))
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
        print('Attendance deletion publication stopped: ' + (str(error) if isinstance(error, Refused) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
