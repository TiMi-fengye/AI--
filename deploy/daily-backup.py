#!/usr/bin/env python3
"""Private, online, timestamped recovery backups for the fixed HR installation.

No application restart, source changes, retention deletion or HTTP download
endpoint. Only a stable file inventory bracketed by equal deterministic SQL
dumps can be published as complete. All sensitive bytes stay on this host.
"""
import argparse
import contextlib
import datetime
import hashlib
import io
import json
import os
import pathlib
import re
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
from zoneinfo import ZoneInfo

APP = pathlib.Path('/opt/hr-system')
DATA = APP / 'server/data'
BACKUPS = pathlib.Path('/var/backups/hr-system/daily')
SERVICE = 'hr-system.service'
OWNER = 'hrsystem'
SCHEMA = 'hr-system-daily-backup'
NAME_PATTERN = re.compile(r'\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\+0800-[a-f0-9]{12}')
APP_EXCLUDES = {'server/data', 'server/repair-backup', '.git', '.delivery'}
IGNORED_COMPONENTS = {'__pycache__', '.cache', 'logs', 'log', 'backups', 'backup', 'tmp', 'temp'}
TAR_ARTIFACTS = {'app.tar.gz', 'runtime-data.tar.gz', 'service-config.tar.gz'}
BASE_ARTIFACTS = TAR_ARTIFACTS | {'runtime-environment.json'}
SERVICE_CONFIG_FILES = {'etc/systemd/system/' + SERVICE, 'etc/nginx/nginx.conf'}
SERVICE_CONFIG_DIRS = {'etc/systemd/system/' + SERVICE + '.d', 'etc/hr-system', 'etc/nginx/sites-available'}
# Reviewed public schema identifiers, never discovered from credential files or
# inferred from dump contents. Every business and identity table is included in
# the existing whole-database transactional dump.
RELATIONAL_TABLES = frozenset({
    'hr_schema_meta', 'hr_employees', 'hr_attendance', 'hr_overtime', 'hr_leave_requests',
    'hr_settlements', 'hr_departments', 'hr_update_logs', 'hr_performance',
    'hr_approval_notifications', 'hr_approval_history', 'hr_settlement_records',
    'hr_notification_deliveries', 'hr_notification_parameters', 'hr_performance_scores',
    'hr_organization_nodes', 'hr_sync_properties', 'hr_auth_meta', 'hr_accounts',
    'hr_account_buildings', 'hr_account_regions', 'hr_organization_option_keys',
    'hr_organization_options', 'hr_organization_leaders'})


class Refused(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Refused(message)


def timestamp_name(now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    require(now.tzinfo is not None, 'Timestamp must have an explicit timezone')
    return now.astimezone(ZoneInfo('Asia/Shanghai')).strftime('%Y-%m-%d_%H-%M-%S%z') + '-' + secrets.token_hex(6)


def safe_relative(name):
    if not isinstance(name, str) or not name or '\\' in name or '\0' in name:
        raise Refused('Unsafe archive member path')
    require(name == '.' or not name.startswith('/') and not re.match(r'^[A-Za-z]:', name) and all(p not in ('', '.', '..') for p in name.split('/')),
            'Unsafe archive member path')
    return name


def service_config_member(name):
    safe_relative(name)
    return name in SERVICE_CONFIG_FILES or any(name == parent or name.startswith(parent + '/') for parent in SERVICE_CONFIG_DIRS)


def sync_file(path):
    with open(path, 'r+b') as stream:
        stream.flush()
        os.fsync(stream.fileno())


def sync_directory(path):
    if os.name == 'posix':
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def checked_path(value):
    target = pathlib.Path(os.path.abspath(value))
    for part in [*reversed(target.parents), target]:
        info = part.lstat()
        require(not stat.S_ISLNK(info.st_mode) and not getattr(info, 'st_file_attributes', 0) & 0x400,
                'Symbolic links or junctions need separate backup review')
        if part != target:
            require(stat.S_ISDIR(info.st_mode), 'Backup parent is not a directory')
    return target


@contextlib.contextmanager
def open_source(root, relative='.', directory=False):
    """Bind every POSIX path component, not merely the final file, without links."""
    safe_relative(relative)
    root = pathlib.Path(os.path.abspath(root))
    if os.name != 'posix':
        target = checked_path(root / relative)
        if directory:
            yield None
        else:
            with open(target, 'rb') as stream:
                yield stream.fileno()
        return
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY
    descriptor = os.open('/', flags)
    try:
        components = list(root.parts[1:]) + ([] if relative == '.' else relative.split('/'))
        for index, component in enumerate(components):
            last = index == len(components) - 1
            child = os.open(component, (os.O_RDONLY | os.O_NOFOLLOW) if last and not directory else flags,
                            dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        yield descriptor
    finally:
        os.close(descriptor)


def info_record(name, info, kind):
    require(not stat.S_IMODE(info.st_mode) & 0o7000, 'Special permission bits need separate backup review')
    return {'path': name, 'type': kind, 'uid': info.st_uid, 'gid': info.st_gid,
            'mode': stat.S_IMODE(info.st_mode), 'device': info.st_dev, 'inode': info.st_ino,
            'size': info.st_size if kind == 'file' else 0,
            'mtime_ns': info.st_mtime_ns, 'ctime_ns': info.st_ctime_ns}


def digest_stream(stream):
    value = hashlib.sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b''):
        value.update(block)
    return value.hexdigest()


def file_record(root, name):
    with open_source(root, name) as descriptor:
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, 'Special or hardlinked file needs review')
        row = info_record(name, before, 'file')
        with os.fdopen(os.dup(descriptor), 'rb') as stream:
            row['sha256'] = digest_stream(stream)
        require(info_record(name, os.fstat(descriptor), 'file') == {k: v for k, v in row.items() if k != 'sha256'},
                'Source changed while reading; retry during a stable window')
        return row


def scan_tree(root, exclude=(), ignore_components=()):
    root = checked_path(root)
    exclude = set(exclude)
    records = []

    def visit(name):
        if name in exclude or any(name.startswith(item + '/') for item in exclude):
            return
        if name != '.' and set(name.split('/')).intersection(ignore_components):
            return
        target = root / name
        info = target.lstat()
        require(not stat.S_ISLNK(info.st_mode) and not getattr(info, 'st_file_attributes', 0) & 0x400,
                'Symbolic links or junctions need separate backup review')
        if stat.S_ISDIR(info.st_mode):
            with open_source(root, name, directory=True) as descriptor:
                before = os.fstat(descriptor) if descriptor is not None else target.stat()
                records.append(info_record(name, before, 'directory'))
                with os.scandir(descriptor if descriptor is not None else target) as entries:
                    children = sorted(entry.name for entry in entries)
                for child in children:
                    visit(child if name == '.' else name + '/' + child)
                after = os.fstat(descriptor) if descriptor is not None else target.stat()
                require(info_record(name, before, 'directory') == info_record(name, after, 'directory'),
                        'Directory changed while reading; retry during a stable window')
        elif stat.S_ISREG(info.st_mode):
            records.append(file_record(root, name))
        else:
            raise Refused('Special file needs separate backup review')

    visit('.')
    return sorted(records, key=lambda row: row['path'])


def write_archive(target, root, records):
    with tarfile.open(target, 'w:gz', compresslevel=6) as archive:
        for row in records:
            safe_relative(row['path'])
            member = tarfile.TarInfo(row['path'])
            member.mode, member.uid, member.gid = row['mode'], row['uid'], row['gid']
            member.mtime = row['mtime_ns'] // 1000000000
            if row['type'] == 'directory':
                member.type = tarfile.DIRTYPE
                archive.addfile(member)
                continue
            current = file_record(root, row['path'])
            require(current == row, 'Source changed before archive capture')
            member.size = row['size']
            with open_source(root, row['path']) as descriptor:
                info = os.fstat(descriptor)
                require(info_record(row['path'], info, 'file') == {k: v for k, v in row.items() if k != 'sha256'},
                        'Source changed before archive capture')
                with os.fdopen(os.dup(descriptor), 'rb') as stream:
                    archive.addfile(member, stream)
    os.chmod(target, 0o600)
    sync_file(target)
    verify_archive(target, records)


def verify_archive(path, expected_records):
    expected = {row['path']: row for row in expected_records}
    require(len(expected) == len(expected_records), 'Duplicate source inventory entry')
    seen = set()
    with tarfile.open(path, 'r:gz') as archive:
        for member in archive:
            name = safe_relative(member.name)
            require(name not in seen and name in expected, 'Duplicate or unlisted archive member')
            seen.add(name)
            row = expected[name]
            require((member.isdir() if row['type'] == 'directory' else member.isfile()) and
                    not member.issym() and not member.islnk() and
                    (member.uid, member.gid, member.mode) == (row['uid'], row['gid'], row['mode']),
                    'Archive member type or permission mismatch')
            if member.isfile():
                require(member.size == row['size'], 'Archive member size mismatch')
                stream = archive.extractfile(member)
                require(stream is not None and digest_stream(stream) == row['sha256'], 'Archive member digest mismatch')
    require(seen == set(expected), 'Archive source inventory is incomplete')
    return True


def run(arguments, *, output=None, timeout=30):
    result = subprocess.run([str(arg) for arg in arguments], stdout=output if output else subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout)
    require(result.returncode == 0, pathlib.Path(str(arguments[0])).name + ' command failed')
    return result.stdout or b''


def validate_storage_layout(layout):
    require(isinstance(layout, dict) and set(layout) == {'model', 'schemaVersion', 'tables'},
            'Invalid database storage description')
    names = layout['tables']
    require(isinstance(names, list) and
            all(isinstance(name, str) and re.fullmatch(r'[a-z_]+', name) for name in names) and
            names == sorted(set(names)),
            'Invalid database table inventory')
    if layout['model'] == 'legacy_snapshot':
        require(type(layout['schemaVersion']) is int and layout['schemaVersion'] == 0 and
                names == ['system_snapshots'], 'Unknown legacy database layout')
    else:
        require(layout['model'] == 'relational' and type(layout['schemaVersion']) is int and
                layout['schemaVersion'] == 1 and
                set(names) in (RELATIONAL_TABLES, RELATIONAL_TABLES | {'system_snapshots'}),
                'Unknown relational database layout')
    return layout


def database_layout(settings):
    """Read only metadata: fail closed on partial/unknown schema migrations."""
    database = settings.get('database')
    require(isinstance(database, str) and re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_-]{0,63}', database),
            'Invalid database identifier')
    prefix = ['mysql', '--protocol=socket', '-uroot', database, '-NBe']
    raw = run([*prefix, 'SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY TABLE_NAME'])
    try:
        names = raw.decode('ascii').splitlines()
    except UnicodeError:
        raise Refused('Unreviewed database table identifiers')
    if names == ['system_snapshots']:
        return validate_storage_layout({'model': 'legacy_snapshot', 'schemaVersion': 0, 'tables': names})
    require(set(names) in (RELATIONAL_TABLES, RELATIONAL_TABLES | {'system_snapshots'}),
            'Incomplete or unreviewed database schema needs review')
    marker = run([*prefix, 'SELECT schema_version,initialized,(SELECT COUNT(*) FROM hr_schema_meta) FROM hr_schema_meta WHERE id=1'])
    require(marker.strip() == b'1\t1\t1', 'Relational migration is incomplete or unsupported')
    identity = run([*prefix, 'SELECT meta_key,schema_version FROM hr_auth_meta ORDER BY meta_key'])
    require(identity.strip() == b'organization\t1\nusers\t1', 'Relational identity migration is incomplete or unsupported')
    return validate_storage_layout({'model': 'relational', 'schemaVersion': 1, 'tables': names})


def system_value(name):
    return run(['systemctl', 'show', SERVICE, '-p', name, '--value']).decode().strip()


def health(ctx):
    require(system_value('MainPID') == ctx['pid'], 'Application PID changed during backup')
    run(['systemctl', 'is-active', '--quiet', SERVICE])
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with client.open('http://127.0.0.1:' + str(ctx['port']) + '/api/auth/status', timeout=10) as response:
        body = json.loads(response.read(4096))
        require(response.status == 200 and body.get('ok') is True and body.get('setupRequired') is False,
                'Existing application health check failed')


def runtime():
    checked_path(APP)
    require(system_value('User') == OWNER and system_value('WorkingDirectory') == str(APP), 'Unexpected HR service layout')
    require(system_value('Group') in ('', OWNER), 'Custom service group needs separate review')
    run(['systemctl', 'is-active', '--quiet', SERVICE])
    pid = system_value('MainPID')
    require(re.fullmatch(r'[1-9][0-9]*', pid) is not None and pathlib.Path('/proc', pid, 'cwd').resolve() == APP,
            'Unexpected application process')
    environment = {}
    for item in pathlib.Path('/proc', pid, 'environ').read_bytes().split(b'\0'):
        key, separator, value = item.partition(b'=')
        if separator and key.startswith(b'HR_'):
            environment[key.decode('ascii')] = value.decode('utf-8')
    config = json.loads(checked_path(APP / 'server/config.json').read_text(encoding='utf-8-sig'))
    require(isinstance(config, dict), 'Invalid private application configuration')
    configured_data = pathlib.Path(environment.get('HR_DATA_DIR') or str(DATA))
    if not configured_data.is_absolute():
        configured_data = APP / configured_data
    require(pathlib.Path(os.path.abspath(configured_data)) == DATA, 'Custom data location needs separate backup review')
    checked_path(DATA)
    mysql = config.get('mysql') or {}
    enabled = str(environment.get('HR_MYSQL_ENABLED') or bool(mysql.get('enabled'))).lower() == 'true'
    settings = {'enabled': enabled, 'host': environment.get('HR_MYSQL_HOST') or mysql.get('host') or '127.0.0.1',
                'port': int(environment.get('HR_MYSQL_PORT') or mysql.get('port') or 3306),
                'database': environment.get('HR_MYSQL_DATABASE') or mysql.get('database') or 'hr_system'}
    if enabled:
        require(settings['host'] in ('localhost', '127.0.0.1') and settings['port'] == 3306 and
                re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_-]{0,63}', settings['database']), 'Custom database layout needs separate backup review')
        require(shutil.which('mysqldump') is not None, 'MySQL dump utility is not installed')
        require(run(['mysql', '--protocol=socket', '-uroot', '-NBe', 'SELECT @@port']).strip() == b'3306',
                'Local MySQL socket does not match the application port')
        query = "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='" + settings['database'] + "' AND table_type='BASE TABLE' AND ENGINE<>'InnoDB'"
        require(run(['mysql', '--protocol=socket', '-uroot', '-NBe', query]).strip() == b'0', 'Nontransactional tables need separate backup review')
        settings['storage'] = database_layout(settings)
    port = int(environment.get('HR_PORT') or config.get('port') or 8080)
    require(0 < port < 65536, 'Invalid application port')
    files = system_value('EnvironmentFiles')
    declared = re.findall(r'(/[^\s;]+)\s+\(ignore_errors=(?:yes|no)\)', files)
    require(not files or declared and len(declared) == files.count('(ignore_errors='), 'Unrecognized systemd environment-file layout')
    require(all(pathlib.PurePosixPath(name).parent == pathlib.PurePosixPath('/etc/hr-system') for name in declared),
            'Custom environment-file location needs separate backup review')
    require(system_value('FragmentPath') == '/etc/systemd/system/' + SERVICE, 'Custom service unit location needs separate review')
    dropins = system_value('DropInPaths').split()
    require(all(pathlib.PurePosixPath(path).parent == pathlib.PurePosixPath('/etc/systemd/system/' + SERVICE + '.d') for path in dropins),
            'Custom service drop-in location needs separate backup review')
    ctx = {'app': APP, 'data': DATA, 'pid': pid, 'port': port, 'mysql': settings, 'environment': environment}
    health(ctx)
    return ctx


def config_inventory():
    records = []
    paths = ['/etc/systemd/system/' + SERVICE, '/etc/systemd/system/' + SERVICE + '.d',
             '/etc/hr-system', '/etc/nginx/nginx.conf', '/etc/nginx/sites-available']
    require(pathlib.Path(paths[0]).exists(), 'Service configuration is missing')
    for value in paths:
        target = pathlib.Path(value)
        if not target.exists() and not target.is_symlink():
            continue
        checked_path(target)
        if target.is_dir():
            subset = scan_tree(target)
            for row in subset:
                row = dict(row, path=target.relative_to('/').as_posix() + ('' if row['path'] == '.' else '/' + row['path']))
                records.append(row)
        else:
            records.append(file_record(pathlib.Path('/'), target.relative_to('/').as_posix()))
    return sorted(records, key=lambda row: row['path'])


def inventories(ctx):
    return {'app.tar.gz': scan_tree(ctx['app'], APP_EXCLUDES, IGNORED_COMPONENTS),
            'runtime-data.tar.gz': scan_tree(ctx['data']), 'service-config.tar.gz': config_inventory()}


def mysql_dump(ctx, destination):
    arguments = ['mysqldump', '--protocol=socket', '-uroot', '--single-transaction', '--skip-lock-tables',
                 '--no-tablespaces', '--routines', '--triggers', '--events', '--hex-blob', '--order-by-primary',
                 '--skip-comments', '--skip-dump-date', '--set-gtid-purged=OFF', '--column-statistics=0',
                 '--default-character-set=utf8mb4', ctx['mysql']['database']]
    with open(destination, 'xb') as stream:
        run(arguments, output=stream, timeout=600)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(destination, 0o600)
    require(destination.stat().st_size > 0, 'Database backup is empty')


def artifact_record(path, kind, records=None):
    with open(path, 'rb') as stream:
        result = {'size': path.stat().st_size, 'sha256': digest_stream(stream), 'kind': kind}
    if records is not None:
        result['records'] = records
    return result


def validate_manifest(document):
    require(isinstance(document, dict) and document.get('schemaVersion') == 1 and document.get('type') == SCHEMA and document.get('state') == 'complete', 'Invalid backup manifest')
    require(isinstance(document.get('timestamp'), str) and NAME_PATTERN.fullmatch(document['timestamp']), 'Invalid backup timestamp')
    require(isinstance(document.get('runtime'), dict) and document['runtime'].get('app') == str(APP) and document['runtime'].get('dataPath') == str(DATA), 'Backup targets a different application')
    require(type(document['runtime'].get('port')) is int and 0 < document['runtime']['port'] < 65536, 'Invalid backup application port')
    require(isinstance(document.get('createdAt'), str) and len(document['createdAt']) < 128, 'Invalid backup creation time')
    try:
        created = datetime.datetime.fromisoformat(document['createdAt'])
    except ValueError:
        raise Refused('Invalid backup creation time')
    require(created.utcoffset() == datetime.timedelta(hours=8) and document['timestamp'].startswith(created.strftime('%Y-%m-%d_%H-%M-%S%z') + '-'),
            'Backup timestamp and creation time differ')
    mysql = document['runtime'].get('mysql')
    require(isinstance(mysql, dict) and type(mysql.get('enabled')) is bool, 'Invalid database backup mode')
    if mysql['enabled']:
        require(mysql.get('host') in ('localhost', '127.0.0.1') and mysql.get('port') == 3306 and
                isinstance(mysql.get('database'), str) and re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_-]{0,63}', mysql['database']), 'Invalid backup database target')
        # Earlier verified backups predate storage metadata and remain valid.
        if 'storage' in mysql:
            validate_storage_layout(mysql['storage'])
    artifacts = document.get('artifacts')
    require(isinstance(artifacts, dict) and set(artifacts) == BASE_ARTIFACTS | ({'mysql.sql'} if mysql['enabled'] else set()), 'Backup artifact set is incomplete')
    for name, item in artifacts.items():
        safe_relative(name)
        require(isinstance(item, dict) and type(item.get('size')) is int and item['size'] >= 0 and
                isinstance(item.get('sha256'), str) and re.fullmatch(r'[0-9a-f]{64}', item['sha256']), 'Invalid artifact digest or size')
        require(item.get('kind') == ('tar' if name in TAR_ARTIFACTS else 'file'), 'Invalid artifact format')
        if name in TAR_ARTIFACTS:
            rows = item.get('records')
            require(isinstance(rows, list) and rows, 'Missing archive inventory')
            seen = set()
            for row in rows:
                require(isinstance(row, dict), 'Invalid archive inventory')
                safe_relative(row.get('path'))
                if name == 'service-config.tar.gz':
                    require(service_config_member(row['path']), 'Service-config member is outside the reviewed configuration paths')
                require(row['path'] not in seen and row.get('type') in ('file', 'directory'), 'Duplicate archive inventory entry')
                require(row['path'] != '.' or row['type'] == 'directory', 'Archive root must be a directory')
                seen.add(row['path'])
                for key in ('uid', 'gid', 'mode', 'device', 'inode', 'size', 'mtime_ns', 'ctime_ns'):
                    require(type(row.get(key)) is int and 0 <= row[key] < 2**64, 'Invalid source metadata')
                require(row['uid'] < 2**32 and row['gid'] < 2**32 and row['mode'] <= 0o777, 'Unsafe archive owner or mode')
                if row['type'] == 'file':
                    require(isinstance(row.get('sha256'), str) and re.fullmatch(r'[0-9a-f]{64}', row['sha256']), 'Invalid source digest')
    return document


def verify_backup(path, require_root=True):
    path = checked_path(path)
    if require_root:
        require(path.parent == BACKUPS and NAME_PATTERN.fullmatch(path.name), 'Backup must be a direct timestamp directory')
        info = path.stat()
        require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700, 'Backup directory is not private')
    def read_private(name, limit):
        target = checked_path(path / name)
        info = target.stat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= limit, 'Invalid backup metadata file')
        if require_root:
            require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600, 'Backup file is not private')
        return target.read_bytes()
    raw = read_private('manifest.json', 64 * 1024 * 1024)
    require(read_private('COMPLETE', 100).decode('ascii').strip() == hashlib.sha256(raw).hexdigest(), 'Backup completion digest mismatch')
    document = validate_manifest(json.loads(raw))
    require(path.name == document['timestamp'] or not require_root, 'Backup folder and manifest timestamp differ')
    require({entry.name for entry in path.iterdir()} == set(document['artifacts']) | {'manifest.json', 'COMPLETE'}, 'Unlisted backup files require review')
    for name, item in document['artifacts'].items():
        target = checked_path(path / name)
        info = target.stat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'Backup artifact is not a regular private file')
        if require_root:
            require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600, 'Backup artifact is not private')
        require(artifact_record(target, item['kind']) == {k: v for k, v in item.items() if k != 'records'}, 'Backup artifact digest mismatch')
        if name in TAR_ARTIFACTS:
            verify_archive(target, item['records'])
    return document


def ensure_backup_root(root=BACKUPS):
    for path in (root.parent, root):
        if not path.exists():
            checked_path(path.parent)
            path.mkdir(mode=0o700)
        checked_path(path)
        info = path.stat()
        require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700, 'Backup directories must be root-owned mode 0700')


def write_private(path, data):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def run_backup(ctx=None, root=BACKUPS, attempts=3):
    ctx = ctx or runtime()
    ensure_backup_root(root)
    import fcntl
    descriptor = os.open(root.parent / '.daily-backup.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'a+b') as lock:
        lock_info = os.fstat(lock.fileno())
        require(stat.S_ISREG(lock_info.st_mode) and lock_info.st_nlink == 1 and lock_info.st_uid == 0 and stat.S_IMODE(lock_info.st_mode) == 0o600,
                'Backup lock is not private')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused('Another backup or recovery operation is running')
        for attempt in range(attempts):
            stage = pathlib.Path(tempfile.mkdtemp(prefix='.incomplete-', dir=root))
            destination, renamed, published = None, False, False
            phase = 'source-inventory'
            try:
                first = inventories(ctx)
                needed = sum(row['size'] for rows in first.values() for row in rows) * 3 + 64 * 1024 * 1024
                require(shutil.disk_usage(root).free >= needed, 'Not enough free space; existing backups are retained')
                if ctx['mysql']['enabled']:
                    phase = 'database-first-dump'
                    mysql_dump(ctx, stage / 'mysql.sql')
                phase = 'source-capture'
                before = inventories(ctx)
                for name, source in (('app.tar.gz', ctx['app']), ('runtime-data.tar.gz', ctx['data']), ('service-config.tar.gz', pathlib.Path('/'))):
                    write_archive(stage / name, source, before[name])
                write_private(stage / 'runtime-environment.json', (json.dumps(ctx['environment'], ensure_ascii=True, sort_keys=True) + '\n').encode())
                phase = 'source-stability-check'
                after = inventories(ctx)
                require(before == after, 'Application files changed during backup; stable window required')
                if ctx['mysql']['enabled']:
                    phase = 'database-stability-check'
                    mysql_dump(ctx, stage / 'mysql-after.sql')
                    require(artifact_record(stage / 'mysql.sql', 'file') == artifact_record(stage / 'mysql-after.sql', 'file'),
                            'Database changed during backup; stable window required')
                    (stage / 'mysql-after.sql').unlink()
                phase = 'runtime-health-check'
                require(runtime() == ctx, 'Application runtime settings changed during backup')
                health(ctx)
                phase = 'manifest-verification'
                finished = datetime.datetime.now(ZoneInfo('Asia/Shanghai'))
                name = timestamp_name(finished)
                document = {'schemaVersion': 1, 'type': SCHEMA, 'state': 'complete', 'timestamp': name,
                            'createdAt': finished.isoformat(),
                            'runtime': {'app': str(APP), 'dataPath': str(DATA), 'port': ctx['port'], 'mysql': ctx['mysql']},
                            'consistency': {'method': 'stable-files-bracketed-by-equal-transactional-dumps' if ctx['mysql']['enabled'] else 'stable-files',
                                            'attempt': attempt + 1, 'serviceRestarted': False}, 'artifacts': {}}
                for artifact in sorted(BASE_ARTIFACTS | ({'mysql.sql'} if ctx['mysql']['enabled'] else set())):
                    sync_file(stage / artifact)
                    document['artifacts'][artifact] = artifact_record(stage / artifact, 'tar' if artifact in TAR_ARTIFACTS else 'file', before.get(artifact))
                validate_manifest(document)
                raw = (json.dumps(document, ensure_ascii=True, sort_keys=True, indent=2) + '\n').encode()
                write_private(stage / 'manifest.json', raw)
                write_private(stage / 'COMPLETE', (hashlib.sha256(raw).hexdigest() + '\n').encode())
                verify_backup(stage, require_root=False)
                phase = 'durable-publication'
                sync_directory(stage)
                sync_directory(root)
                destination = root / name
                require(not destination.exists(), 'Backup timestamp collision')
                os.rename(stage, destination)
                renamed = True
                sync_directory(root)
                published = True
                return {'status': 'DAILY_BACKUP_OK', 'backup': str(destination), 'serviceRestarted': False, 'retention': 'keep-all'}
            except (OSError, Refused, ValueError, tarfile.TarError, subprocess.TimeoutExpired) as error:
                if attempt + 1 == attempts:
                    detail = str(error) if isinstance(error, Refused) else type(error).__name__
                    raise Refused('Backup failed at ' + phase + ': ' + detail + '; existing backups retained')
                time.sleep(1)
            finally:
                # stage is a freshly generated direct child, never an old backup.
                # Also clean this private partial result on timeout/interrupt.
                if renamed and not published and destination is not None and destination.parent == root:
                    os.rename(destination, stage)
                if stage.exists() and stage.parent == root and stage.name.startswith('.incomplete-'):
                    shutil.rmtree(stage)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--check', action='store_true', help='Read-only production preflight (default)')
    modes.add_argument('--run', action='store_true', help='Publish one new verified timestamp backup')
    modes.add_argument('--list', action='store_true', help='List completed timestamp backup folders')
    modes.add_argument('--verify', metavar='BACKUP', help='Verify a completed backup without restoring it')
    args = parser.parse_args(argv)
    require(os.name == 'posix' and os.geteuid() == 0, 'Run as root on the existing Linux server')
    os.umask(0o077)
    if args.verify:
        document = verify_backup(pathlib.Path(args.verify))
        print(json.dumps({'status': 'DAILY_BACKUP_VERIFIED', 'backup': str(pathlib.Path(args.verify)), 'createdAt': document['createdAt']}))
    elif args.list:
        checked_path(BACKUPS)
        names = [entry.name for entry in BACKUPS.iterdir() if NAME_PATTERN.fullmatch(entry.name) and (entry / 'COMPLETE').is_file()]
        print(json.dumps({'status': 'DAILY_BACKUP_LIST', 'directory': str(BACKUPS), 'backups': sorted(names)}))
    elif args.run:
        print(json.dumps(run_backup()), flush=True)
    else:
        ctx = runtime()
        inventory = inventories(ctx)
        print(json.dumps({'status': 'DAILY_BACKUP_CHECK', 'ready': True, 'mysqlEnabled': ctx['mysql']['enabled'],
                          'sourceFiles': sum(row['type'] == 'file' for rows in inventory.values() for row in rows),
                          'backupDirectory': str(BACKUPS), 'serviceRestarted': False}), flush=True)


if __name__ == '__main__':
    def interrupted(signum, frame):
        raise KeyboardInterrupt()
    for signame in ('SIGTERM', 'SIGHUP'):
        if hasattr(signal, signame):
            signal.signal(getattr(signal, signame), interrupted)
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        print('Daily backup stopped: ' + (str(error) if isinstance(error, Refused) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
