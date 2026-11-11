#!/usr/bin/env bash
# Deploy the reviewed 2026-11-11 release; never copy development data or credentials.
set -Eeuo pipefail
umask 077
APP=/opt/hr-system
SERVICE=hr-system.service
COMMIT=39cbf2ff691a99f79a69cf7f945b41ead1c21dbd
ARCHIVE_SHA=ca25bd8f371e6390a6cbe992a910d9d45b55cdcfc66f1775b25fc216f9e2c5c9
[[ $(id -u) == 0 && $(realpath "$APP") == "$APP" && -f "$APP/server/server.js" ]]
systemctl is-active --quiet "$SERVICE"
PID=$(systemctl show "$SERVICE" -p MainPID --value)
OWNER=$(systemctl show "$SERVICE" -p User --value)
[[ "$PID" =~ ^[1-9][0-9]*$ && "$OWNER" == hrsystem ]]
STAGE=$(mktemp -d /tmp/hr-release-20261111.XXXXXXXX)
BACKUP=/root/hr-system-backups/2026-11-11-$(date +%H%M%S)-$$
install -d -m 700 "$BACKUP"
python3 - "$PID" "$APP" > "$BACKUP/runtime.json" <<'PY'
import json, os, pathlib, sys
pid, app = sys.argv[1:]
env = dict(entry.decode().split('=', 1) for entry in pathlib.Path('/proc/' + pid + '/environ').read_bytes().split(b'\0') if b'=' in entry)
service_cwd = pathlib.Path('/proc/' + pid + '/cwd').resolve(strict=True)
if service_cwd != pathlib.Path(app):
    raise RuntimeError('Service working directory must be /opt/hr-system')
config_path = pathlib.Path(app) / 'server/config.json'
config = json.loads(config_path.read_text()) if config_path.exists() else {}
mysql = config.get('mysql') or {}
data_path = pathlib.Path(env.get('HR_DATA_DIR') or app + '/server/data')
if not data_path.is_absolute():
    data_path = service_cwd / data_path
mysql_enabled = (env.get('HR_MYSQL_ENABLED') or str(bool(mysql.get('enabled')))).lower() == 'true'
mysql_host = env.get('HR_MYSQL_HOST') or mysql.get('host') or '127.0.0.1'
mysql_port = int(env.get('HR_MYSQL_PORT') or mysql.get('port') or 3306)
if mysql_enabled and (mysql_host not in ('127.0.0.1', 'localhost') or mysql_port != 3306):
    raise RuntimeError('This deployment helper requires local MySQL on port 3306')
metadata = {'data_dir': os.path.realpath(data_path),
            'port': int(env.get('HR_PORT') or config.get('port') or 8080),
            'mysql_enabled': mysql_enabled,
            'database': env.get('HR_MYSQL_DATABASE') or mysql.get('database') or 'hr_system'}
assert 0 < metadata['port'] < 65536
assert pathlib.Path(metadata['data_dir']).is_dir()
assert metadata['database'].replace('_', '').replace('-', '').isalnum()
print(json.dumps(metadata))
PY
DATA_DIR=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["data_dir"])' "$BACKUP/runtime.json")
PORT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["port"])' "$BACKUP/runtime.json")
MYSQL_ENABLED=$(python3 -c 'import json,sys; print(int(json.load(open(sys.argv[1]))["mysql_enabled"]))' "$BACKUP/runtime.json")
DATABASE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["database"])' "$BACKUP/runtime.json")
[[ "$DATA_DIR" != / && "$DATA_DIR" != /root && "$DATA_DIR" != "$BACKUP" && "$DATA_DIR" != /tmp ]]
runuser -u "$OWNER" -- test -w "$DATA_DIR"
df -Pk "$APP" "$BACKUP"
printf 'Preparing release %s\n' "$COMMIT"
if [[ -n "${HR_RELEASE_ARCHIVE:-}" ]]; then
  cp -- "$HR_RELEASE_ARCHIVE" "$STAGE/source.tar.gz"
else
  curl --fail --location --connect-timeout 15 --max-time 120 --retry 1 --silent --show-error "https://codeload.github.com/TiMi-fengye/AI--/tar.gz/$COMMIT" -o "$STAGE/source.tar.gz"
fi
printf '%s  %s\n' "$ARCHIVE_SHA" "$STAGE/source.tar.gz" | sha256sum --check --status
install -d -m 700 "$STAGE/source"
tar -xzf "$STAGE/source.tar.gz" --strip-components=1 -C "$STAGE/source"
SOURCE=$STAGE/source
cat > "$BACKUP/release-files.txt" <<'FILES'
2026-11-11.md
README.md
css/style.css
index.html
login.html
status.html
sw.js
js/admin.js
js/ai.js
js/app.js
js/attendance.js
js/auth.js
js/cost.js
js/dashboard.js
js/employee-profile.js
js/employees.js
js/importer.js
js/leave.js
js/org.js
js/overtime.js
js/performance.js
js/permission.js
js/store.js
js/my-hours.js
js/self-profile.js
server/config.example.json
server/server.js
server/auth-service.js
tests/client-session.test.js
tests/frontend-permissions.test.js
tests/personnel-html-safety.test.js
tests/registration-profile.test.js
tests/server-auth.test.js
updates/2026-11-11.md
技术文档/README.md
技术文档/07-手机号账号与数据权限.md
FILES
python3 - "$SOURCE" "$APP" "$BACKUP" <<'PY'
import pathlib, sys
source, app, backup = map(pathlib.Path, sys.argv[1:])
def checked_file(root, relative, required):
    if root.resolve() != root:
        raise RuntimeError('Release directories must not contain symbolic links')
    parts = pathlib.PurePosixPath(relative).parts
    if not parts or pathlib.PurePosixPath(relative).is_absolute() or '..' in parts:
        raise RuntimeError('Invalid release path')
    path = root
    for index, part in enumerate(parts):
        path = path / part
        if path.is_symlink():
            raise RuntimeError('Release paths and parent directories must not be symbolic links: ' + relative)
        if index < len(parts) - 1 and path.exists() and not path.is_dir():
            raise RuntimeError('Release parent path is not a directory: ' + relative)
    if (required or path.exists()) and not path.is_file():
        raise RuntimeError('Release path is not a regular file: ' + relative)
    return path
existing = []
for relative in (backup / 'release-files.txt').read_text().splitlines():
    checked_file(source, relative, True)
    if checked_file(app, relative, False).exists():
        existing.append(relative)
(backup / 'existing-files.txt').write_text(''.join(name + '\n' for name in existing))
PY
while IFS= read -r file; do
  if [[ "$file" == *.js ]]; then node --check "$SOURCE/$file"; fi
done < "$BACKUP/release-files.txt"
(cd "$SOURCE" && node --test tests/*.test.js) > "$BACKUP/release-tests.log" 2>&1
tail -n 9 "$BACKUP/release-tests.log"
if [[ "$MYSQL_ENABLED" == 1 ]]; then
  [[ $(mysql --protocol=socket -uroot -NBe 'SELECT @@port') == 3306 ]]
  mysql --protocol=socket -uroot "$DATABASE" -NBe "SELECT SHA2(payload,256), COALESCE(JSON_LENGTH(payload,'$.employees'),0) FROM system_snapshots WHERE snapshot_key='default'" > "$BACKUP/mysql-before.txt"
fi
STOPPED=0
CHANGED=0
SUCCESS=0
rollback() {
  code=$?
  trap - EXIT
  if [[ "$SUCCESS" != 1 ]]; then
    printf 'Deployment failed. Restoring previous code; backup: %s\n' "$BACKUP" >&2
    if [[ "$CHANGED" == 1 ]]; then
      systemctl stop "$SERVICE" || true
      while IFS= read -r file; do
        if ! grep -Fxq "$file" "$BACKUP/existing-files.txt" && [[ -f "$APP/$file" ]]; then
          install -d -m 700 "$BACKUP/failed-new-files/$(dirname "$file")"
          mv -- "$APP/$file" "$BACKUP/failed-new-files/$file"
        fi
      done < "$BACKUP/release-files.txt"
      tar -xzpf "$BACKUP/previous-code.tar.gz" -C "$APP" || true
    fi
    if [[ "$STOPPED" == 1 ]]; then systemctl start "$SERVICE" || true; fi
  fi
  exit "$code"
}
trap rollback EXIT
printf 'Backing up production to %s\n' "$BACKUP"
systemctl stop "$SERVICE"
STOPPED=1
tar -czpf "$BACKUP/application.tar.gz" -C "$APP" .
tar -tzf "$BACKUP/application.tar.gz" > /dev/null
tar -czpf "$BACKUP/previous-code.tar.gz" -C "$APP" -T "$BACKUP/existing-files.txt"
if [[ "$DATA_DIR" != "$APP/server/data" ]]; then tar -czpf "$BACKUP/runtime-data.tar.gz" -C "$DATA_DIR" .; fi
tar -czpf "$BACKUP/service-config.tar.gz" -C / etc/systemd/system/hr-system.service etc/nginx/sites-available etc/nginx/sites-enabled
if [[ -d /etc/hr-system ]]; then tar -czpf "$BACKUP/hr-system-config.tar.gz" -C / etc/hr-system; fi
if [[ "$MYSQL_ENABLED" == 1 ]]; then
  mysqldump --protocol=socket -uroot --single-transaction --no-tablespaces --routines --triggers "$DATABASE" > "$BACKUP/mysql.sql"
  [[ -s "$BACKUP/mysql.sql" ]]
  mysql --protocol=socket -uroot "$DATABASE" -NBe "SELECT SHA2(payload,256), COALESCE(JSON_LENGTH(payload,'$.employees'),0) FROM system_snapshots WHERE snapshot_key='default'" > "$BACKUP/mysql-before.txt"
fi
python3 - "$BACKUP" "$DATA_DIR" "$APP" <<'PY'
import hashlib, json, pathlib, sys
backup, data, app = map(pathlib.Path, sys.argv[1:])
paths = [app / 'server/config.json', *sorted(data.glob('*.json'))]
hashes = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths if p.is_file()}
(backup / 'protected-file-hashes.json').write_text(json.dumps(hashes))
PY
CHANGED=1
while IFS= read -r file; do
  install -D -m 644 -o "$OWNER" -g "$OWNER" "$SOURCE/$file" "$APP/$file"
done < "$BACKUP/release-files.txt"
systemctl start "$SERVICE"
for attempt in $(seq 1 30); do
  if curl --fail --silent --max-time 2 "http://127.0.0.1:$PORT/api/auth/status" > "$BACKUP/auth-status.json"; then break; fi
  sleep 1
done
systemctl is-active --quiet "$SERVICE"
python3 - "$PORT" "$BACKUP" <<'PY'
import hashlib, json, pathlib, sys, urllib.error, urllib.request
port, backup = sys.argv[1:]
backup = pathlib.Path(backup)
base = 'http://127.0.0.1:' + port
status = json.load(urllib.request.urlopen(base + '/api/auth/status', timeout=5))
assert status.get('ok') is True
page = urllib.request.urlopen(base + '/login.html', timeout=5).read().decode()
assert '手机号注册' in page and 'js/wechat.js' not in page
for path, expected in [('/api/data/snapshot.json',401),('/server/config.json',404),('/server/data/auth-users.json',404),('/api/feishu/login-config',410)]:
    try: response = urllib.request.urlopen(base + path, timeout=5); code = response.status
    except urllib.error.HTTPError as error: code = error.code
    assert code == expected, (path, code, expected)
for name, expected in json.loads((backup / 'protected-file-hashes.json').read_text()).items():
    assert hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest() == expected, 'Protected production file changed'
print('Local health checks passed. Admin initialization required:', status.get('setupRequired'))
PY
if [[ "$MYSQL_ENABLED" == 1 ]]; then
  mysql --protocol=socket -uroot "$DATABASE" -NBe "SELECT SHA2(payload,256), COALESCE(JSON_LENGTH(payload,'$.employees'),0) FROM system_snapshots WHERE snapshot_key='default'" > "$BACKUP/mysql-after.txt"
  cmp --silent "$BACKUP/mysql-before.txt" "$BACKUP/mysql-after.txt"
  printf 'MySQL snapshot preserved; employee count: '
  cut -f 2 "$BACKUP/mysql-after.txt"
fi
printf '%s\n' "$COMMIT" > "$BACKUP/deployed-commit.txt"
SUCCESS=1
printf 'DEPLOYMENT_OK commit=%s backup=%s\n' "$COMMIT" "$BACKUP"
