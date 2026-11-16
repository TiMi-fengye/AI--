#!/usr/bin/env python3
"""Atomically publish leave reminders without restarting the existing HR service.

Only public leave.js and the offline architecture HTML are replaced. No account,
personnel, database, configuration, environment or session files are read/written.
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import stat
import sys
import tempfile
import urllib.request

spec = importlib.util.spec_from_file_location('static_release_helpers', pathlib.Path(__file__).with_name('apply-organization-fix.py'))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
require = helper.require
FILES = ('js/leave.js', '人力资源管理系统开发架构.html')
DOCS = ('README.md', '2026-11-16.md', 'updates/2026-11-16.md', '技术文档/系统开发架构.source.json', '技术文档/07-手机号账号与数据权限.md', '技术文档/05-阿里云部署手册.md')
BASE = 'http://127.0.0.1:8080'


def reviewed_hash(value):
    if not re.fullmatch(r'[a-fA-F0-9]{64}', value):
        raise argparse.ArgumentTypeError('Expected a reviewed 64-hex SHA256')
    return value.lower()


def canonical_hash(raw):
    text = raw.decode('utf-8').replace('\r\n', '\n').rstrip() + '\n'
    require('\0' not in text and '\r' not in text, 'Unexpected source encoding')
    return hashlib.sha256(text.encode()).hexdigest()


def atomic_install(target, content, uid, gid):
    helper.checked_path(target.parent, 'dir')
    descriptor, name = tempfile.mkstemp(prefix='.leave-release-', dir=target.parent)
    pending = pathlib.Path(name)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chown(pending, uid, gid)
        os.chmod(pending, 0o644)
        os.replace(pending, helper.checked_path(target))
    finally:
        if pending.exists():
            pending.unlink()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--expected-leave-sha256', required=True, type=reviewed_hash)
    args = parser.parse_args(argv)
    require(os.name == 'posix' and os.geteuid() == 0, 'Run on the existing Linux host as root')
    app = helper.checked_path(helper.APP, 'dir')
    source = helper.checked_path(args.source, 'dir')
    require(source != app and app not in source.parents and source not in app.parents, 'Reviewed source must be separate from production')
    require(helper.system_value('User') == helper.OWNER and helper.system_value('WorkingDirectory') == str(app), 'Unexpected HR service')
    helper.run(['systemctl', 'is-active', '--quiet', helper.SERVICE])
    pid = helper.system_value('MainPID')
    require(re.fullmatch(r'[1-9][0-9]*', pid), 'Service is not running')
    current = {name:helper.checked_path(app / name, 'file').read_bytes() for name in FILES}
    require(canonical_hash(current['js/leave.js']) == args.expected_leave_sha256, 'Current leave.js differs from the reviewed baseline; nothing changed')
    code, body = helper.get(BASE, '/js/leave.js')
    require(code == 200 and body == current['js/leave.js'], 'Running service does not serve the reviewed application')
    helper.run(['node', '--check', helper.checked_path(source / 'js/leave.js', 'file')])
    candidates = {name:helper.checked_path(source / name, 'file').read_bytes() for name in FILES}
    for name in DOCS:
        helper.checked_path(source / name, 'file')
    helper.checked_path(helper.BACKUPS)
    helper.BACKUPS.mkdir(mode=0o700, exist_ok=True)
    info = helper.BACKUPS.stat()
    require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700, 'Backup directory must be root-owned 0700')
    backup = pathlib.Path(tempfile.mkdtemp(prefix=datetime.datetime.now().strftime('%Y-%m-%d-leave-guidance-%H%M%S-'), dir=helper.BACKUPS))
    helper.tar_backup(backup / 'previous-public-code.tar.gz', app, FILES)
    stage = backup / 'reviewed-release'
    stage.mkdir(mode=0o700)
    for name in (*FILES, *DOCS):
        target = stage / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        target.write_bytes(candidates[name] if name in candidates else (source / name).read_bytes())
    import pwd
    owner = pwd.getpwnam(helper.OWNER)
    changed = []
    try:
        for name in FILES:
            require((app / name).read_bytes() == current[name], 'Public code changed during preflight')
            atomic_install(app / name, candidates[name], owner.pw_uid, owner.pw_gid)
            changed.append(name)
        code, body = helper.get(BASE, '/js/leave.js')
        require(code == 200 and body == candidates['js/leave.js'], 'Updated leave.js is not served')
        code, body = helper.get(BASE, '/api/auth/status')
        require(code == 200 and json.loads(body).get('setupRequired') is False, 'Authentication health check failed')
        for route in ('/api/data/snapshot.json', '/api/employees/export', '/api/organization/settings'):
            require(helper.get(BASE, route)[0] == 401, 'Anonymous access boundary changed')
        require(helper.system_value('MainPID') == pid, 'HR service restarted during static publication')
        (backup / 'LEAVE_GUIDANCE_OK').write_text('Static leave reminder update; service and sessions preserved.\n', encoding='utf-8')
        print(json.dumps({'status':'LEAVE_GUIDANCE_OK','backup':str(backup),'installedFiles':list(FILES),'serviceRestarted':False,'businessDataTouched':False,'leaveSha256':hashlib.sha256(candidates['js/leave.js']).hexdigest()}), flush=True)
    except BaseException:
        for name in reversed(changed):
            require((app / name).read_bytes() == candidates[name], 'Installed public file changed; preserve it for review')
            atomic_install(app / name, current[name], owner.pw_uid, owner.pw_gid)
        raise


if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except Exception as error:
        print('Leave reminder publication stopped: ' + (str(error) if isinstance(error, helper.Refused) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
