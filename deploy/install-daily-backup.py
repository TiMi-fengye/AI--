#!/usr/bin/env python3
"""Install the fixed HR host's private daily backup timer, with a verified first backup.

Default --check validates the public release and existing host, using a temporary
staging directory only. --apply installs the root-owned tool and enables the
Asia/Shanghai 02:00 timer after a successful backup and archive verification.
No application source, runtime data, service account or global timezone is edited.
"""
import argparse
import ast
import contextlib
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import signal
import stat
import subprocess
import sys
import tempfile
import urllib.request
from zoneinfo import ZoneInfo

APP = pathlib.Path('/opt/hr-system')
APP_SERVICE = 'hr-system.service'
USER = 'hrsystem'
INSTALL = pathlib.Path('/usr/local/lib/hr-system-backup')
TOOL = INSTALL / 'daily-backup.py'
MANIFEST = INSTALL / 'installation.json'
WRAPPER = pathlib.Path('/usr/local/sbin/hr-system-backup')
UNITS = pathlib.Path('/etc/systemd/system')
SERVICE = 'hr-system-backup.service'
TIMER = 'hr-system-backup.timer'
BACKUP_DIRECTORY = pathlib.Path('/var/backups/hr-system/daily')
INSTALL_BACKUPS = pathlib.Path('/root/hr-system-backups')
CALENDAR = '*-*-* 02:00:00 Asia/Shanghai'
MARKER = '# Managed by hr-system daily backup installer, schema 1'
KIND = 'hr-system-daily-backup-installation'
TARGETS = (TOOL, WRAPPER, UNITS / SERVICE, UNITS / TIMER, MANIFEST)
MODES = (0o600, 0o700, 0o644, 0o644, 0o600)
COMMAND_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C', 'TZ': 'UTC'}


class Refused(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Refused(message)


def run(args, *, timeout=30, accepted=(0,)):
    result = subprocess.run([str(value) for value in args], capture_output=True,
                            timeout=timeout, env=COMMAND_ENV)
    require(result.returncode in accepted, 'Command failed: ' + pathlib.Path(str(args[0])).name)
    return result


@contextlib.contextmanager
def installation_lock():
    import fcntl
    parent = pathlib.Path('/run')
    secure_parent(parent)
    descriptor = os.open(parent / 'hr-system-backup-install.lock',
                         os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0 and
                stat.S_IMODE(info.st_mode) == 0o600, 'Unsafe backup installer lock')
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused('Another backup installation is running')
        yield
    finally:
        os.close(descriptor)


def is_link(info):
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) & 0x400)


def checked_path(value, allow_missing=False):
    target = pathlib.Path(os.path.abspath(value))
    for component in [*reversed(target.parents), target]:
        try:
            info = component.lstat()
        except FileNotFoundError:
            require(allow_missing, 'Required installation path is missing')
            continue
        require(not is_link(info), 'Installation paths cannot use links or junctions')
        if component != target:
            require(stat.S_ISDIR(info.st_mode), 'Installation parent is not a directory')
        else:
            require(stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode), 'Unsupported installation path type')
            require(not stat.S_ISREG(info.st_mode) or info.st_nlink == 1, 'Installation files cannot use hardlinks')
    return target


def secure_parent(path):
    for component in [*reversed(path.parents), path]:
        info = checked_path(component).stat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and
                not stat.S_IMODE(info.st_mode) & 0o022, 'Installation parent must be controlled by root')


def file_bytes(path, maximum=4 * 1024 * 1024):
    path = checked_path(path)
    info = path.stat()
    require(stat.S_ISREG(info.st_mode) and info.st_size <= maximum, 'Unexpected public installation file')
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        current = os.fstat(descriptor)
        require((current.st_dev, current.st_ino, current.st_size) ==
                (info.st_dev, info.st_ino, info.st_size), 'Installation file changed during inspection')
        with os.fdopen(descriptor, 'rb', closefd=False) as stream:
            content = stream.read(maximum + 1)
        after = os.fstat(descriptor)
        require(len(content) <= maximum and (after.st_size, after.st_mtime_ns) ==
                (current.st_size, current.st_mtime_ns), 'Installation file changed while reading')
        return content
    finally:
        os.close(descriptor)


def digest(content):
    return hashlib.sha256(content).hexdigest()


def unit_contents():
    service = f'''{MARKER}
[Unit]
Description=Private daily HR data backup
After=hr-system.service mysql.service

[Service]
Type=oneshot
User=root
Group=root
UMask=0077
ExecStart=/usr/bin/python3 -I {TOOL.as_posix()} --run
TimeoutStartSec=5400
TimeoutStopSec=60
KillMode=control-group
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadOnlyPaths={APP.as_posix()}
ReadWritePaths=/var/backups/hr-system
'''
    timer = f'''{MARKER}
[Unit]
Description=HR backup daily at 02:00 Asia/Shanghai

[Timer]
OnCalendar={CALENDAR}
Persistent=true
AccuracySec=1s
RandomizedDelaySec=0
Unit={SERVICE}

[Install]
WantedBy=timers.target
'''
    return {SERVICE: service.encode(), TIMER: timer.encode()}


def wrapper_contents():
    return ('#!/bin/sh\n' + MARKER + '\nexec /usr/bin/python3 -I ' + TOOL.as_posix() + ' "$@"\n').encode()


def system_value(unit, property_name):
    return run(['systemctl', 'show', unit, '-p', property_name, '--value'], accepted=(0, 1, 4)).stdout.decode().strip()


def host_state():
    import pwd
    require(system_value(APP_SERVICE, 'User') == USER and
            system_value(APP_SERVICE, 'Group') in ('', USER) and
            system_value(APP_SERVICE, 'WorkingDirectory') == str(APP), 'Unexpected existing HR service identity')
    require(system_value(APP_SERVICE, 'ActiveState') == 'active', 'HR service must already be running')
    pid = system_value(APP_SERVICE, 'MainPID')
    require(re.fullmatch(r'[1-9][0-9]*', pid), 'HR service has no running process')
    require(pathlib.Path('/proc', pid, 'cwd').resolve(strict=True) == APP, 'HR service uses a different working directory')
    gid = pwd.getpwnam(USER).pw_gid
    observed = []
    for path in (APP, APP / 'server', APP / 'server/server.js'):
        info = checked_path(path).stat()
        require(info.st_uid == 0 and info.st_gid == gid and
                stat.S_IMODE(info.st_mode) in (0o640, 0o750), 'Existing application source protection is unexpected')
        observed.append((info.st_dev, info.st_ino, info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)))
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with client.open('http://127.0.0.1:8080/api/auth/status', timeout=10) as response:
        status = json.loads(response.read(2048))
        require(response.status == 200 and status.get('ok') is True and
                status.get('setupRequired') is False, 'Existing authentication health check failed')
    return {'pid': pid, 'sourcePermissions': observed}


def managed_state():
    secure_parent(INSTALL.parent)
    secure_parent(WRAPPER.parent)
    secure_parent(UNITS)
    checked_path(INSTALL, allow_missing=True)
    if INSTALL.exists():
        info = checked_path(INSTALL).stat()
        require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700, 'Tool directory must be root-owned 0700')
    present = [path.exists() or path.is_symlink() for path in TARGETS]
    existing = any(present)
    if existing:
        require(all(present), 'Partial or unrelated backup installation needs review')
        raw = file_bytes(MANIFEST, 65536)
        for path, mode in zip(TARGETS, MODES):
            info = checked_path(path).stat()
            require(info.st_uid == 0 and info.st_gid == 0 and stat.S_IMODE(info.st_mode) == mode,
                    'Existing managed installation ownership or mode changed')
        document = json.loads(raw)
        expected = {str(path) for path in TARGETS if path != MANIFEST}
        require(document.get('schemaVersion') == 1 and document.get('type') == KIND and
                isinstance(document.get('files'), dict) and set(document['files']) == expected,
                'Existing backup tool is not this managed installation')
        for path in TARGETS[:-1]:
            require(document['files'][str(path)] == digest(file_bytes(path)), 'Existing backup tool was edited; preserve it for review')
        for name in (SERVICE, TIMER):
            require(file_bytes(UNITS / name).startswith((MARKER + '\n').encode()), 'Unrelated unit with a backup name')
    elif INSTALL.exists():
        require(not any(INSTALL.iterdir()), 'Unrelated files in backup tool directory')
    for unit in (SERVICE, TIMER):
        fragment = system_value(unit, 'FragmentPath')
        require(not fragment or fragment == str(UNITS / unit), 'Backup unit exists at an unrelated location')
        load = system_value(unit, 'LoadState')
        require(load in ('loaded', 'not-found', ''), 'Masked or invalid backup unit needs review')
        if not existing:
            require(load in ('not-found', '') and not fragment, 'Unmanaged backup unit is already loaded')
    require(system_value(SERVICE, 'ActiveState') in ('inactive', 'failed', ''), 'A backup task is already running')
    enabled = run(['systemctl', 'is-enabled', TIMER], accepted=(0, 1, 4)).stdout.decode().strip()
    require(enabled in ('enabled', 'disabled', 'not-found', ''), 'Unexpected timer enablement needs review')
    active = system_value(TIMER, 'ActiveState')
    require(active in ('active', 'inactive', ''), 'Unexpected timer runtime state needs review')
    require(existing or (enabled in ('not-found', '') and active in ('inactive', '')), 'Unmanaged timer state needs review')
    return {'existing': existing, 'enabled': enabled == 'enabled', 'active': active == 'active',
            'directoryExisted': INSTALL.exists()}


def atomic_write(path, content, mode):
    checked_path(path, allow_missing=True)
    secure_parent(path.parent)
    descriptor, name = tempfile.mkstemp(prefix='.hr-backup-install-', dir=path.parent)
    pending = pathlib.Path(name)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchown(stream.fileno(), 0, 0)
            os.fchmod(stream.fileno(), mode)
        os.replace(pending, path)
    finally:
        if pending.exists():
            pending.unlink()


def save_previous(state):
    secure_parent(INSTALL_BACKUPS.parent)
    if not INSTALL_BACKUPS.exists():
        INSTALL_BACKUPS.mkdir(mode=0o700)
    info = checked_path(INSTALL_BACKUPS).stat()
    require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700, 'Install backup parent must be root-owned 0700')
    prefix = dt.datetime.now(ZoneInfo('Asia/Shanghai')).strftime('%Y-%m-%d-daily-backup-install-%H%M%S-')
    backup = pathlib.Path(tempfile.mkdtemp(prefix=prefix, dir=INSTALL_BACKUPS))
    snapshot = {}
    for index, (path, mode) in enumerate(zip(TARGETS, MODES)):
        if path.exists():
            content = file_bytes(path)
            record = {'data': content, 'mode': mode}
            snapshot[path] = record
            atomic_write(backup / str(index), content, 0o600)
    metadata = {'type': KIND, 'timerEnabled': state['enabled'], 'timerActive': state['active'],
                'savedFiles': {str(path): digest(row['data']) for path, row in snapshot.items()}}
    atomic_write(backup / 'installation-state.json', (json.dumps(metadata, indent=2) + '\n').encode(), 0o600)
    return {'path': backup, 'files': snapshot, 'state': state}


def restore_previous(previous):
    errors = []
    def attempt(operation):
        try:
            operation()
        except Exception:
            errors.append(True)
    attempt(lambda: run(['systemctl', 'stop', TIMER], accepted=(0, 5)))
    # Never stop hr-system.service or delete successful data backups.
    for path in reversed(TARGETS):
        if path in previous['files']:
            record = previous['files'][path]
            attempt(lambda path=path, row=record: atomic_write(path, row['data'], row['mode']))
        elif path.exists():
            attempt(lambda path=path: checked_path(path).unlink())
    attempt(lambda: run(['systemctl', 'daemon-reload']))
    if previous['state']['enabled']:
        attempt(lambda: run(['systemctl', 'enable', TIMER]))
    else:
        attempt(lambda: run(['systemctl', 'disable', TIMER], accepted=(0, 1)))
    if previous['state']['active']:
        attempt(lambda: run(['systemctl', 'start', TIMER]))
    if not previous['state']['directoryExisted'] and INSTALL.exists():
        attempt(lambda: checked_path(INSTALL).rmdir())
    if errors:
        atomic_write(previous['path'] / 'RESTORE_NEEDS_ATTENTION', b'Backup installation recovery needs administrator review.\n', 0o600)
    require(not errors, 'Backup installation rollback needs manual review in the install backup directory')


def run_core(tool, args):
    result = run([sys.executable, '-I', tool, *args], timeout=5500)
    lines = result.stdout.decode().splitlines()
    require(bool(lines) and len(lines[-1]) <= 16 * 1024 * 1024, 'Backup tool did not provide a bounded result')
    summary = json.loads(lines[-1])
    require(isinstance(summary, dict), 'Backup tool returned an unexpected result')
    return summary


def verified_backup_name(summary):
    require(summary.get('status') == 'DAILY_BACKUP_OK', 'First data backup did not complete')
    value = summary.get('backup')
    require(isinstance(value, str), 'First backup did not return its location')
    path = pathlib.PurePosixPath(value)
    require(path.parent == pathlib.PurePosixPath(BACKUP_DIRECTORY.as_posix()) and
            re.fullmatch(r'\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\+0800-[A-Za-z0-9_-]+', path.name),
            'First backup returned an unexpected location')
    return value


def completed_backups(tool):
    summary = run_core(tool, ['--list'])
    names = summary.get('backups')
    require(summary.get('status') == 'DAILY_BACKUP_LIST' and
            summary.get('directory') == BACKUP_DIRECTORY.as_posix() and
            isinstance(names, list) and len(names) <= 100000,
            'Backup listing returned an unexpected result')
    for name in names:
        require(isinstance(name, str), 'Unexpected completed backup name')
        verified_backup_name({'status': 'DAILY_BACKUP_OK', 'backup': BACKUP_DIRECTORY.as_posix() + '/' + name})
    require(len(names) == len(set(names)), 'Duplicate completed backup name')
    return set(names)


def next_trigger(value):
    match = re.fullmatch(r'[A-Za-z]{3} (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) UTC', value)
    require(match is not None, 'Timer did not report its next UTC trigger')
    moment = dt.datetime.strptime(match.group(1), '%Y-%m-%d %H:%M:%S').replace(tzinfo=dt.timezone.utc)
    local = moment.astimezone(ZoneInfo('Asia/Shanghai'))
    require((local.hour, local.minute, local.second) == (2, 0, 0) and
            moment > dt.datetime.now(dt.timezone.utc), 'Timer next trigger is not the requested 02:00 schedule')
    return local.isoformat()


def staged_release(source, stage):
    source = checked_path(source)
    require(stat.S_ISDIR(source.stat().st_mode) and source != APP and APP not in source.parents and
            source not in APP.parents, 'Public release must be separate from the application')
    content = file_bytes(source / 'deploy/daily-backup.py')
    ast.parse(content.decode('utf-8-sig'), filename='daily-backup.py')
    candidate = stage / 'daily-backup.py'
    candidate.write_bytes(content)
    os.chmod(candidate, 0o600)
    units = unit_contents()
    for name, value in units.items():
        (stage / name).write_bytes(value)
    run(['systemd-analyze', 'calendar', CALENDAR])
    run(['systemd-analyze', 'verify', stage / SERVICE, stage / TIMER])
    run_core(candidate, ['--check'])
    return {'tool': content, 'units': units, 'wrapper': wrapper_contents(), 'candidate': candidate}


def install(release, state, host):
    previous = save_previous(state)
    try:
        run(['systemctl', 'stop', TIMER]) if state['existing'] else None
        require(system_value(SERVICE, 'ActiveState') in ('inactive', 'failed', ''), 'A backup task started during installation')
        if not INSTALL.exists():
            INSTALL.mkdir(mode=0o700)
        contents = {TOOL: release['tool'], WRAPPER: release['wrapper'],
                    UNITS / SERVICE: release['units'][SERVICE], UNITS / TIMER: release['units'][TIMER]}
        manifest = {'schemaVersion': 1, 'type': KIND,
                    'files': {str(path): digest(value) for path, value in contents.items()}}
        contents[MANIFEST] = (json.dumps(manifest, indent=2) + '\n').encode()
        for path, mode in zip(TARGETS, MODES):
            atomic_write(path, contents[path], mode)
        first = run_core(TOOL, ['--run'])
        backup = verified_backup_name(first)
        verified = run_core(TOOL, ['--verify', backup])
        require(verified.get('status') == 'DAILY_BACKUP_VERIFIED' and verified.get('backup') == backup,
                'First backup archive verification failed')
        require(host_state() == host, 'Existing HR process or source protection changed during installation')
        run(['systemctl', 'daemon-reload'])
        before_unit = completed_backups(TOOL)
        run(['systemctl', 'start', SERVICE], timeout=5500)
        require(system_value(SERVICE, 'Result') == 'success' and
                system_value(SERVICE, 'ExecMainStatus') == '0' and
                system_value(SERVICE, 'ActiveState') == 'inactive',
                'Installed systemd backup service did not complete successfully')
        created = completed_backups(TOOL) - before_unit
        require(bool(created), 'Installed backup service did not publish a new complete backup')
        backup = BACKUP_DIRECTORY.as_posix() + '/' + sorted(created)[-1]
        verified = run_core(TOOL, ['--verify', backup])
        require(verified.get('status') == 'DAILY_BACKUP_VERIFIED' and verified.get('backup') == backup,
                'Systemd-created backup archive verification failed')
        require(host_state() == host, 'Existing HR service changed during systemd backup verification')
        run(['systemctl', 'enable', '--now', TIMER])
        require(system_value(TIMER, 'ActiveState') == 'active' and
                run(['systemctl', 'is-enabled', TIMER]).stdout.decode().strip() == 'enabled',
                'Daily timer did not become enabled and active')
        next_time = next_trigger(system_value(TIMER, 'NextElapseUSecRealtime'))
        require(host_state() == host, 'Existing HR service changed while enabling the timer')
        return {'status': 'DAILY_BACKUP_READY', 'backupDirectory': str(BACKUP_DIRECTORY),
                'latestBackup': pathlib.PurePosixPath(backup).name, 'timezone': 'Asia/Shanghai',
                'dailyTime': '02:00', 'nextTrigger': next_time, 'timer': TIMER,
                'serviceRestarted': False, 'sourcePermissionsChanged': False, 'retention': 'keep-all',
                'scheduledServiceTested': True}
    except BaseException:
        restore_previous(previous)
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', default=str(pathlib.Path(__file__).resolve().parents[1]))
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--check', action='store_true', help='Validate without installing or scheduling; default')
    modes.add_argument('--apply', action='store_true', help='Install, make and verify a first backup, then enable the timer')
    args = parser.parse_args(argv)
    require(os.name == 'posix' and os.geteuid() == 0 and sys.version_info >= (3, 9), 'Run as root with Python 3.9+ on the existing Linux host')
    with installation_lock() if args.apply else contextlib.nullcontext():
        host = host_state()
        state = managed_state()
        with tempfile.TemporaryDirectory(prefix='hr-backup-preflight-') as temporary:
            stage = pathlib.Path(temporary)
            release = staged_release(args.source, stage)
            if args.apply:
                summary = install(release, state, host)
            else:
                require(host_state() == host, 'Existing HR service changed during preflight')
                summary = {'status': 'DAILY_BACKUP_INSTALL_CHECK', 'readyToApply': True,
                           'backupDirectory': str(BACKUP_DIRECTORY), 'timezone': 'Asia/Shanghai',
                           'dailyTime': '02:00', 'retention': 'keep-all', 'toolSha256': digest(release['tool']),
                           'serviceRestarted': False, 'installationChanged': False}
            print(json.dumps(summary), flush=True)


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
        print('Daily backup installation stopped: ' + (str(error) if isinstance(error, Refused) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
