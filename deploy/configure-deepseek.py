#!/usr/bin/env python3
"""Configure the reviewed live AI provider through a private interactive terminal."""
import argparse
import contextlib
import getpass
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
import time
import types
import warnings

if os.name == 'posix':
    import pwd
else:
    pwd = None

sys.dont_write_bytecode = True
APP = pathlib.Path('/opt/hr-system')
BACKUPS = pathlib.Path('/root/hr-system-backups')
DAILY = pathlib.Path('/var/backups/hr-system/daily')
COMMAND = pathlib.Path('/usr/local/sbin/hr-system-backup')
SERVICE, OWNER = 'hr-system.service', 'hrsystem'
ENDPOINT, MODEL = 'https://api.deepseek.com/chat/completions', 'deepseek-flash'
HELPER_SHA = 'c69e757105b89d0ec7ffa54a430c8144832e08cacde9ff35785057224d1d0795'
PROVIDER_SHA = 'df65457ee3a0f6dbbdd3536cef42e5f7fb396ea53f2bbd8fee4228022aaab1bf'
SERVER_SHA = 'dbf413f1c31a376eafebbb62d06ab260f6e4be4069924aba162d5a4de3888c2f'
PUBLIC_CODE = ('server/ai-provider.js', 'server/ai-service.js', 'server/ai-reporting.js', 'server/server.js',
               'server/auth-service.js', 'server/mysql-store.js', 'server/mysql-auth-store.js', 'server/migrate-mysql.js')
NODE = r'''"use strict";
const fs=require("node:fs"),crypto=require("node:crypto");
const endpoint="https://api.deepseek.com/chat/completions";
async function run(input, api) {
  if(input.mode==="test") {
    const provider=api.createAIProvider({getSettings:()=>({enabled:true,endpoint,model:input.model,apiKey:input.key}),saveSettings:()=>{throw new Error();},env:{}});
    await provider.chat([{role:"user",content:"这是不含业务数据的连接测试，请只回复OK。"}],{maxTokens:32});
    return {connected:true};
  }
  if(input.mode!=="status")throw new Error();
  const store=api.createPrivateSettingsStore({file:input.file,base:{}});
  const status=api.createAIProvider({getSettings:store.get,saveSettings:()=>{throw new Error();},env:{}}).status();
  return {enabled:status.enabled===true,configured:status.configured===true,apiKeyConfigured:status.apiKeyConfigured===true,
    endpointMatches:status.endpoint===endpoint,modelMatches:status.model===input.model};
}
module.exports={run};
if(process.argv[1]==="hr-private-ai-configuration") {
  const filename=process.argv[2];let messages=new Set(["HIDDEN"]);
  Promise.resolve().then(async()=>{
    const source=fs.readFileSync(filename,"utf8");
    if(crypto.createHash("sha256").update(source.replace(/\r\n/g,"\n").trimEnd()+"\n").digest("hex")!=="df65457ee3a0f6dbbdd3536cef42e5f7fb396ea53f2bbd8fee4228022aaab1bf")throw new Error();
    for(const token of source.match(/"(?:[^"\\]|\\.)*"/g)||[])try{const text=JSON.parse(token);if(typeof text==="string"&&text.length<=300&&!/[\r\n\0]/.test(text))messages.add(text);}catch(_){}
    return run(JSON.parse(fs.readFileSync(0,"utf8")),require(filename));
  }).then(value=>process.stdout.write(JSON.stringify(value)+"\n"),error=>{
    const name=error&&error.constructor&&error.constructor.name;
    process.stdout.write(JSON.stringify({errorClass:["AIError","Error","TypeError","SyntaxError"].includes(name)?name:"Error",message:messages.has(error&&error.message)?error.message:"HIDDEN"})+"\n");process.exitCode=1;
  });
}
'''


class Refused(Exception):
    pass


class NodeFailure(Exception):
    def __init__(self, kind='Error', message='HIDDEN'):
        self.kind, self.public_message = kind, message


def require(value):
    if not value:
        raise Refused()


def checked(path, directory=False):
    path = pathlib.Path(os.path.abspath(path))
    for item in (*reversed(path.parents), path):
        try:
            info = item.lstat()
        except FileNotFoundError:
            require(item == path and not directory)
            return path
        require(not stat.S_ISLNK(info.st_mode))
        if item != path or directory:
            require(stat.S_ISDIR(info.st_mode))
    return path


def regular(path, uid=None, gid=None, mode=None):
    path = checked(path)
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 8 * 1024 * 1024)
    require(uid is None or info.st_uid == uid)
    require(gid is None or info.st_gid == gid)
    require(mode is None or stat.S_IMODE(info.st_mode) == mode)
    return info


def canonical(raw):
    return raw.decode('utf-8-sig').replace('\r\n', '\n').rstrip() + '\n'


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def load_helper(publication):
    publication = checked(publication, directory=True)
    require(publication.parent == BACKUPS and re.fullmatch(r'\d{4}-\d{2}-\d{2}-mysql-relational-\d{6}-[a-z0-9_]+', publication.name))
    path = publication / 'publication-tool/apply-organization-fix.py'
    for directory in (BACKUPS, publication, path.parent):
        info = checked(directory, directory=True).stat()
        require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700)
    regular(path, uid=0, mode=0o600)
    raw = path.read_bytes()
    require(digest(raw) == HELPER_SHA)
    helper = types.ModuleType('private_ai_configuration_runtime')
    helper.__file__ = str(path)
    exec(compile(raw, str(path), 'exec'), helper.__dict__)
    return helper


def clean_environment():
    return {key: value for key, value in os.environ.items() if key in ('PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SystemRoot', 'WINDIR')}


def command(args, timeout=60):
    value = subprocess.run([str(item) for item in args], env=clean_environment(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    require(value.returncode == 0)
    return value.stdout


@contextlib.contextmanager
def lock(path):
    import fcntl
    checked(path.parent, directory=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a+b') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600)
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def file_proof(path):
    info = regular(path)
    return (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode), info.st_dev, info.st_ino, digest(path.read_bytes()))


def source_state(gid):
    for path in (APP, APP / 'server'):
        info = checked(path, directory=True).stat()
        require(info.st_uid == 0 and info.st_gid == gid and stat.S_IMODE(info.st_mode) == 0o750)
    result = {}
    for name in PUBLIC_CODE:
        path = APP / name
        regular(path, uid=0, gid=gid, mode=0o640)
        result[name] = file_proof(path)
    require(digest(canonical((APP / 'server/ai-provider.js').read_bytes()).encode()) == PROVIDER_SHA)
    require(digest(canonical((APP / 'server/server.js').read_bytes()).encode()) == SERVER_SHA)
    for path in (APP / 'server/config.json', pathlib.Path('/etc/systemd/system') / SERVICE):
        result[str(path)] = file_proof(path)
    return result


def timer_state():
    require(command(['systemctl', 'is-enabled', 'hr-system-backup.timer']).strip() == b'enabled')
    require(command(['systemctl', 'show', 'hr-system-backup.timer', '-p', 'ActiveState', '--value']).strip() == b'active')
    paths = (pathlib.Path('/etc/systemd/system/hr-system-backup.timer'), pathlib.Path('/etc/systemd/system/hr-system-backup.service'),
             COMMAND, pathlib.Path('/usr/local/lib/hr-system-backup/daily-backup.py'), pathlib.Path('/usr/local/lib/hr-system-backup/installation.json'))
    return {str(path): file_proof(path) for path in paths}


def process_state(helper):
    pid = helper.system_value('MainPID')
    require(re.fullmatch(r'[1-9][0-9]*', pid) and pathlib.Path('/proc', pid, 'cwd').resolve() == APP)
    require(helper.system_value('User') == OWNER)
    for item in pathlib.Path('/proc', pid, 'environ').read_bytes().split(b'\0'):
        key, separator, value = item.partition(b'=')
        require(not (separator and key.startswith(b'HR_AI_') and value))
    require(helper.system_value('MainPID') == pid)
    return pid


def health(helper, port):
    for _ in range(30):
        try:
            code, body = helper.get('http://127.0.0.1:' + str(port), '/api/auth/status')
            value = json.loads(body)
            if code == 200 and value.get('ok') is True and value.get('setupRequired') is False and value.get('storage') == {'backend': 'mysql', 'model': 'relational', 'readOnly': False}:
                return
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise Refused()


def settings_state(path, uid, gid):
    checked(path)
    if not path.exists():
        return None
    info = regular(path, uid=uid, gid=gid, mode=0o600)
    require(info.st_size <= 65536)
    return {'raw': path.read_bytes(), 'identity': (info.st_dev, info.st_ino), 'uid': info.st_uid, 'gid': info.st_gid,
            'mode': stat.S_IMODE(info.st_mode), 'times': (info.st_atime_ns, info.st_mtime_ns)}


def same_settings(context, expected):
    actual = settings_state(context['file'], context['uid'], context['gid'])
    require((actual is None and expected is None) or actual is not None and expected is not None and
            all(actual[key] == expected[key] for key in ('raw', 'identity', 'uid', 'gid', 'mode')))


def full_backup():
    regular(COMMAND, uid=0, mode=0o700)
    result = json.loads(command([COMMAND, '--run'], timeout=5500).decode().splitlines()[-1])
    backup = pathlib.PurePosixPath(result['backup'])
    require(result.get('status') == 'DAILY_BACKUP_OK' and backup.parent == pathlib.PurePosixPath(str(DAILY)) and
            re.fullmatch(r'\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\+0800-[a-f0-9]{12}', backup.name))
    verified = json.loads(command([COMMAND, '--verify', str(backup)], timeout=5500).decode().splitlines()[-1])
    require(verified.get('status') == 'DAILY_BACKUP_VERIFIED' and verified.get('backup') == str(backup))
    return str(backup)


def read_key():
    require(sys.stdin.isatty())
    with warnings.catch_warnings():
        warnings.simplefilter('error', getpass.GetPassWarning)
        key = getpass.getpass('DeepSeek API Key（隐藏输入，不会显示）: ')
    require(isinstance(key, str) and 1 <= len(key) <= 4096 and not re.search(r'[\s\x00-\x1f\x7f]', key))
    return key


def provider_messages():
    raw = (APP / 'server/ai-provider.js').read_text(encoding='utf-8-sig')
    require(digest(canonical(raw.encode()).encode()) == PROVIDER_SHA)
    result = {'HIDDEN'}
    for token in re.findall(r'"(?:[^"\\]|\\.)*"', raw):
        try:
            value = json.loads(token)
            if isinstance(value, str) and len(value) <= 300 and not any(char in value for char in '\r\n\0'):
                result.add(value)
        except ValueError:
            pass
    return result


def node_request(payload):
    allowed = provider_messages()
    value = subprocess.run(['runuser', '-u', OWNER, '--', 'node', '-e', NODE, 'hr-private-ai-configuration', str(APP / 'server/ai-provider.js')],
                           input=json.dumps(payload).encode('utf-8'), env=clean_environment(), cwd=APP,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    require(len(value.stdout) <= 4096)
    result = json.loads(value.stdout.decode('utf-8'))
    if value.returncode != 0:
        require(isinstance(result, dict) and set(result) == {'errorClass', 'message'} and
                result['errorClass'] in ('AIError', 'Error', 'TypeError', 'SyntaxError') and result['message'] in allowed)
        raise NodeFailure(result['errorClass'], result['message'])
    expected = {'connected'} if payload['mode'] == 'test' else {'enabled', 'configured', 'apiKeyConfigured', 'endpointMatches', 'modelMatches'}
    require(isinstance(result, dict) and set(result) == expected and all(value is True for value in result.values()))
    return result


def prepare(publication, model):
    phase = 'host-check'
    try:
        require(os.name == 'posix' and os.geteuid() == 0 and re.fullmatch(r'[\w.:/\-]{1,120}', model, re.ASCII))
        phase = 'helper-audit'; helper = load_helper(publication)
        phase = 'runtime-check'; account = pwd.getpwnam(OWNER)
        data, port, database = helper.runtime()
        phase = 'data-directory'
        require(data != APP and data != APP / 'server')
        info = checked(data, directory=True).stat()
        require(info.st_uid == account.pw_uid and not info.st_mode & 0o002)
        phase = 'service-environment'; pid = process_state(helper)
        phase = 'service-health'; health(helper, port)
        phase = 'source-proof'; sources = source_state(account.pw_gid)
        phase = 'backup-timer'; timer = timer_state()
        phase = 'private-file'; original = settings_state(data / 'ai-settings.json', account.pw_uid, account.pw_gid)
        return {'helper': helper, 'data': data, 'port': port, 'database': database, 'pid': pid, 'model': model,
                'uid': account.pw_uid, 'gid': account.pw_gid, 'file': data / 'ai-settings.json',
                'sources': sources, 'timer': timer, 'original': original}
    except (Exception, KeyboardInterrupt):
        error = Refused()
        error.stage = phase
        raise error from None


def sync_parent(path):
    fd = os.open(path.parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


@contextlib.contextmanager
def defer_signals():
    if not hasattr(signal, 'pthread_sigmask'):
        yield
        return
    selected = {getattr(signal, name) for name in ('SIGINT', 'SIGTERM', 'SIGHUP') if hasattr(signal, name)}
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, selected)
    try:
        yield
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)


def install_settings(context, raw, expected, on_installed):
    same_settings(context, expected)
    descriptor, name = tempfile.mkstemp(prefix='.hr-ai-private-', dir=context['data'])
    pending = pathlib.Path(name)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(raw); stream.flush()
            os.fchown(stream.fileno(), context['uid'], context['gid']); os.fchmod(stream.fileno(), 0o600)
            os.fsync(stream.fileno())
            info = os.fstat(stream.fileno())
        same_settings(context, expected)
        with defer_signals():
            if expected is None:
                os.link(pending, context['file'])
                on_installed({'raw': raw, 'identity': (info.st_dev, info.st_ino), 'uid': context['uid'], 'gid': context['gid'], 'mode': 0o600})
                pending.unlink()
            else:
                os.replace(pending, context['file'])
                on_installed({'raw': raw, 'identity': (info.st_dev, info.st_ino), 'uid': context['uid'], 'gid': context['gid'], 'mode': 0o600})
        sync_parent(context['file'])
    finally:
        if pending.exists():
            pending.unlink()


def verify_configuration(context, written):
    helper = context['helper']
    health(helper, context['port'])
    pid = process_state(helper)
    require(pid != context['pid'])
    data, port, database = helper.runtime()
    require((data, port, database) == (context['data'], context['port'], context['database']))
    require(source_state(context['gid']) == context['sources'] and timer_state() == context['timer'])
    same_settings(context, written)
    node_request({'mode': 'status', 'model': context['model'], 'file': str(context['file'])})
    for route in ('/server/ai-provider.js', '/server/config.json', '/server/data/ai-settings.json'):
        require(helper.get('http://127.0.0.1:' + str(port), route)[0] == 404)
    same_settings(context, written)
    return pid


def public_error(error):
    kind = error.kind if isinstance(error, NodeFailure) else type(error).__name__
    allowed = ('Refused', 'AIError', 'Error', 'TypeError', 'SyntaxError', 'ValueError', 'JSONDecodeError', 'OSError', 'PermissionError', 'FileNotFoundError', 'TimeoutExpired', 'BlockingIOError', 'GetPassWarning', 'KeyboardInterrupt', 'EOFError')
    result = {'errorClass': kind if kind in allowed else 'Error'}
    if isinstance(error, NodeFailure) and error.public_message != 'HIDDEN':
        result['message'] = error.public_message
    return result


def rollback_configuration(context, written):
    """Called while the original daily lock is still held."""
    same_settings(context, written if written is not None else context['original'])
    command(['systemctl', 'stop', SERVICE])
    restored = [None]
    durability_error = None
    try:
        if written is not None:
            if context['original'] is None:
                same_settings(context, written)
                context['file'].unlink()
                restored[0] = {'absent': True}
                sync_parent(context['file'])
            else:
                install_settings(context, context['original']['raw'], written,
                                 lambda value: restored.__setitem__(0, value))
                os.utime(context['file'], ns=context['original']['times'], follow_symlinks=False)
    except (Exception, KeyboardInterrupt) as error:
        durability_error = error
    # Recover availability only after proving the old configuration is visible.
    # A failed parent fsync is reported, even when recovery can safely proceed.
    if written is None:
        same_settings(context, context['original'])
    elif context['original'] is None:
        require(restored[0] == {'absent': True})
        same_settings(context, None)
    else:
        require(restored[0] is not None)
        same_settings(context, restored[0])
    command(['systemctl', 'start', SERVICE])
    health(context['helper'], context['port'])
    return durability_error


def apply(context):
    phase, committed, before, after, written = 'pre-backup', False, None, None, [None]
    try:
        before = full_backup()
        phase = 'credential-input'; key = read_key()
        phase = 'connection-test'
        require(source_state(context['gid']) == context['sources'] and process_state(context['helper']) == context['pid'])
        node_request({'mode': 'test', 'model': context['model'], 'key': key})
        raw = (json.dumps({'enabled': True, 'endpoint': ENDPOINT, 'model': context['model'], 'apiKey': key}, ensure_ascii=False) + '\n').encode('utf-8')
        phase = 'install-configuration'
        with lock(DAILY.parent / '.daily-backup.lock'):
            require(source_state(context['gid']) == context['sources'] and timer_state() == context['timer'])
            require(process_state(context['helper']) == context['pid']); same_settings(context, context['original'])
            try:
                command(['systemctl', 'stop', SERVICE])
                require(context['helper'].system_value('ActiveState') == 'inactive')
                install_settings(context, raw, context['original'], lambda value: written.__setitem__(0, value))
                phase = 'restart-verification'; command(['systemctl', 'start', SERVICE])
                pid = verify_configuration(context, written[0])
                committed = True
            except (Exception, KeyboardInterrupt) as error:
                try:
                    with defer_signals():
                        recovery_error = rollback_configuration(context, written[0])
                    if recovery_error is not None:
                        return {'status': 'DEEPSEEK_CONFIGURATION_NEEDS_ATTENTION', 'stage': 'rollback-durability',
                                'applied': False, 'serviceRecovered': True, 'dataBackup': before, **public_error(recovery_error)}
                except (Exception, KeyboardInterrupt) as rollback_error:
                    return {'status': 'DEEPSEEK_CONFIGURATION_NEEDS_ATTENTION', 'stage': 'rollback', 'applied': False,
                            'configurationWritten': written[0] is not None, 'dataBackup': before, **public_error(rollback_error)}
                return {'status': 'DEEPSEEK_CONFIGURATION_STOPPED', 'stage': phase, 'applied': False,
                        'rolledBack': True, 'dataBackup': before, **public_error(error)}
        phase = 'post-backup'
        after = full_backup()
        pid = verify_configuration(context, written[0])
        return {'status': 'DEEPSEEK_CONFIGURATION_OK', 'applied': True, 'connectionTested': True, 'providerStatusVerified': True,
                'dataBackup': before, 'postConfigurationBackup': after, 'sourceProtected': True, 'dailyBackupTimerPreserved': True,
                'serviceRestarted': True, 'pid': pid, 'model': context['model'], 'endpoint': ENDPOINT}
    except (Exception, KeyboardInterrupt) as error:
        if committed:
            current = False
            try:
                verify_configuration(context, written[0])
                current = True
            except (Exception, KeyboardInterrupt):
                pass
            return {'status': 'DEEPSEEK_CONFIGURATION_APPLIED_NEEDS_ATTENTION', 'stage': phase, 'applied': True,
                    'connectionTested': True, 'currentConfigurationVerified': current,
                    'dataBackup': before, 'postConfigurationBackup': after, **public_error(error)}
        return {'status': 'DEEPSEEK_CONFIGURATION_STOPPED', 'stage': phase, 'applied': False,
                'rolledBack': False, 'dataBackup': before, **public_error(error)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--publication-backup', required=True)
    parser.add_argument('--model', default=MODEL)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args(argv)
    try:
        with lock(pathlib.Path('/run/hr-leave-types-time.lock')) if args.apply else contextlib.nullcontext():
            with lock(pathlib.Path('/run/hr-system-backup-install.lock')) if args.apply else contextlib.nullcontext():
                context = prepare(args.publication_backup, args.model)
                value = apply(context) if args.apply else {'status': 'DEEPSEEK_CONFIGURATION_CHECK', 'readyToApply': True, 'applied': False, 'model': args.model, 'endpoint': ENDPOINT}
    except (Exception, KeyboardInterrupt) as error:
        phases = ('host-check', 'helper-audit', 'runtime-check', 'data-directory', 'service-environment', 'service-health', 'source-proof', 'backup-timer', 'private-file')
        stage = getattr(error, 'stage', 'preflight')
        value = {'status': 'DEEPSEEK_CONFIGURATION_STOPPED', 'stage': stage if stage in phases else 'preflight', 'applied': False, **public_error(error)}
    print(json.dumps(value, ensure_ascii=True), flush=True)
    return 0 if value['status'] in ('DEEPSEEK_CONFIGURATION_CHECK', 'DEEPSEEK_CONFIGURATION_OK') else 2


if __name__ == '__main__':
    os.umask(0o077)
    def interrupted(signum, frame):
        raise KeyboardInterrupt()
    for name in ('SIGTERM', 'SIGHUP'):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), interrupted)
    sys.exit(main())
