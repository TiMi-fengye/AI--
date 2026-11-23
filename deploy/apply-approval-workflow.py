#!/usr/bin/env python3
"""Publish a fixed, reviewed approval workflow while retaining private data.

Default is preflight; --apply verifies a full backup before stopping the existing
application. The release manifest names only reviewed public code. It never
authorizes configuration, runtime data or arbitrary filesystem destinations.
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
import urllib.error
import urllib.request


sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('workflow_release_primitives', pathlib.Path(__file__).with_name('apply-leave-types-time.py'))
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
SERVER = 'server/server.js'
FRONTEND = ('js/auth.js', 'js/permission.js', 'js/store.js', 'js/app.js', 'js/attendance.js', 'js/overtime.js', 'js/leave.js')
EXISTING = (AUTH, SERVER, *FRONTEND)
NEW = ('server/approval-workflow.js', 'server/approval-notifications.js')
PATCH_FILES = frozenset((AUTH, SERVER, 'js/auth.js'))
HTML = '人力资源管理系统开发架构.html'
CODE = (*EXISTING, *NEW)
FILES = (*CODE, HTML)
MANIFEST = 'deploy/approval-workflow-release.json'
TEST = 'tests/approval-workflow.test.js'
DOCS = ('README.md', '2026-11-23.md', 'updates/2026-11-23.md', '技术文档/系统开发架构.source.json',
        '技术文档/12-流程审批与短信通知.md', '技术文档/07-手机号账号与数据权限.md', '技术文档/05-阿里云部署手册.md',
        'deploy/approval-sms.env.example', 'server/config.example.json', MANIFEST, 'deploy/apply-approval-workflow.py')
ANONYMOUS_APIS = (('POST', '/api/approvals/overtime/fake'),
                  ('GET', '/api/approvals/notifications?kind=leaveRequests&id=0'),
                  ('POST', '/api/approvals/notifications/fake/retry'))
SHA256 = re.compile(r'[0-9a-f]{64}')


def raw_hash(raw):
    return hashlib.sha256(raw).hexdigest()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate release manifest property')
        result[key] = value
    return result


def validate_release(document):
    require(isinstance(document, dict) and set(document) == {'schemaVersion', 'files'} and
            type(document['schemaVersion']) is int and document['schemaVersion'] == 1,
            'Unsupported release manifest schema')
    entries = document['files']
    require(isinstance(entries, dict) and set(entries) == set(CODE),
            'Release manifest must contain exactly the reviewed public code paths')
    for name, item in entries.items():
        require(isinstance(item, dict), 'Invalid release manifest entry')
        expected_fields = {'beforeSha256', 'afterSha256'} | ({'patches'} if name in PATCH_FILES else set())
        require(set(item) == expected_fields, 'Unexpected release manifest entry fields')
        require(isinstance(item['afterSha256'], str) and SHA256.fullmatch(item['afterSha256']), 'Invalid candidate source digest')
        if name in NEW:
            require(item['beforeSha256'] is None, 'New modules cannot replace existing files')
        else:
            require(isinstance(item['beforeSha256'], str) and SHA256.fullmatch(item['beforeSha256']), 'Invalid existing source digest')
        if name in PATCH_FILES:
            patches = item['patches']
            require(isinstance(patches, list) and 0 < len(patches) <= 100, 'Reviewed production patches are required')
            old_values = set()
            for patch in patches:
                require(isinstance(patch, dict) and set(patch) == {'old', 'new'}, 'Invalid reviewed patch format')
                old, new = patch['old'], patch['new']
                require(isinstance(old, str) and isinstance(new, str) and old and new and old != new and
                        max(len(old), len(new)) <= 1024 * 1024 and
                        '\0' not in old + new and '\r' not in old + new and old not in old_values,
                        'Unsafe or duplicate reviewed patch')
                old_values.add(old)
    return document


def load_release(source, expected):
    path = regular_file(source / MANIFEST)
    require(path.stat().st_size <= 4 * 1024 * 1024, 'Release manifest exceeds its size limit')
    raw = path.read_bytes()
    require(raw_hash(raw) == expected, 'Release manifest differs from the fixed reviewed version')
    try:
        document = json.loads(raw.decode('utf-8'), object_pairs_hook=unique_object)
    except (UnicodeError, ValueError):
        raise Refused('Release manifest is not valid UTF-8 JSON')
    return validate_release(document)


def patch_source(raw, entry):
    text = canonical(raw)
    require(raw_hash(text.encode()) == entry['beforeSha256'], 'Production source differs from the reviewed baseline')
    for patch in entry['patches']:
        old, new = patch['old'], patch['new']
        require(text.count(old) == 1 and new not in text, 'Production patch anchor is missing, duplicated or already applied')
        text = text.replace(old, new, 1)
    require(raw_hash(text.encode()) == entry['afterSha256'], 'Patched production candidate differs from the reviewed result')
    return text.encode()


def require_absent(path):
    helper.checked_path(path.parent, 'dir')
    helper.checked_path(path)
    require(not path.exists() and not path.is_symlink(), 'A new approval module already exists; preserve it for review')


def capture_current(gid):
    for directory in (APP, APP / 'server', APP / 'js'):
        protected_source(directory, gid, directory=True)
    current = {}
    for name in (*EXISTING, HTML):
        protected_source(APP / name, gid)
        current[name] = regular_file(APP / name).read_bytes()
    for name in NEW:
        require_absent(APP / name)
        current[name] = None
    return current


def freeze_release(source, stage, current, document):
    validate_release(document)
    entries, candidates = document['files'], {}
    for name in CODE:
        item = entries[name]
        if name in NEW:
            require(current[name] is None, 'A new approval module has an existing source')
        else:
            require(current[name] is not None and canonical_hash(current[name]) == item['beforeSha256'],
                    'Production source differs from the reviewed baseline: ' + name)
        if name in PATCH_FILES:
            candidates[name] = patch_source(current[name], item)
        else:
            candidates[name] = regular_file(source / name).read_bytes()
            require(canonical_hash(candidates[name]) == item['afterSha256'], 'Candidate source digest differs: ' + name)
    candidates[HTML] = regular_file(source / HTML).read_bytes()
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
    environment['HR_APPROVAL_AUTH_TEST_MODULE'] = str(stage / AUTH)
    environment['HR_APPROVAL_WORKFLOW_MODULE'] = str(stage / NEW[0])
    environment['HR_APPROVAL_NOTIFICATIONS_MODULE'] = str(stage / NEW[1])
    helper.run(['node', '--test', regular_file(source / TEST)], cwd=source, env=environment)
    helper.run(['node', regular_file(source / 'scripts/generate-architecture.cjs'), '--check'], cwd=source, env=environment)
    return candidates


def sync_parent(path):
    descriptor = os.open(path.parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def install_new(target, content, gid, on_created=None):
    """Publish a new module atomically, refusing to overwrite a raced-in file."""
    require_absent(target)
    descriptor, name = tempfile.mkstemp(prefix='.approval-release-', dir=target.parent)
    pending = pathlib.Path(name)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchown(stream.fileno(), 0, gid)
            os.fchmod(stream.fileno(), 0o640)
        os.link(pending, target)
        if on_created is not None:
            info = pending.stat()
            on_created((info.st_dev, info.st_ino))
        pending.unlink()
        sync_parent(target)
    finally:
        if pending.exists():
            pending.unlink()


def remove_new(target, content, gid, identity):
    protected_source(target, gid)
    info = regular_file(target).stat()
    require((info.st_dev, info.st_ino) == identity, 'New module identity changed; preserve it for administrator review')
    require(regular_file(target).read_bytes() == content, 'New module changed; preserve it for administrator review')
    target.unlink()
    sync_parent(target)


def api_status(port, method, route):
    request = urllib.request.Request('http://127.0.0.1:' + str(port) + route,
                                     data=b'{}' if method == 'POST' else None, method=method,
                                     headers={'Content-Type': 'application/json'})
    try:
        with helper.CLIENT.open(request, timeout=5) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def verify_public(port, candidates):
    for name in FRONTEND:
        code, body = helper.get('http://127.0.0.1:' + str(port), '/' + name)
        require(code == 200 and body == candidates[name], 'Updated approval frontend is not served: ' + name)
    for method, route in ANONYMOUS_APIS:
        require(api_status(port, method, route) == 401, 'Anonymous approval API boundary changed')
    for route in ('/server/approval-workflow.js', '/server/approval-notifications.js', '/server/config.json'):
        require(helper.get('http://127.0.0.1:' + str(port), route)[0] == 404, 'Private application source is publicly accessible')


def publish(current, candidates, data, port, database, gid, timer, backup, full_backup):
    changed, created, stopped = [], {}, False
    try:
        require(timer_state() == timer, 'Daily backup timer changed before publication')
        for name in FILES:
            target = APP / name
            if name in NEW:
                require_absent(target)
            else:
                protected_source(target, gid)
                require(target.read_bytes() == current[name], 'Production source changed during preflight')
        stopped = True
        helper.run(['systemctl', 'stop', SERVICE])
        require(helper.system_value('ActiveState') == 'inactive', 'Application did not stop for publication')
        hashes, before = data_hashes(data), helper.mysql_snapshot(database)
        # New modules precede importing modules; the service remains stopped.
        for name in (*NEW, *EXISTING, HTML):
            changed.append(name)
            target = APP / name
            if name in NEW:
                install_new(target, candidates[name], gid, on_created=lambda identity, name=name: created.__setitem__(name, identity))
            else:
                atomic_install(target, candidates[name], gid)
            helper.run(['runuser', '-u', OWNER, '--', 'test', '-r', target])
            protected_source(target, gid)
        require(data_hashes(data) == hashes and helper.mysql_snapshot(database) == before,
                'Existing data changed while the application was stopped')
        helper.run(['systemctl', 'start', SERVICE])
        helper.verify(port, data / 'organization-settings.json', hashes, database, before)
        require(data_hashes(data) == hashes, 'Runtime files changed during publication verification')
        verify_public(port, candidates)
        require(timer_state() == timer, 'Daily backup timer changed during publication')
        for name in FILES:
            protected_source(APP / name, gid)
            require((APP / name).read_bytes() == candidates[name], 'Installed source changed during verification')
        (backup / 'APPROVAL_WORKFLOW_OK').write_text('Reviewed approval workflow; private data and protections retained.\n', encoding='utf-8')
        return {'status': 'APPROVAL_WORKFLOW_OK', 'backup': str(backup), 'dataBackup': full_backup,
                'installedFiles': list(FILES), 'newFiles': list(NEW), 'serviceRestarted': True,
                'sourceProtected': True, 'dailyBackupTimerPreserved': True, 'businessDataWritten': False,
                'sourceSha256': {name: canonical_hash(candidates[name]) for name in CODE},
                'frontendSha256': {name: raw_hash(candidates[name]) for name in FRONTEND}}
    except BaseException:
        errors = []
        if changed:
            try:
                helper.run(['systemctl', 'stop', SERVICE])
                for name in reversed(changed):
                    target = APP / name
                    if name in NEW:
                        if name in created:
                            remove_new(target, candidates[name], gid, created[name])
                    else:
                        observed = regular_file(target).read_bytes()
                        require(observed in (current[name], candidates[name]), 'Changed source preserved for administrator review')
                        if observed != current[name]:
                            atomic_install(target, current[name], gid)
                        protected_source(target, gid)
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


def save_release(backup, current, candidates, source):
    for prefix, values in (('previous-code', current), ('reviewed-release', candidates)):
        for name, content in values.items():
            if content is None:
                continue
            target = backup / prefix / name
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            target.write_bytes(content)
    (backup / 'new-files.json').write_text(json.dumps(list(NEW)) + '\n', encoding='utf-8')
    for name in DOCS:
        target = backup / 'reviewed-release' / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        target.write_bytes((source / name).read_bytes())


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--expected-release-sha256', required=True, type=reviewed_hash)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--check', action='store_true', help='Check only; default')
    modes.add_argument('--apply', action='store_true', help='Back up, publish and restart the HR service')
    args = parser.parse_args(argv)
    source = helper.checked_path(args.source, 'dir')
    document = load_release(source, args.expected_release_sha256)
    require(os.name == 'posix' and os.geteuid() == 0, 'Run as root on the existing Linux server')
    require(source != APP and APP not in source.parents and source not in APP.parents, 'Reviewed release must be separate from production')
    import grp
    gid = grp.getgrnam(OWNER).gr_gid
    with publication_lock() if args.apply else contextlib.nullcontext():
        data, port, database = helper.runtime()
        timer, current = timer_state(), capture_current(gid)
        for name in FRONTEND:
            code, body = helper.get('http://127.0.0.1:' + str(port), '/' + name)
            require(code == 200 and body == current[name], 'Service does not serve the reviewed production directory')
        with tempfile.TemporaryDirectory(prefix='hr-approval-workflow-preflight-') as temporary:
            candidates = freeze_release(source, pathlib.Path(temporary), current, document)
            if not args.apply:
                result = {'status': 'APPROVAL_WORKFLOW_CHECK', 'readyToApply': True,
                          'serviceRestarted': False, 'sourcePermissionsChanged': False}
            else:
                full_backup = full_daily_backup()
                helper.checked_path(helper.BACKUPS)
                helper.BACKUPS.mkdir(mode=0o700, exist_ok=True)
                info = helper.BACKUPS.stat()
                require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700, 'Publication backups must be root-owned 0700')
                backup = pathlib.Path(tempfile.mkdtemp(prefix=datetime.datetime.now().strftime('%Y-%m-%d-approval-workflow-%H%M%S-'), dir=helper.BACKUPS))
                save_release(backup, current, candidates, source)
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
        print('Approval workflow publication stopped: ' + (str(error) if isinstance(error, Refused) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
