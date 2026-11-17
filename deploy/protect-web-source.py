#!/usr/bin/env python3
"""Check or protect the fixed HR installation's public source permissions.

Default: --check (read-only). --apply makes code root-owned and read-only to
the service account. --rollback BACKUP restores recorded metadata only. Private
configuration, runtime data, credentials and databases are never traversed.
This cannot prevent a root administrator from making an authorized change.
"""
import argparse
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
import urllib.request

APP = pathlib.Path('/opt/hr-system')
BACKUPS = pathlib.Path('/root/hr-system-backups')
SERVICE = 'hr-system.service'
SERVICE_USER = 'hrsystem'
PUBLIC_DIRS = {'js', 'css', 'assets', 'deploy', 'scripts', '.github', '技术文档', 'updates'}
SERVER_FILES = {'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'config.example.json'}
ROOT_SUFFIXES = {'.html', '.js', '.css', '.md', '.bat', '.cmd', '.png', '.jpg', '.jpeg', '.svg', '.ico'}
ROOT_FILES = {'manifest.json', 'LICENSE-SheetJS.txt', '.gitignore'}
PUBLIC_TEMPLATES = {'server/config.example.json', 'deploy/sms.env.example'}
# Individually reviewed public dependency sources and the repository's legacy
# stop helper; these are not private runtime configuration or business data.
PUBLIC_KNOWN_SOURCE = {
    'server/node_modules/mysql2/lib/connection_config.js',
    'server/node_modules/mysql2/lib/pool_config.js',
    'server/node_modules/mysql2/lib/auth_plugins/caching_sha2_password.js',
    'server/node_modules/mysql2/lib/auth_plugins/mysql_native_password.js',
    'server/node_modules/mysql2/lib/auth_plugins/mysql_clear_password.js',
    'server/node_modules/mysql2/lib/auth_plugins/sha256_password.js',
    'server/node_modules/mysql2/lib/commands/binlog_dump.js',
    'server/node_modules/mysql2/lib/packets/binlog_dump.js',
    'server/node_modules/mysql2/lib/parsers/parser_cache.js',
    'server/node_modules/mysql2/lib/tls_session_cache.js',
    'server/node_modules/undici-types/cache-interceptor.d.ts',
    'server/node_modules/undici-types/cache.d.ts',
    'server/stop.bat'
}
EXECUTABLE_SUFFIXES = {'.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx', '.node',
                       '.wasm', '.so', '.dll', '.dylib', '.py', '.sh', '.bash',
                       '.bat', '.cmd', '.ps1'}
PUBLIC_SUFFIXES = {
    '.html', '.htm', '.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx', '.css', '.scss',
    '.sass', '.less', '.json', '.yml', '.yaml', '.py', '.sh', '.bash', '.bat',
    '.cmd', '.ps1', '.md', '.markdown', '.txt', '.svg', '.png', '.jpg', '.jpeg',
    '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.map',
    '.node', '.wasm', '.so', '.dll', '.dylib', '.c', '.cc', '.cpp', '.h', '.gyp',
    '.gypi', '.lock'
}
PRIVATE_DIRS = {
    'data', 'private', 'secret', 'secrets', 'credential', 'credentials', 'config',
    'configuration', 'log', 'logs', 'backup', 'backups', 'repair-backup', 'archive',
    'archives', 'cache', 'tmp', 'temp', '__pycache__', '.git', '.cache', '.idea',
    '.vscode', 'coverage', 'uploads', 'upload', 'exports', 'export'
}
PRIVATE_FILE_PART = re.compile(r'(^|[-_.])(secrets?|credentials?|passwords?|tokens?|backups?|dumps?|logs?|archives?|caches?|configs?|private)([-_.]|$)', re.I)
PRIVATE_STRUCTURED = {'config', 'configuration', 'auth-users', 'organization-settings',
                      'snapshot', 'employees', 'personnel', 'attendance', 'overtime',
                      'leave_requests', 'leave-requests', 'settlements', 'performance', 'users', 'accounts'}
MANIFEST_TYPE = 'hr-web-source-permissions'


class Refused(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Refused(message)


def is_link(info):
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) & 0x400)


def checked_path(value):
    target = pathlib.Path(os.path.abspath(value))
    for part in [*reversed(target.parents), target]:
        info = part.lstat()
        require(not is_link(info), 'Symbolic links or junctions require separate review')
        if part != target:
            require(stat.S_ISDIR(info.st_mode), 'Source parent is not a directory')
    return target


def allowed_relative(relative, kind):
    if not isinstance(relative, str) or '\\' in relative or '\0' in relative:
        return False
    if relative == '.':
        return kind == 'directory'
    parts = relative.split('/')
    if any(part in ('', '.', '..') for part in parts) or pathlib.PurePosixPath(relative).is_absolute():
        return False
    if relative in PUBLIC_TEMPLATES or relative in PUBLIC_KNOWN_SOURCE:
        return kind == 'file'
    # A public directory is not proof that all its descendants are public.
    # Exclude credential/config/log/backup locations before stat, hashing or chmod.
    directory_parts = parts if kind == 'directory' else parts[:-1]
    for index, part in enumerate(directory_parts):
        lower = part.casefold()
        if (lower in PRIVATE_DIRS or '.env' in lower or PRIVATE_FILE_PART.search(lower)
                or lower.startswith('.') and not (index == 0 and part == '.github')
                and not (part == '.bin' and 'node_modules' in parts[:index])):
            return False
    if kind == 'file':
        name = parts[-1]
        lower = name.casefold()
        suffix = pathlib.PurePosixPath(lower).suffix
        if lower.startswith('.') and relative != '.gitignore' and not (lower == '.package-lock.json' and 'node_modules' in parts):
            return False
        if ('.env' in lower or PRIVATE_FILE_PART.search(lower)
                or suffix == '.json' and pathlib.PurePosixPath(lower).stem in PRIVATE_STRUCTURED):
            return False
        if suffix not in PUBLIC_SUFFIXES and lower not in {'license', 'notice', 'copying', 'authors', 'readme', 'makefile', 'codeowners', '.gitignore'}:
            # Dependency distributions may have extensionless executable entrypoints.
            if not ('node_modules' in parts and not suffix and any(part in ('bin', '.bin') for part in parts[:-1])):
                return False
    if parts[0] in PUBLIC_DIRS:
        return len(parts) > 1 or kind == 'directory'
    if parts[0] == 'server':
        if len(parts) == 1:
            return kind == 'directory'
        if parts[1] == 'node_modules':
            return len(parts) > 2 or kind == 'directory'
        return len(parts) == 2 and kind == 'file' and (parts[1] in SERVER_FILES or parts[1].endswith('.js'))
    return len(parts) == 1 and kind == 'file' and (relative in ROOT_FILES or pathlib.PurePosixPath(relative).suffix.lower() in ROOT_SUFFIXES)


def desired_mode(record):
    return 0o750 if record['kind'] == 'directory' or record['mode'] & 0o111 else 0o640


def identity(info):
    return (info.st_dev, info.st_ino)


def file_digest(target, expected_info):
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0)
    descriptor = os.open(target, flags)
    try:
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and identity(before) == identity(expected_info), 'Public source changed during inspection')
        digest = hashlib.sha256()
        with os.fdopen(descriptor, 'rb', closefd=False) as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
        after = os.fstat(descriptor)
        require((before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns), 'Public source changed while hashing')
        return digest.hexdigest()
    finally:
        os.close(descriptor)


def build_plan(app=APP, unprotected=None):
    """Inspect explicit public locations; never recurse through APP or server."""
    app = checked_path(app)
    records, issues = [], {'symlinks': 0, 'hardlinks': 0, 'unsupported': 0}

    def audit_unprotected(target, info=None):
        relative = target.relative_to(app).as_posix()
        dependency = relative.startswith('server/node_modules/')
        executable = target.suffix.lower() in EXECUTABLE_SUFFIXES
        if not dependency and not executable:
            return
        info = info or target.lstat()
        if is_link(info):
            issues['symlinks'] += 1
            return
        kind = 'directory' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) else None
        # No contents are read and excluded directories are never traversed.
        # Every excluded dependency directory needs review: read-only parent
        # permissions alone cannot prove its existing children are read-only.
        if unprotected is not None and (kind == 'file' and executable or kind == 'directory' and dependency):
            unprotected.append({'path': relative, 'kind': kind, 'uid': info.st_uid,
                                'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode),
                                'device': info.st_dev, 'inode': info.st_ino})

    def add(target):
        relative = target.relative_to(app).as_posix() or '.'
        info = target.lstat()
        if is_link(info):
            issues['symlinks'] += 1
            return False
        kind = 'directory' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) else None
        if kind is None:
            issues['unsupported'] += 1
            return False
        if not allowed_relative(relative, kind):
            audit_unprotected(target, info)
            return False
        if kind == 'file' and info.st_nlink != 1:
            issues['hardlinks'] += 1
            return False
        mode = stat.S_IMODE(info.st_mode)
        require(not mode & 0o7000, 'Special source permission bits require separate review')
        record = {'path': relative, 'kind': kind, 'uid': info.st_uid, 'gid': info.st_gid,
                  'mode': mode, 'device': info.st_dev, 'inode': info.st_ino}
        if kind == 'file':
            record['sha256'] = file_digest(target, info)
        records.append(record)
        return kind == 'directory'

    def walk(target):
        relative = target.relative_to(app).as_posix()
        # Reject private directory components before inspecting their entries.
        if not allowed_relative(relative, 'directory') and not allowed_relative(relative, 'file'):
            audit_unprotected(target)
            return
        if not add(target):
            return
        for entry in sorted(target.iterdir(), key=lambda p: p.name):
            walk(entry)

    add(app)
    # Listing names does not open excluded root files or their contents.
    for entry in sorted(app.iterdir(), key=lambda p: p.name):
        if entry.name in PUBLIC_DIRS:
            walk(entry)
        elif allowed_relative(entry.name, 'file'):
            add(entry)
        else:
            audit_unprotected(entry)
    server = app / 'server'
    if server.exists() or server.is_symlink():
        if add(server):
            for entry in sorted(server.iterdir(), key=lambda p: p.name):
                if entry.name == 'node_modules':
                    walk(entry)
                elif allowed_relative('server/' + entry.name, 'file'):
                    add(entry)
                else:
                    audit_unprotected(entry)
    return sorted(records, key=lambda r: (r['kind'] != 'directory', r['path'].count('/'), r['path'])), issues


def unprotected_source_issues(rows, service_uid, writable):
    require(len(rows) == len(writable) and all(type(value) is bool for value in writable), 'Invalid source-access inspection')
    return {
        'writableUnprotectedSource': sum(row['kind'] == 'file' and
            bool(access or row['uid'] != 0 or row['mode'] & 0o022)
            for row, access in zip(rows, writable)),
        'unreviewedDependencyDirectories': sum(row['kind'] == 'directory' for row in rows)
    }


def inspect_unprotected_source(rows):
    if not rows:
        return unprotected_source_issues([], 0, [])
    import pwd
    for row in rows:
        info = checked_path(APP / row['path']).lstat()
        require((info.st_dev, info.st_ino, info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) ==
                (row['device'], row['inode'], row['uid'], row['gid'], row['mode']),
                'Unreviewed source metadata changed during inspection')
    program = 'import json,os,sys\nprint(json.dumps([os.access(p,os.W_OK) for p in json.load(sys.stdin)]))'
    paths = [str(APP / row['path']) for row in rows]
    result = subprocess.run(['runuser', '-u', SERVICE_USER, '--', sys.executable, '-I', '-c', program],
                            input=json.dumps(paths).encode(), capture_output=True, timeout=60)
    require(result.returncode == 0, 'Could not inspect unprotected source write access')
    return unprotected_source_issues(rows, pwd.getpwnam(SERVICE_USER).pw_uid, json.loads(result.stdout))


def validate_manifest(document, app=APP):
    require(isinstance(document, dict) and document.get('schemaVersion') == 1 and document.get('type') == MANIFEST_TYPE and document.get('app') == str(app), 'Not a source-permission backup for this application')
    records = document.get('records')
    require(isinstance(records, list) and bool(records), 'Backup permission records are missing')
    if 'protectedGid' in document:
        require(type(document['protectedGid']) is int and 0 <= document['protectedGid'] < 2 ** 32, 'Invalid protected group')
    seen = set()
    for record in records:
        require(isinstance(record, dict), 'Invalid backup permission record')
        name, kind = record.get('path'), record.get('kind')
        require(kind in ('file', 'directory') and allowed_relative(name, kind) and name not in seen, 'Unsafe or duplicate backup path')
        seen.add(name)
        for field in ('uid', 'gid', 'device', 'inode', 'mode'):
            value = record.get(field)
            require(type(value) is int and 0 <= value < 2 ** 64, 'Invalid backup metadata')
        require(record['mode'] <= 0o777 and record['uid'] < 2 ** 32 and record['gid'] < 2 ** 32, 'Unsafe backup permission or owner')
        if kind == 'file':
            require(isinstance(record.get('sha256'), str) and re.fullmatch(r'[a-f0-9]{64}', record['sha256']), 'Invalid observed source digest')
    require('.' in seen and 'server' in seen and 'server/server.js' in seen, 'Incomplete source-permission backup')
    for record in records:
        parent = pathlib.PurePosixPath(record['path']).parent.as_posix()
        require(record['path'] == '.' or parent in seen, 'Backup source parent is missing')
    return records


def assert_unchanged(records, app=APP, expected_protected=False, protected_gid=None):
    if expected_protected:
        require(type(protected_gid) is int and protected_gid >= 0, 'Expected protected group is required')
    for record in records:
        target = checked_path(app / record['path'])
        info = target.lstat()
        require(identity(info) == (record['device'], record['inode']), 'Source identity changed; refusing metadata changes')
        require(stat.S_ISDIR(info.st_mode) if record['kind'] == 'directory' else stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'Source type or hardlink count changed')
        original = (record['uid'], record['gid'], record['mode'])
        protected = (0, protected_gid, desired_mode(record))
        actual = (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode))
        require(actual == protected if expected_protected else actual == original, 'Source permissions changed during inspection')
        if record['kind'] == 'file':
            require(file_digest(target, info) == record['sha256'], 'Source contents changed; not restoring an old permission state')


def change_metadata(record, uid, gid, mode, app=APP):
    # Parents are protected before children. O_NOFOLLOW and fstat bind the
    # operation to the inspected inode instead of following replacement links.
    target = checked_path(app / record['path'])
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    if record['kind'] == 'directory':
        flags |= getattr(os, 'O_DIRECTORY', 0)
    descriptor = os.open(target, flags)
    try:
        info = os.fstat(descriptor)
        require(identity(info) == (record['device'], record['inode']), 'Source inode changed before permission update')
        os.fchown(descriptor, uid, gid)
        os.fchmod(descriptor, mode)
    finally:
        os.close(descriptor)


def restore_records(records, app=APP):
    failures = []
    for record in reversed(records):
        try:
            change_metadata(record, record['uid'], record['gid'], record['mode'], app)
        except Exception:
            failures.append(record['path'])
    require(not failures, 'Permission recovery needs manual review for ' + str(len(failures)) + ' public paths')


def system_value(name):
    result = subprocess.run(['systemctl', 'show', SERVICE, '-p', name, '--value'], capture_output=True, timeout=15)
    require(result.returncode == 0, 'Could not inspect the HR service')
    return result.stdout.decode().strip()


def service_identity():
    require(system_value('User') == SERVICE_USER and system_value('WorkingDirectory') == str(APP), 'Unexpected HR service user or working directory')
    require(system_value('Group') in ('', SERVICE_USER), 'Custom systemd group requires separate review')
    result = subprocess.run(['systemctl', 'is-active', '--quiet', SERVICE], capture_output=True, timeout=15)
    require(result.returncode == 0, 'HR service must already be running')
    pid = system_value('MainPID')
    require(re.fullmatch(r'[1-9][0-9]*', pid), 'HR service has no running PID')
    require(pathlib.Path('/proc', pid, 'cwd').resolve(strict=True) == APP, 'Running HR service uses a different application directory')
    return pid


def service_group():
    import grp
    import pwd
    gid = pwd.getpwnam(SERVICE_USER).pw_gid
    require(grp.getgrgid(gid).gr_name == SERVICE_USER, 'Expected the existing hrsystem primary group')
    return gid


def verify_health(pid):
    require(service_identity() == pid, 'HR service PID changed; this tool never restarts it')
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with client.open('http://127.0.0.1:8080/api/auth/status', timeout=10) as response:
        payload = json.loads(response.read(2048))
        require(response.status == 200 and payload.get('ok') is True and payload.get('setupRequired') is False, 'Existing authentication health check failed')


def private_write_state():
    """Only lstat and access checks: never open config or enumerate data."""
    import pwd
    owner = pwd.getpwnam(SERVICE_USER).pw_uid
    observed = {}
    for relative, directory in (('server/config.json', False), ('server/data', True)):
        target = checked_path(APP / relative)
        info = target.lstat()
        require((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)) and info.st_uid == owner,
                'Expected existing service-owned config and data paths; review custom layouts separately')
        for access in ('-w', '-x') if directory else ('-w',):
            result = subprocess.run(['runuser', '-u', SERVICE_USER, '--', 'test', access, str(target)], capture_output=True, timeout=10)
            require(result.returncode == 0, 'Existing config or data is not writable by the service user')
        observed[relative] = (info.st_dev, info.st_ino, info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode))
    return observed


def verify_source_readable(records):
    program = "import json,os,sys\nrows=json.load(sys.stdin)\nfailed=sum(not os.access(r['path'],os.R_OK | (os.X_OK if r['directory'] else 0)) for r in rows)\nprint(failed)\nsys.exit(bool(failed))"
    paths = [{'path': str(APP / row['path']), 'directory': row['kind'] == 'directory'} for row in records]
    result = subprocess.run(['runuser', '-u', SERVICE_USER, '--', sys.executable, '-I', '-c', program],
                            input=json.dumps(paths).encode(), capture_output=True, timeout=60)
    require(result.returncode == 0 and result.stdout.strip() == b'0', 'Service user cannot read or traverse every protected source path')


def public_response_state():
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    observed = {}
    for route in ('/index.html', '/js/app.js'):
        bodies = []
        for origin, host in (('http://127.0.0.1:8080', None), ('http://127.0.0.1', '123.56.175.4')):
            headers = {'Accept-Encoding': 'identity'}
            if host:
                headers['Host'] = host
            with client.open(urllib.request.Request(origin + route, headers=headers), timeout=10) as response:
                require(response.status == 200, 'Existing public page or script is unavailable')
                bodies.append(hashlib.sha256(response.read()).hexdigest())
        require(bodies[0] == bodies[1], 'Nginx does not serve the expected Node application')
        observed[route] = bodies[0]
    return observed


def secure_backup_root():
    checked_path(BACKUPS.parent)
    if not BACKUPS.exists():
        BACKUPS.mkdir(mode=0o700)
    target = checked_path(BACKUPS)
    info = target.stat()
    require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700, 'Backup root must be root-owned with mode 0700')
    return target


def save_manifest(records, pid, protected_gid):
    parent = secure_backup_root()
    prefix = datetime.datetime.now().strftime('%Y-%m-%d-source-protection-%H%M%S-')
    backup = pathlib.Path(tempfile.mkdtemp(prefix=prefix, dir=parent))
    document = {'schemaVersion': 1, 'type': MANIFEST_TYPE, 'app': str(APP), 'service': SERVICE,
                'pid': pid, 'protectedGid': protected_gid, 'hashMeaning': 'Observed public-code bytes, not a signed or approved-release attestation', 'records': records}
    raw = (json.dumps(document, ensure_ascii=True, indent=2) + '\n').encode()
    (backup / 'permissions.json').write_bytes(raw)
    (backup / 'permissions.sha256').write_text(hashlib.sha256(raw).hexdigest() + '\n', encoding='ascii')
    for name in ('permissions.json', 'permissions.sha256'):
        os.chmod(backup / name, 0o600)
    return backup


def load_manifest(backup):
    backup = checked_path(backup)
    require(backup.parent == checked_path(BACKUPS) and re.fullmatch(r'\d{4}-\d{2}-\d{2}-source-protection-[\w-]+', backup.name), 'Rollback must use a direct source-protection backup under the fixed backup root')
    info = backup.stat()
    require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700, 'Unsafe backup directory ownership or permissions')
    paths = [checked_path(backup / name) for name in ('permissions.json', 'permissions.sha256')]
    for target in paths:
        info = target.stat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600, 'Unsafe permission-manifest file')
    require(paths[0].stat().st_size <= 32 * 1024 * 1024 and paths[1].stat().st_size <= 100, 'Permission backup is oversized')
    raw = paths[0].read_bytes()
    require(hashlib.sha256(raw).hexdigest() == paths[1].read_text(encoding='ascii').strip(), 'Permission backup digest does not match')
    document = json.loads(raw)
    require(document.get('protectedGid') == service_group(), 'Service primary group changed since protection')
    return validate_manifest(document)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--check', action='store_true', help='Read-only check; this is the default')
    modes.add_argument('--apply', action='store_true', help='Protect only the listed public source metadata')
    modes.add_argument('--rollback', metavar='BACKUP', help='Restore metadata from this tool\'s root-owned backup')
    args = parser.parse_args(argv)
    require(os.name == 'posix' and os.geteuid() == 0, 'Run as root on the existing Linux host')
    require(APP == pathlib.Path('/opt/hr-system'), 'Application directory must not be overridden')
    checked_path(APP)
    # Root controls the parent, so the application user cannot rename APP while
    # its own directory permissions are being tightened.
    parent = APP.parent.stat()
    require(parent.st_uid == 0 and not stat.S_IMODE(parent.st_mode) & 0o022, 'Application parent must be controlled by root')
    pid = service_identity()
    protected_gid = service_group()
    private_before = private_write_state()
    public_before = public_response_state()
    unprotected = []
    records, issues = build_plan(unprotected=unprotected)
    issues.update(inspect_unprotected_source(unprotected))
    require(any(record['path'] == 'server/server.js' for record in records), 'Existing HR backend source is missing')
    ready = not any(issues.values())
    if args.rollback:
        require(ready, 'Source links or unusual files require separate review before rollback')
        old = load_manifest(args.rollback)
        require({r['path'] for r in old} == {r['path'] for r in records}, 'Source file set changed since protection; review before rollback')
        assert_unchanged(old, expected_protected=True, protected_gid=protected_gid)
        restore_records(old)
        verify_health(pid)
        require(private_write_state() == private_before, 'Private config or data metadata changed during rollback')
        require(public_response_state() == public_before, 'Public page or script changed during rollback')
        print(json.dumps({'status': 'WEB_SOURCE_PERMISSIONS_ROLLED_BACK', 'restoredPaths': len(old), 'serviceRestarted': False}), flush=True)
        return
    summary = {'status': 'SOURCE_PROTECTION_CHECK', 'protectedPaths': len(records),
               'files': sum(r['kind'] == 'file' for r in records), 'issues': issues,
               'needsChange': sum((r['uid'], r['gid'], r['mode']) != (0, protected_gid, desired_mode(r)) for r in records),
               'readyToApply': ready, 'privateContentsRead': False, 'privateMetadataChecked': True, 'serviceRestarted': False}
    if not args.apply:
        verify_health(pid)
        print(json.dumps(summary), flush=True)
        return
    require(ready, 'Source protection preflight requires review (' + json.dumps(issues, sort_keys=True) + '); no permissions were changed')
    validate_manifest({'schemaVersion': 1, 'type': MANIFEST_TYPE, 'app': str(APP), 'records': records})
    assert_unchanged(records)
    backup = save_manifest(records, pid, protected_gid)
    changed = []
    try:
        for record in records:
            # Record before either fchown/fchmod: a partial metadata operation
            # must also be rolled back if the second syscall fails.
            changed.append(record)
            change_metadata(record, 0, protected_gid, desired_mode(record))
        assert_unchanged(records, expected_protected=True, protected_gid=protected_gid)
        final_unprotected = []
        final_records, final_issues = build_plan(unprotected=final_unprotected)
        require({row['path'] for row in final_records} == {row['path'] for row in records}, 'Public source set changed during protection')
        require(final_unprotected == unprotected, 'Unreviewed source metadata changed during protection')
        final_issues.update(inspect_unprotected_source(final_unprotected))
        require(not any(final_issues.values()), 'Unreviewed source appeared during protection')
        verify_source_readable(records)
        verify_health(pid)
        require(private_write_state() == private_before, 'Private config or data metadata changed during protection')
        require(public_response_state() == public_before, 'Nginx/Node public page changed after protection; refusing broader other-user permissions')
        (backup / 'WEB_SOURCE_PROTECTED').write_text('Public source metadata protected; service and private data untouched.\n', encoding='utf-8')
        print(json.dumps({'status': 'WEB_SOURCE_PROTECTED', 'backup': str(backup), 'protectedPaths': len(records),
                          'serviceRestarted': False, 'privateDataTouched': False, 'rootCanStillMaintainCode': True}), flush=True)
    except BaseException:
        restore_records(changed)
        raise


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
        print('Source protection stopped: ' + (str(error) if isinstance(error, Refused) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
