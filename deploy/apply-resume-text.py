#!/usr/bin/env python3
"""Publish the reviewed resume text fix without restarting the HR service.

Default is read-only preflight apart from temporary public-code staging. --apply
verifies a full installed daily backup, then replaces exactly two frontend files
and the offline architecture HTML. Private configuration, personnel data, SQL,
AI settings, sessions and service configuration are never opened by this tool.
"""
import argparse
import contextlib
import datetime
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
import types
import urllib.parse

sys.dont_write_bytecode = True
APP = pathlib.Path('/opt/hr-system')
SERVICE, OWNER = 'hr-system.service', 'hrsystem'
BACKUPS = pathlib.Path('/root/hr-system-backups')
FRONTEND = ('js/employees.js', 'js/employee-profile.js')
HTML = '人力资源管理系统开发架构.html'
FILES = (*FRONTEND, HTML)
MANIFEST = 'deploy/resume-text-release.json'
DOCS = ('README.md', '2026-11-25.md', 'updates/2026-11-25.md',
        '技术文档/系统开发架构.source.json', '技术文档/05-阿里云部署手册.md',
        MANIFEST, 'deploy/apply-resume-text.py', 'deploy/apply-organization-fix.py',
        'tests/resume-text-deployment.test.js', 'tests/resume-text.test.js',
        '技术文档/14-AI查询与周期报表.md')
ORIGIN = 'http://127.0.0.1:8080'
HELPER_SHA256 = 'c69e757105b89d0ec7ffa54a430c8144832e08cacde9ff35785057224d1d0795'
GENERATOR = 'scripts/generate-architecture.cjs'
GENERATOR_SHA256 = '7adffbf50bffd22285b13eadb029d73676af6c68b1ad55feeefc416c1ed9b6f9'
BACKUP_SHA256 = '34cae4644d5d1236db7477d201e065eedd35f964a4668f179998bc0d746faac6'
COMMAND = pathlib.Path('/usr/local/sbin/hr-system-backup')
DAILY = pathlib.Path('/var/backups/hr-system/daily')
INSTALL = pathlib.Path('/usr/local/lib/hr-system-backup')
TOOL, TOOL_MANIFEST = INSTALL / 'daily-backup.py', INSTALL / 'installation.json'
UNITS = pathlib.Path('/etc/systemd/system')
TIMER = 'hr-system-backup.timer'
MANAGED = {TOOL: 0o600, COMMAND: 0o700,
           UNITS / 'hr-system-backup.service': 0o644, UNITS / TIMER: 0o644}
SHA = re.compile(r'[0-9a-f]{64}')
BACKUP_NAME = re.compile(r'\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\+0800-[0-9a-f]{12}')


class Refused(Exception):
    pass


def require(value, message):
    if not value:
        raise Refused(message)


def raw_hash(raw):
    return hashlib.sha256(raw).hexdigest()


def checked(path, directory=False):
    target = pathlib.Path(os.path.abspath(path))
    for part in (*reversed(target.parents), target):
        try:
            info = part.lstat()
        except FileNotFoundError:
            require(part == target and not directory, 'Required deployment parent is missing')
            continue
        require(not stat.S_ISLNK(info.st_mode), 'Symbolic links are not allowed in deployment paths')
        if part != target or directory:
            require(stat.S_ISDIR(info.st_mode), 'Required deployment directory is missing')
    return target


def regular_file(path):
    target = checked(path)
    info = target.stat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
            'Deployment files must be ordinary single-link files')
    return target


def load_helper():
    path = regular_file(pathlib.Path(__file__).with_name('apply-organization-fix.py'))
    raw = path.read_bytes()
    require(raw_hash(raw) == HELPER_SHA256, 'Public deployment helper differs from the fixed reviewed version')
    module = types.ModuleType('resume_release_public_helpers')
    module.__file__ = str(path)
    exec(compile(raw, str(path), 'exec'), module.__dict__)
    return module


helper = load_helper()


def canonical_hash(raw):
    text = raw.decode('utf-8').replace('\r\n', '\n').rstrip() + '\n'
    require('\0' not in text and '\r' not in text, 'Unexpected public source encoding')
    return raw_hash(text.encode())


def reviewed_hash(value):
    if not re.fullmatch(r'[a-fA-F0-9]{64}', value):
        raise argparse.ArgumentTypeError('Expected a reviewed 64-hex SHA256')
    return value.lower()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate release manifest property')
        result[key] = value
    return result


def validate_release(document):
    require(isinstance(document, dict) and set(document) == {'schemaVersion', 'files', 'architectureSha256'} and
            type(document['schemaVersion']) is int and document['schemaVersion'] == 1,
            'Unsupported resume release schema')
    require(isinstance(document['architectureSha256'], str) and SHA.fullmatch(document['architectureSha256']),
            'Invalid architecture candidate digest')
    require(isinstance(document['files'], dict) and set(document['files']) == set(FRONTEND),
            'Manifest must contain exactly the two reviewed resume frontend paths')
    for row in document['files'].values():
        require(isinstance(row, dict) and set(row) == {'beforeSha256', 'afterSha256'} and
                all(isinstance(value, str) and SHA.fullmatch(value) for value in row.values()),
                'Invalid reviewed frontend digest')
        require(row['beforeSha256'] != row['afterSha256'], 'Resume release must change both reviewed frontend files')
    return document


def load_release(source, expected):
    raw = regular_file(source / MANIFEST).read_bytes()
    require(raw_hash(raw) == expected, 'Resume manifest differs from the fixed reviewed release')
    try:
        document = json.loads(raw.decode('utf-8'), object_pairs_hook=unique_object)
    except (ValueError, UnicodeDecodeError):
        raise Refused('Resume manifest is not valid UTF-8 JSON')
    return validate_release(document)


def protected_source(path, gid, directory=False):
    target = checked(path, directory=True) if directory else regular_file(path)
    info = target.stat()
    require(info.st_uid == 0 and info.st_gid == gid and stat.S_IMODE(info.st_mode) == (0o750 if directory else 0o640),
            'Expected existing root-owned source protection')


def clean_environment():
    return {key: value for key, value in os.environ.items()
            if key.upper() in ('PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SYSTEMROOT', 'WINDIR')}


def process_state():
    require(helper.system_value('User') == OWNER and helper.system_value('WorkingDirectory') == str(APP),
            'Unexpected existing HR service identity')
    require(helper.system_value('ActiveState') == 'active', 'Existing HR service is not active')
    pid = helper.system_value('MainPID')
    require(re.fullmatch(r'[1-9][0-9]*', pid) and pathlib.Path('/proc', pid, 'cwd').resolve(strict=True) == APP,
            'Unexpected running HR process')
    return pid


def file_proof(path, mode):
    target = regular_file(path)
    info = target.stat()
    require(info.st_uid == 0 and info.st_gid == 0 and stat.S_IMODE(info.st_mode) == mode,
            'Existing backup tool permissions changed')
    return (info.st_dev, info.st_ino, info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode), raw_hash(target.read_bytes()))


def timer_state():
    require(helper.run(['systemctl', 'is-enabled', TIMER]).strip() == b'enabled' and
            helper.run(['systemctl', 'show', TIMER, '-p', 'ActiveState', '--value']).strip() == b'active',
            'Existing daily backup timer must remain enabled and active')
    info = checked(INSTALL, directory=True).stat()
    require(info.st_uid == 0 and info.st_gid == 0 and stat.S_IMODE(info.st_mode) == 0o700,
            'Existing backup tool directory is not root-private')
    result = {str(path): file_proof(path, mode) for path, mode in {**MANAGED, TOOL_MANIFEST: 0o600}.items()}
    require(result[str(TOOL)][-1] == BACKUP_SHA256, 'Existing backup core differs from the reviewed relational version')
    try:
        manifest = json.loads(regular_file(TOOL_MANIFEST).read_bytes())
    except ValueError:
        raise Refused('Existing backup installation manifest is invalid')
    require(isinstance(manifest, dict) and set(manifest) == {'schemaVersion', 'type', 'files'} and
            type(manifest['schemaVersion']) is int and manifest['schemaVersion'] == 1 and
            manifest['type'] == 'hr-system-daily-backup-installation' and isinstance(manifest['files'], dict) and
            set(manifest['files']) == {str(path) for path in MANAGED} and
            all(manifest['files'][str(path)] == result[str(path)][-1] for path in MANAGED),
            'Existing backup installation digest mismatch')
    return result


def full_daily_backup():
    def report(arguments):
        try:
            result = json.loads(helper.run(arguments, env=clean_environment(), timeout=5500).decode().splitlines()[-1])
        except (ValueError, IndexError, UnicodeDecodeError):
            raise Refused('Installed backup command returned no valid completion receipt')
        require(isinstance(result, dict), 'Installed backup command returned no valid completion receipt')
        return result
    result = report([COMMAND, '--run'])
    value = result.get('backup')
    require(result.get('status') == 'DAILY_BACKUP_OK' and isinstance(value, str), 'Complete daily backup was not confirmed')
    path = pathlib.PurePosixPath(value)
    require(path.parent == pathlib.PurePosixPath(DAILY.as_posix()) and BACKUP_NAME.fullmatch(path.name),
            'Unexpected full backup location')
    verified = report([COMMAND, '--verify', path])
    require(verified.get('status') == 'DAILY_BACKUP_VERIFIED' and verified.get('backup') == str(path),
            'Full daily backup verification failed')
    return str(path)


@contextlib.contextmanager
def publication_lock():
    import fcntl
    path = pathlib.Path('/run/hr-system-backup-install.lock')
    checked(path.parent, directory=True)
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'a+b') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0 and
                stat.S_IMODE(info.st_mode) == 0o600, 'Unsafe publication lock')
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused('Another managed HR maintenance publication is running')
        yield


def health():
    code, body = helper.get(ORIGIN, '/api/auth/status')
    try:
        value = json.loads(body)
    except ValueError:
        raise Refused('Existing HR service returned invalid public health status')
    require(code == 200 and isinstance(value, dict) and value.get('ok') is True and value.get('setupRequired') is False and
            value.get('storage') == {'backend': 'mysql', 'model': 'relational', 'readOnly': False},
            'Existing writable relational HR service is required')


def public_check(values):
    health()
    for name in FRONTEND:
        code, body = helper.get(ORIGIN, '/' + urllib.parse.quote(name))
        require(code == 200 and body == values[name], 'Reviewed public file is not served exactly: ' + name)
    require(helper.get(ORIGIN, '/' + urllib.parse.quote(HTML))[0] == 404,
            'Offline architecture HTML must remain outside the static HTML whitelist')
    for route in ('/api/data/snapshot.json', '/api/employees/export', '/api/organization/settings', '/api/ai/settings'):
        require(helper.get(ORIGIN, route)[0] == 401, 'Anonymous access boundary changed')


def capture_current(gid, document):
    for path in (APP, APP / 'js'):
        protected_source(path, gid, directory=True)
    current = {}
    for name in FILES:
        protected_source(APP / name, gid)
        current[name] = regular_file(APP / name).read_bytes()
        if name in FRONTEND:
            require(canonical_hash(current[name]) == document['files'][name]['beforeSha256'],
                    'Production frontend differs from the reviewed baseline: ' + name)
    return current


def write_private(target, content):
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with target.open('xb') as stream:
        os.chmod(target, 0o600)
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())


def freeze_release(source, stage, document):
    generator = regular_file(source / GENERATOR).read_bytes()
    require(raw_hash(generator) == GENERATOR_SHA256, 'Architecture generator differs from the fixed reviewed public version')
    candidates = {name: regular_file(source / name).read_bytes() for name in FILES}
    for name in FILES:
        expected = document['files'][name]['afterSha256'] if name in FRONTEND else document['architectureSha256']
        require(raw_hash(candidates[name]) == expected, 'Release payload differs from the reviewed raw digest: ' + name)
        if name in FRONTEND:
            canonical_hash(candidates[name])
        write_private(stage / name, candidates[name])
    documents = {name: regular_file(source / name).read_bytes() for name in DOCS}
    for name in FRONTEND:
        helper.run(['node', '--check', stage / name], env=clean_environment())
    # Execute the already verified bytes, so replacing the source path cannot
    # substitute a different root-run executable between the digest and Node.
    # stdin uses __dirname="." and avoids platform command-line size limits.
    result = subprocess.run(['node', '-', '--check'], input=generator,
                            cwd=source / 'scripts', env=clean_environment(),
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300)
    require(result.returncode == 0, 'Architecture documentation check failed')
    require(all(regular_file(source / name).read_bytes() == content
                for name, content in {**candidates, **documents, GENERATOR: generator}.items()),
            'Reviewed source changed during preflight')
    return candidates, documents


def atomic_install(target, content, gid, expected):
    protected_source(target.parent, gid, directory=True)
    protected_source(target, gid)
    descriptor, name = tempfile.mkstemp(prefix='.resume-text-', dir=target.parent)
    pending = pathlib.Path(name)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fchown(stream.fileno(), 0, gid)
            os.fchmod(stream.fileno(), 0o640)
            os.fsync(stream.fileno())
        require(regular_file(target).read_bytes() == expected, 'Public source changed before atomic installation')
        os.replace(pending, target)
        descriptor = os.open(target.parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if pending.exists():
            pending.unlink()


def save_release(backup, current, candidates, documents):
    for prefix, values in (('previous-public-code', current), ('reviewed-release', {**candidates, **documents})):
        for name, content in values.items():
            write_private(backup / prefix / name, content)


def publish(current, candidates, gid, pid, timer, backup, full_backup):
    changed = []
    try:
        require(process_state() == pid and timer_state() == timer, 'Service or daily backup installation changed before publication')
        for name in FILES:
            protected_source(APP / name, gid)
            require(regular_file(APP / name).read_bytes() == current[name], 'Production source changed during preflight')
        for name in FILES:
            changed.append(name)
            atomic_install(APP / name, candidates[name], gid, current[name])
            protected_source(APP / name, gid)
            helper.run(['runuser', '-u', OWNER, '--', 'test', '-r', APP / name], env=clean_environment())
        public_check(candidates)
        require(process_state() == pid and timer_state() == timer, 'Service or daily backup installation changed during publication')
        for name in FILES:
            protected_source(APP / name, gid)
            require(regular_file(APP / name).read_bytes() == candidates[name], 'Installed public source changed during verification')
        write_private(backup / 'RESUME_TEXT_OK', b'Frontend resume text fix; service, data, AI settings and protections retained.\n')
        return {'status': 'RESUME_TEXT_OK', 'backup': str(backup), 'dataBackup': full_backup,
                'installedFiles': list(FILES), 'serviceRestarted': False, 'sourceProtected': True,
                'dailyBackupTimerPreserved': True, 'businessDataWritten': False, 'privateConfigurationWritten': False,
                'sha256': {name: raw_hash(content) for name, content in candidates.items()}}
    except BaseException:
        errors = []
        for name in reversed(changed):
            try:
                observed = regular_file(APP / name).read_bytes()
                require(observed in (current[name], candidates[name]), 'Foreign public changes must be preserved')
                if observed != current[name]:
                    atomic_install(APP / name, current[name], gid, candidates[name])
                protected_source(APP / name, gid)
            except BaseException:
                errors.append(name)
        if errors:
            write_private(backup / 'ROLLBACK_NEEDS_ATTENTION', ('\n'.join(errors) + '\n').encode())
            raise Refused('Public code rollback needs administrator review in the publication backup directory')
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--expected-release-sha256', required=True, type=reviewed_hash)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--check', action='store_true', help='Read-only preflight; default')
    modes.add_argument('--apply', action='store_true', help='Verify a full backup and publish without restarting')
    args = parser.parse_args(argv)
    source = checked(args.source, directory=True)
    document = load_release(source, args.expected_release_sha256)
    require(os.name == 'posix' and os.geteuid() == 0, 'Run as root on the existing Linux server')
    require(source != APP and APP not in source.parents and source not in APP.parents,
            'Reviewed release must be separate from production')
    import grp
    gid = grp.getgrnam(OWNER).gr_gid
    with publication_lock() if args.apply else contextlib.nullcontext():
        pid, timer = process_state(), timer_state()
        current = capture_current(gid, document)
        public_check(current)
        with tempfile.TemporaryDirectory(prefix='hr-resume-text-preflight-') as temporary:
            os.chmod(temporary, 0o700)
            candidates, documents = freeze_release(source, pathlib.Path(temporary), document)
            require(raw_hash(documents[MANIFEST]) == args.expected_release_sha256, 'Release manifest changed during preflight')
            require(process_state() == pid and timer_state() == timer, 'Service or daily backup installation changed during preflight')
            if not args.apply:
                result = {'status': 'RESUME_TEXT_CHECK', 'readyToApply': True, 'serviceRestarted': False,
                          'sourcePermissionsChanged': False, 'businessDataWritten': False, 'privateConfigurationWritten': False}
            else:
                full_backup = full_daily_backup()
                checked(BACKUPS)
                BACKUPS.mkdir(mode=0o700, exist_ok=True)
                info = BACKUPS.stat()
                require(info.st_uid == 0 and info.st_gid == 0 and stat.S_IMODE(info.st_mode) == 0o700,
                        'Publication backup directory must be root-private 0700')
                backup = pathlib.Path(tempfile.mkdtemp(prefix=datetime.datetime.now().strftime('%Y-%m-%d-resume-text-%H%M%S-'), dir=BACKUPS))
                os.chmod(backup, 0o700)
                save_release(backup, current, candidates, documents)
                result = publish(current, candidates, gid, pid, timer, backup, full_backup)
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
        message = str(error) if isinstance(error, (Refused, helper.Refused)) else type(error).__name__
        print('Resume text publication stopped: ' + message, file=sys.stderr)
        sys.exit(1)
