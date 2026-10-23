#!/usr/bin/env bash
# Isolated Linux test: fake downloads and service commands, never operate a real service.
set -euo pipefail
SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
((EUID==0)) || { echo 'Run in an isolated Linux container as root';exit 1; }
[[ ! -e /opt/feather-panel-native && ! -e /usr/local/bin/featherpanel ]] || { echo 'Refusing a machine with an existing installation';exit 1; }
TEMP=$(mktemp -d /tmp/feather-bootstrap-test.XXXXXXXX)
trap 'rm -rf -- "$TEMP"' EXIT
export FIXTURE=$TEMP
mkdir -p "$TEMP/bin"
python3 - "$TEMP" <<'PY'
import tarfile,io,hashlib,json,sys,pathlib
root=pathlib.Path(sys.argv[1])
for kind in ['good','unsafe','corrupt']:
 with tarfile.open(root/(kind+'.tar.gz'),'w:gz') as tar:
  text=b'#!/bin/bash\nprintf "%s\\n" "$@" > "$FIXTURE/received"\n'
  item=tarfile.TarInfo('FeatherPanel/install.sh');item.size=len(text);tar.addfile(item,io.BytesIO(text))
  if kind=='unsafe':
   item=tarfile.TarInfo('FeatherPanel/../../escaped');item.size=1;tar.addfile(item,io.BytesIO(b'x'))
 digest=hashlib.sha256((root/(kind+'.tar.gz')).read_bytes()).hexdigest()
 if kind=='corrupt':digest='0'*64
 (root/(kind+'.json')).write_text(json.dumps({'version':'v-test','sha256':digest}))
PY
cat > "$TEMP/bin/curl" <<'SH'
#!/bin/bash
set -eu
url= out=
while (($#));do case "$1" in https://*)url=$1;shift;;-o)out=$2;shift 2;;*)shift;;esac;done
printf '%s\n' "$url" >> "$FIXTURE/urls"
[[ ${FAIL_DOWNLOAD:-0} != 1 ]] || exit 28
[[ ${REQUIRE_NO_METADATA:-0} != 1 || $url != */release-info.json ]] || exit 99
case "$url" in
 https://gh-proxy.com/*) test "${FAIL_PROXY:-0}" != 1 || exit 28;url=${url#https://gh-proxy.com/};;
 https://ghfast.top/*) url=${url#https://ghfast.top/};;
 *) test "${FAIL_DIRECT:-0}" != 1 || exit 28;;
esac
url=${url/https:\/\/github.com\/Babala524\/-\//https:\/\/github.com\/test\/panel\/}
case "$url" in
 https://github.com/test/panel/releases/latest/download/release-info.json|https://github.com/test/panel/releases/download/v-test/release-info.json)cp "$FIXTURE/${CASE:-good}.json" "$out";;
 https://github.com/test/panel/releases/download/v-test/FeatherPanel-native.tar.gz)cp "$FIXTURE/${CASE:-good}.tar.gz" "$out";;
 *)echo "Unexpected URL $url" >&2;exit 1;;
esac
SH
chmod 755 "$TEMP/bin/curl"
export PATH="$TEMP/bin:$PATH"
bash -n "$SOURCE/install-online.sh" "$SOURCE/install.sh" "$SOURCE/deploy/featherpanel"
bash "$SOURCE/install-online.sh" --repo test/panel --line direct --port 18081 --check
printf '%s\n' --port 18081 --check > "$TEMP/expected"
cmp "$TEMP/received" "$TEMP/expected"
rm "$TEMP/received"
FAIL_DIRECT=1 FAIL_PROXY=1 bash "$SOURCE/install-online.sh" --install --repo test/panel --line auto
grep -q 'https://ghfast.top/https://github.com/test/panel' "$TEMP/urls"
rm "$TEMP/received"
if FAIL_DIRECT=1 bash "$SOURCE/install-online.sh" --install --repo test/panel --line direct;then exit 1;fi
test ! -e "$TEMP/received"
for bad in corrupt unsafe;do
 if CASE=$bad bash "$SOURCE/install-online.sh" --install --repo test/panel --line direct;then exit 1;fi
 test ! -e "$TEMP/received"
done
if bash "$SOURCE/install-online.sh" --repo ../panel;then exit 1;fi
if bash "$SOURCE/install-online.sh" --line attacker.example;then exit 1;fi
# Published standalone entry pins its verified package and avoids a metadata request.
python3 - "$SOURCE/install-online.sh" "$TEMP" <<'PY'
import json,pathlib,sys
root=pathlib.Path(sys.argv[2]);script=pathlib.Path(sys.argv[1]).read_text()
digest=json.loads((root/'good.json').read_text())['sha256']
script=script.replace('BUNDLED_VERSION=\n','BUNDLED_VERSION=v-test\n',1).replace('BUNDLED_SHA256=\n','BUNDLED_SHA256='+digest+'\n',1)
(root/'published.sh').write_text(script)
PY
: > "$TEMP/urls"
REQUIRE_NO_METADATA=1 bash "$TEMP/published.sh" --install --line direct
test "$(wc -l < "$TEMP/urls")" = 1
: > "$TEMP/urls"
bash "$TEMP/published.sh" --install --refresh --line direct
grep -q '/latest/download/release-info.json' "$TEMP/urls"
# Failed downloads return to the menu and allow exit without executing an installer.
rm -f "$TEMP/received"
printf '9\n2\n18081\n0\n' | FAIL_DOWNLOAD=1 bash "$SOURCE/install-online.sh" --menu --repo test/panel > "$TEMP/failed-menu" 2>&1
grep -q '操作失败' "$TEMP/failed-menu"
test ! -e "$TEMP/received"
printf 'bad\n3\n0\n' | bash "$SOURCE/install-online.sh" --menu > "$TEMP/menu"
grep -q '请输入 0～9' "$TEMP/menu"
grep -q '请先安装原生面板' "$TEMP/menu"
printf '9\n2\n18081\n0\n' | bash "$SOURCE/install-online.sh" --menu --repo test/panel
printf '%s\n' --check --port 18081 > "$TEMP/expected"
cmp "$TEMP/received" "$TEMP/expected"
# Installed service menu dispatch uses a harmless fake command under a temporary container.
mkdir -p /opt/feather-panel-native /usr/local/bin
touch /opt/feather-panel-native/.native-install
cat > /usr/local/bin/featherpanel <<'SH'
#!/bin/bash
printf '%s\n' "$*" >> "$FIXTURE/actions"
SH
chmod 755 /usr/local/bin/featherpanel
printf '#!/bin/sh\nexit 0\n' > "$TEMP/bin/systemctl";chmod 755 "$TEMP/bin/systemctl"
printf '3\n4\n5\n6\n7\n8\n0\n' | bash "$SOURCE/install-online.sh" --menu > "$TEMP/installed-menu"
printf '%s\n' start stop restart status logs-recent key > "$TEMP/expected-actions"
cmp "$TEMP/actions" "$TEMP/expected-actions"
echo NATIVE_BOOTSTRAP_MENU_FALLBACK_VALIDATION_TESTS_PASSED
