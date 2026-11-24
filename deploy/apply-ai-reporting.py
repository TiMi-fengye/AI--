#!/usr/bin/env python3
"""Publish reviewed AI queries and reports on an existing relational MySQL service.

This publisher neither migrates SQL nor saves AI settings, keys or business data.
It uses the installed daily backup, briefly gates writes for integrity checks,
and restores only reviewed code on failure. Newer runtime/SQL data is retained.
"""
import argparse
import contextlib
import datetime
import importlib.util
import json
import os
import pathlib
import signal
import stat
import sys
import tempfile
import urllib.parse

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('ai_relational_primitives', pathlib.Path(__file__).with_name('apply-mysql-relational.py'))
rel = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rel)
base, helper = rel.base, rel.helper
require, Refused = rel.require, rel.Refused
canonical_hash, raw_hash = rel.canonical_hash, rel.raw_hash
regular_file, protected_source = rel.regular_file, rel.protected_source
atomic_install, timer_state = rel.atomic_install, rel.timer_state
data_hashes, full_daily_backup = rel.data_hashes, rel.full_daily_backup
APP, SERVICE, OWNER, HTML = rel.APP, rel.SERVICE, rel.OWNER, rel.HTML
AUTH, SERVER = rel.AUTH, rel.SERVER
NEW = ('server/ai-reporting.js', 'server/ai-provider.js', 'server/ai-service.js')
FRONTEND = ('js/ai.js', 'js/auth.js', 'js/app.js', 'js/employee-profile.js')
EXISTING = (AUTH, SERVER, *FRONTEND)
CODE, FILES = (*EXISTING, *NEW), (*EXISTING, *NEW, HTML)
PATCH_FILES = frozenset((SERVER, 'js/auth.js'))
PRESERVE_FILES = frozenset((AUTH,))
TEST_DEPENDENCIES = ('server/approval-workflow.js', 'server/approval-notifications.js')
MANIFEST = 'deploy/ai-reporting-release.json'
RELATIONAL_MANIFEST = 'deploy/mysql-relational-release.json'
RELATIONAL_SHA256 = '83e9e6a03a0599fee90a892bfbabb9b800d529b60d66c8dadfae1013426e6e63'
TESTS = ('tests/ai-reporting.test.js', 'tests/ai-provider.test.js', 'tests/ai-service.test.js')
DOCS = ('README.md', '2026-11-24.md', 'updates/2026-11-24.md', '技术文档/系统开发架构.source.json',
        '技术文档/14-AI查询与周期报表.md', '技术文档/05-阿里云部署手册.md', 'server/config.example.json',
        MANIFEST, RELATIONAL_MANIFEST, 'deploy/apply-ai-reporting.py')
ANONYMOUS_APIS = (('GET', '/api/ai/settings'), ('POST', '/api/ai/settings'),
                  ('POST', '/api/ai/test'), ('POST', '/api/ai/query'),
                  ('POST', '/api/ai/reports'), ('POST', '/api/ai/chat'))


def validate_release(document):
    require(isinstance(document, dict) and set(document) == {'schemaVersion', 'relationalBaselineSha256', 'backupToolSha256', 'files'} and
            type(document['schemaVersion']) is int and document['schemaVersion'] == 1, 'Invalid AI release schema')
    require(document['relationalBaselineSha256'] == RELATIONAL_SHA256, 'AI release requires the fixed reviewed relational baseline')
    require(isinstance(document['backupToolSha256'], str) and rel.SHA.fullmatch(document['backupToolSha256']), 'Invalid managed backup digest')
    rows = document['files']
    require(isinstance(rows, dict) and set(rows) == set(CODE), 'AI manifest must contain exactly the reviewed public source paths')
    for name, row in rows.items():
        require(isinstance(row, dict) and set(row) == ({'beforeSha256', 'afterSha256', 'patches'} if name in PATCH_FILES else {'beforeSha256', 'afterSha256'}), 'Unexpected AI manifest entry fields')
        require(isinstance(row['afterSha256'], str) and rel.SHA.fullmatch(row['afterSha256']), 'Invalid AI candidate digest')
        require(row['beforeSha256'] is None if name in NEW else isinstance(row['beforeSha256'], str) and rel.SHA.fullmatch(row['beforeSha256']), 'Invalid AI source baseline or new-file declaration')
        if name in PRESERVE_FILES:
            require(row['beforeSha256'] == row['afterSha256'], 'AI release may not replace authentication source')
        if name in PATCH_FILES:
            patches = row['patches']
            require(isinstance(patches, list) and len(patches) <= 100 and (patches or row['beforeSha256'] == row['afterSha256']), 'Missing reviewed AI production patches')
            seen = set()
            for patch in patches:
                require(isinstance(patch, dict) and set(patch) == {'old', 'new'}, 'Invalid AI patch')
                old, new = patch['old'], patch['new']
                require(isinstance(old, str) and isinstance(new, str) and old and new and old != new and
                        max(len(old), len(new)) <= 1024 * 1024 and '\0' not in old + new and '\r' not in old + new and old not in seen,
                        'Unsafe or duplicate AI patch')
                seen.add(old)
    return document


def load_release(source, expected):
    path = regular_file(source / MANIFEST)
    require(path.stat().st_size <= 8 * 1024 * 1024, 'AI manifest is too large')
    raw = path.read_bytes()
    require(raw_hash(raw) == expected, 'AI manifest differs from the fixed reviewed release')
    try:
        return validate_release(json.loads(raw.decode('utf-8'), object_pairs_hook=base.unique_object))
    except (UnicodeError, ValueError):
        raise Refused('AI release manifest is not valid UTF-8 JSON')


def baseline_sources(source, document):
    baseline = rel.load_manifest(source, RELATIONAL_SHA256)
    models = list(baseline['variants'].values())
    hashes = {name: row['afterSha256'] for name, row in models[0]['files'].items()}
    require(all({name: row['afterSha256'] for name, row in model['files'].items()} == hashes for model in models), 'Relational variants disagree about the reviewed target')
    require(document['backupToolSha256'] == baseline['backupTool']['afterSha256'], 'AI release may not upgrade or downgrade the backup installation')
    require(all(document['files'][name]['beforeSha256'] == digest for name, digest in hashes.items() if name in document['files']), 'AI baseline differs from the reviewed relational target')
    return hashes


def capture_current(gid, baseline):
    for directory in (APP, APP / 'server', APP / 'js'):
        protected_source(directory, gid, directory=True)
    for name, digest in baseline.items():
        target = APP / name
        protected_source(target, gid)
        require(canonical_hash(regular_file(target).read_bytes()) == digest, 'Relational source prerequisite is incomplete; finish the reviewed MySQL migration first: ' + name)
    current = {}
    for name in (*EXISTING, HTML):
        protected_source(APP / name, gid)
        current[name] = regular_file(APP / name).read_bytes()
    for name in NEW:
        base.require_absent(APP / name)
        current[name] = None
    return current


def relational_prerequisite(port, data, environment):
    try:
        rel.status(port, False)
        return rel.relation_proof(rel.migration_command(APP / 'server/migrate-mysql.js', data, environment, '--verify'))
    except (Refused, ValueError, OSError):
        raise Refused('AI deployment requires initialized MySQL relational storage with readOnly=false. Complete the reviewed, backed-up MySQL migration first; this publisher does not migrate data')


def freeze_release(source, stage, current, document, support):
    validate_release(document)
    require(isinstance(support, dict) and set(support) == set(TEST_DEPENDENCIES), 'Missing isolated production authentication dependencies')
    candidates = {}
    for name, row in document['files'].items():
        require(current[name] is None if name in NEW else current[name] is not None and canonical_hash(current[name]) == row['beforeSha256'], 'AI production source differs from the reviewed baseline: ' + name)
        if name in PRESERVE_FILES:
            candidates[name] = current[name]
        elif name in PATCH_FILES:
            candidates[name] = base.patch_source(current[name], row)
        else:
            candidates[name] = regular_file(source / name).read_bytes()
            require(canonical_hash(candidates[name]) == row['afterSha256'], 'AI source candidate differs: ' + name)
    candidates[HTML] = regular_file(source / HTML).read_bytes()
    for name in DOCS:
        regular_file(source / name)
    for name, content in {**candidates, **support}.items():
        target = stage / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        target.write_bytes(content)
        os.chmod(target, 0o600)
        if name.endswith('.js'):
            helper.run(['node', '--check', target])
    environment = {key: value for key, value in os.environ.items() if not key.startswith('HR_')}
    environment.update(HR_AI_REPORTING_MODULE=str(stage / NEW[0]), HR_AI_PROVIDER_MODULE=str(stage / NEW[1]), HR_AI_SERVICE_MODULE=str(stage / NEW[2]))
    for name in TESTS:
        helper.run(['node', '--test', regular_file(source / name)], cwd=source, env=environment)
    helper.run(['node', regular_file(source / 'scripts/generate-architecture.cjs'), '--check'], cwd=source, env=environment)
    return candidates


def public_check(port, candidates, readonly):
    rel.status(port, readonly)
    for name in FRONTEND:
        code, body = helper.get('http://127.0.0.1:' + str(port), '/' + name)
        require(code == 200 and body == candidates[name], 'Reviewed AI frontend is not served: ' + name)
    require(helper.get('http://127.0.0.1:' + str(port), '/' + urllib.parse.quote(HTML))[0] == 404,
            'Architecture document static whitelist changed')
    for method, route in ANONYMOUS_APIS:
        expected = 503 if readonly and method == 'POST' else 401
        require(base.api_status(port, method, route) == expected, 'Anonymous AI API boundary changed')
    require(base.api_status(port, 'GET', '/api/data/snapshot.json') == 401, 'Anonymous personnel data boundary changed')
    for name in (*NEW, AUTH, SERVER, 'server/config.json', 'server/data/ai-settings.json'):
        require(helper.get('http://127.0.0.1:' + str(port), '/' + name)[0] == 404, 'Private AI configuration or server module is publicly served')


def verify_unchanged(data, database, environment, frozen, backup, timer, tools, backup_digest):
    require(data_hashes(data) == frozen['files'], 'Runtime data or private configuration changed during AI deployment')
    observed = rel.migration_command(APP / 'server/migrate-mysql.js', data, environment, '--verify')
    require(rel.relation_proof(observed) == frozen['relation'], 'Relational business data changed during AI deployment')
    require(rel.stable_sql_digest(database, backup) == frozen['sql'], 'Whole MySQL database changed during AI deployment')
    require(timer_state() == timer and rel.backup_state(backup_digest) == tools, 'Existing daily backup installation or schedule changed')


def restore_code(current, candidates, changed, created, gid):
    """Restore only our installed bytes; never write configuration or SQL."""
    for name in reversed(changed):
        target = APP / name
        if current[name] is None:
            if name in created:
                base.remove_new(target, candidates[name], gid, created[name])
        else:
            protected_source(target, gid)
            observed = regular_file(target).read_bytes()
            require(observed in (current[name], candidates[name]), 'Foreign source change retained for administrator review')
            if observed != current[name]:
                atomic_install(target, current[name], gid)
            protected_source(target, gid)


def publish(current, candidates, data, port, database, gid, environment, timer, tools, backup_digest, backup, full_backup):
    changed, created, hold, stopped = [], {}, None, False
    try:
        require(timer_state() == timer and rel.backup_state(backup_digest) == tools, 'Backup installation changed before AI publication')
        for name, original in current.items():
            if original is None:
                base.require_absent(APP / name)
            else:
                protected_source(APP / name, gid)
                require((APP / name).read_bytes() == original, 'AI source changed during preflight')
        hold = rel.create_hold(gid)
        stopped = True
        helper.run(['systemctl', 'stop', SERVICE])
        require(helper.system_value('ActiveState') == 'inactive', 'Application did not stop for AI publication')
        frozen = {'files': data_hashes(data), 'relation': rel.relation_proof(rel.migration_command(APP / 'server/migrate-mysql.js', data, environment, '--verify')),
                  'sql': rel.stable_sql_digest(database, backup)}
        for name in (*NEW, *EXISTING, HTML):
            if current[name] == candidates[name]:
                continue
            changed.append(name)
            if current[name] is None:
                base.install_new(APP / name, candidates[name], gid, on_created=lambda identity, name=name: created.__setitem__(name, identity))
            else:
                atomic_install(APP / name, candidates[name], gid)
            protected_source(APP / name, gid)
            helper.run(['runuser', '-u', OWNER, '--', 'test', '-r', APP / name])
        verify_unchanged(data, database, environment, frozen, backup, timer, tools, backup_digest)
        helper.run(['systemctl', 'start', SERVICE])
        public_check(port, candidates, True)
        require(helper.system_value('User') == OWNER, 'Application service identity changed')
        verify_unchanged(data, database, environment, frozen, backup, timer, tools, backup_digest)
        for name in FILES:
            protected_source(APP / name, gid)
            require((APP / name).read_bytes() == candidates[name], 'Installed AI source changed during verification')
        (backup / 'integrity-proof.json').write_text(json.dumps(frozen) + '\n', encoding='utf-8')
        rel.clear_hold(hold)
        hold = None
        public_check(port, candidates, False)
        result = {'status': 'AI_REPORTING_OK', 'backup': str(backup), 'dataBackup': full_backup,
                  'installedFiles': list(FILES), 'newFiles': list(NEW), 'storageModel': 'relational',
                  'sourceProtected': True, 'dailyBackupTimerPreserved': True, 'automaticBackupEnabled': True,
                  'dailyTime': '02:00', 'timezone': 'Asia/Shanghai', 'serviceRestarted': True,
                  'businessDataWritten': False, 'privateConfigurationWritten': False, 'modelConnectionTested': False,
                  'sourceSha256': {name: canonical_hash(candidates[name]) for name in CODE}}
        (backup / 'AI_REPORTING_OK').write_text(json.dumps(result) + '\n', encoding='utf-8')
        return result
    except BaseException:
        try:
            if stopped:
                helper.run(['systemctl', 'stop', SERVICE])
            if changed:
                restore_code(current, candidates, changed, created, gid)
            if hold is not None:
                rel.clear_hold(hold)
            if stopped:
                helper.run(['systemctl', 'start', SERVICE])
                rel.status(port, False)
        except BaseException:
            (backup / 'ROLLBACK_NEEDS_ATTENTION').write_text('Code rollback needs administrator review. All database/runtime data and backup material were retained.\n', encoding='utf-8')
            raise Refused('AI code rollback needs administrator review; private configuration and newer SQL data were not restored or overwritten')
        raise


def save_release(backup, current, candidates, source):
    for prefix, values in (('previous-code', current), ('reviewed-release', candidates)):
        for name, content in values.items():
            if content is not None:
                target = backup / prefix / name
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                target.write_bytes(content)
    (backup / 'new-files.json').write_text(json.dumps(list(NEW)) + '\n', encoding='utf-8')
    for name in DOCS:
        target = backup / 'reviewed-release' / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        target.write_bytes(regular_file(source / name).read_bytes())


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--expected-release-sha256', required=True, type=base.reviewed_hash)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--check', action='store_true')
    modes.add_argument('--apply', action='store_true')
    args = parser.parse_args(argv)
    source = helper.checked_path(args.source, 'dir')
    document = load_release(source, args.expected_release_sha256)
    baseline = baseline_sources(source, document)
    require(os.name == 'posix' and os.geteuid() == 0, 'Run as root on the existing Linux server')
    require(source != APP and APP not in source.parents and source not in APP.parents, 'AI release must be separate from the production application')
    import grp
    gid = grp.getgrnam(OWNER).gr_gid
    with base.publication_lock() if args.apply else contextlib.nullcontext():
        with rel.MaintenanceLock(pathlib.Path('/run/hr-system-backup-install.lock')) if args.apply else contextlib.nullcontext():
            base.require_absent(rel.HOLD)
            data, port, database = helper.runtime()
            environment = rel.service_environment()
            timer, current = timer_state(), capture_current(gid, baseline)
            support = {name: regular_file(APP / name).read_bytes() for name in TEST_DEPENDENCIES}
            relational_prerequisite(port, data, environment)
            tools = rel.backup_state(document['backupToolSha256'])
            with tempfile.TemporaryDirectory(prefix='hr-ai-reporting-preflight-') as temporary:
                candidates = freeze_release(source, pathlib.Path(temporary), current, document, support)
                if not args.apply:
                    result = {'status': 'AI_REPORTING_CHECK', 'readyToApply': True, 'storageModel': 'relational',
                              'serviceRestarted': False, 'privateConfigurationWritten': False, 'modelConnectionTested': False}
                else:
                    full_backup = full_daily_backup()
                    helper.checked_path(helper.BACKUPS)
                    helper.BACKUPS.mkdir(mode=0o700, exist_ok=True)
                    require(helper.BACKUPS.stat().st_uid == 0 and stat.S_IMODE(helper.BACKUPS.stat().st_mode) == 0o700, 'AI publication backups must be root-private')
                    backup = pathlib.Path(tempfile.mkdtemp(prefix=datetime.datetime.now().strftime('%Y-%m-%d-ai-reporting-%H%M%S-'), dir=helper.BACKUPS))
                    save_release(backup, current, candidates, source)
                    with rel.MaintenanceLock(pathlib.Path('/var/backups/hr-system/.daily-backup.lock')):
                        require(capture_current(gid, baseline) == current, 'Relational source changed while the full backup was being verified')
                        result = publish(current, candidates, data, port, database, gid, environment, timer, tools, document['backupToolSha256'], backup, full_backup)
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
        print('AI publication stopped: ' + (str(error) if isinstance(error, Refused) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
