#!/usr/bin/env bash
# Install from a complete, locally extracted FeatherPanel release.
set -Eeuo pipefail
umask 027
SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
BASE=/opt/feather-panel-native
DATA=/var/lib/feather-panel
ENV_FILE=/etc/feather-panel.env
UNIT=/etc/systemd/system/feather-panel.service
ACCOUNT=featherpanel
PORT=80
PORT_SET=0
CHECK=0
NODE_VERSION=24.22.1
NODE_SHA=6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6
STAGE='检查环境'
trap 'printf "\n未完成步骤：%s。请查看上述错误后重试。\n" "$STAGE" >&2' ERR
step(){ STAGE=$2;printf '\n安装 [%s/6] %s\n' "$1" "$STAGE"; }
die(){ printf '错误：%s\n' "$*" >&2; exit 1; }
usage(){ printf '用法：sudo bash install.sh [--port 80] [--check]\n--check 只检查环境，不安装软件或修改服务。\n'; }
while (($#));do
  case "$1" in
    --port) (($#>=2)) || die '--port 缺少端口'; PORT=$2;PORT_SET=1;shift 2;;
    --check) CHECK=1;shift;;
    -h|--help) usage;exit 0;;
    *) die "未知参数：$1";;
  esac
done
[[ $PORT =~ ^[0-9]{1,5}$ ]] && ((10#$PORT>=1 && 10#$PORT<=65535)) || die '端口必须是 1～65535'
PORT=$((10#$PORT))
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || die '目前支持 x86_64 Linux；饥荒服务端不支持本脚本的 ARM 部署'
[[ -f /etc/os-release ]] || die '无法识别系统'
. /etc/os-release
case "$ID:$VERSION_ID" in ubuntu:22.04|ubuntu:24.04|debian:12|debian:13) ;; *) die '目前支持 Ubuntu 22.04/24.04、Debian 12/13';; esac
[[ -d /run/systemd/system ]] && command -v systemctl >/dev/null || die '需要 systemd；请在云服系统里执行'
for item in index.html backend-client.js wallpaper.mp4 install-online.sh backend/src/server.mjs backend/src/accounts.mjs backend/scripts/native-maintenance.mjs deploy/feather-panel.service deploy/featherpanel deploy/feather-dependencies.mjs deploy/install-dependencies.sh deploy/feather-python deploy/feather-panel-dependencies.socket deploy/feather-panel-dependencies@.service vendor assets;do
  [[ -e "$SOURCE/$item" ]] || die "源码包不完整：缺少 $item"
done
if [[ -f $ENV_FILE ]];then
  EXISTING_PORT=$(sed -n 's/^FEATHER_PORT=//p' "$ENV_FILE" | tail -1)
  [[ $EXISTING_PORT =~ ^[0-9]{1,5}$ ]] || die '现有环境文件 FEATHER_PORT 无效'
  if ((PORT_SET)) && [[ $PORT != "$EXISTING_PORT" ]];then die "已有安装使用端口 $EXISTING_PORT；请编辑 $ENV_FILE 后用 featherpanel restart";fi
  PORT=$EXISTING_PORT
fi
ACTIVE=0
systemctl is-active --quiet feather-panel.service && ACTIVE=1
if command -v ss >/dev/null && ss -H -ltn "sport = :$PORT" | read -r _;then
  ((ACTIVE)) || die "TCP $PORT 已被占用；可使用 --port 指定空闲端口，不会停止其他服务"
fi
[[ ! -L $BASE && ! -L $DATA ]] || die '安装目录和数据目录不能是符号链接'
printf '系统：%s %s，架构 x86_64\n面板端口：%s\n程序：%s\n数据：%s\n' "$ID" "$VERSION_ID" "$PORT" "$BASE" "$DATA"
if ((CHECK));then printf '环境检查通过，未修改系统。\n';exit 0;fi
((EUID==0)) || die '请使用 sudo bash install.sh'
command -v flock >/dev/null || die '缺少 flock，请先安装 util-linux'
exec 9>/run/lock/feather-panel-install.lock
flock -n 9 || die '另一项安装正在进行'
if [[ -e $BASE && ! -f $BASE/.native-install ]];then die "$BASE 不是本脚本创建的目录，请先检查";fi
if [[ -e $DATA && ! -f $BASE/.native-install ]];then die "$DATA 已有数据；本脚本不会自动导入或覆盖";fi
if [[ -e $UNIT && ! -f $BASE/.native-install ]];then die '发现其他 feather-panel.service，不会覆盖';fi
export DEBIAN_FRONTEND=noninteractive
step 1 '检查面板最小环境（开服和地图依赖按需准备）'
APT_OPTIONS=(-o Acquire::Retries=2 -o Acquire::http::Timeout=25 -o Acquire::https::Timeout=25)
packages=()
for package in ca-certificates tar xz-utils iproute2 util-linux;do
 [[ $(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true) == 'install ok installed' ]] || packages+=("$package")
done
if [[ ! -f $SOURCE/runtime/node-v$NODE_VERSION-linux-x64.tar.xz && ! -x $BASE/runtime/node-v$NODE_VERSION-linux-x64/bin/node ]];then command -v curl >/dev/null || packages+=(curl);fi
if ((${#packages[@]}));then
 apt-get "${APT_OPTIONS[@]}" -o APT::Update::Error-Mode=any update
 apt-get "${APT_OPTIONS[@]}" install -y --no-install-recommends "${packages[@]}"
else echo '基础工具已齐全，跳过软件源刷新与安装';fi
if ! id "$ACCOUNT" >/dev/null 2>&1;then useradd --system --user-group --home-dir "$DATA" --shell /usr/sbin/nologin "$ACCOUNT";fi
[[ $(id -u "$ACCOUNT") != 0 && $(getent passwd "$ACCOUNT" | cut -d: -f6) == "$DATA" ]] || die '已有服务账号不符合原生部署目录约定'
getent group "$ACCOUNT" >/dev/null || die '服务账号缺少同名组'
install -d -m 0755 "$BASE" "$BASE/releases" "$BASE/runtime"
install -d -m 0700 -o "$ACCOUNT" -g "$ACCOUNT" "$DATA"
install -d -m 0700 -o "$ACCOUNT" -g "$ACCOUNT" "$DATA/screen"
touch "$BASE/.native-install"
TEMP=$(mktemp -d /tmp/feather-native.XXXXXXXX)
trap 'rm -rf -- "$TEMP"' EXIT
NODE_DIR="$BASE/runtime/node-v$NODE_VERSION-linux-x64"
step 2 '准备独立 Node.js 运行环境'
if [[ ! -x $NODE_DIR/bin/node ]];then
  if [[ -f $SOURCE/runtime/node-v$NODE_VERSION-linux-x64.tar.xz ]];then
    echo '使用部署包自带的 Node.js，无需单独下载或安装系统 Node.js'
    cp "$SOURCE/runtime/node-v$NODE_VERSION-linux-x64.tar.xz" "$TEMP/node.tar.xz"
  else
    echo "源码安装：下载独立 Node.js $NODE_VERSION……"
    curl --fail --location --retry 3 --retry-all-errors --connect-timeout 15 --speed-time 30 --speed-limit 1024 --max-time 600 "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" -o "$TEMP/node.tar.xz"
  fi
  printf '%s  %s\n' "$NODE_SHA" "$TEMP/node.tar.xz" | sha256sum --check --status || die 'Node.js 校验失败'
  tar -xJf "$TEMP/node.tar.xz" -C "$BASE/runtime" --no-same-owner
fi
"$NODE_DIR/bin/node" --input-type=module -e 'import {DatabaseSync} from "node:sqlite"; const db=new DatabaseSync(":memory:"); db.close();'
RELEASE="$BASE/releases/$(date -u +%Y%m%dT%H%M%SZ)-$$"
install -d -m 0755 "$RELEASE"
for item in backend vendor licenses assets deploy index.html backend-client.js wallpaper.mp4 install-online.sh README.md THIRD_PARTY_NOTICES.md;do
  [[ -e "$SOURCE/$item" ]] && cp -R -- "$SOURCE/$item" "$RELEASE/"
done
chmod -R u=rwX,go=rX "$RELEASE"
chmod 0755 "$RELEASE/deploy/feather-python"
if [[ ${FEATHER_RELEASE_VERSION:-} =~ ^[A-Za-z0-9_.-]+$ ]];then printf '%s\n' "$FEATHER_RELEASE_VERSION" > "$RELEASE/.release-version";chmod 0644 "$RELEASE/.release-version";fi
"$NODE_DIR/bin/node" --check "$RELEASE/backend/src/server.mjs"
"$NODE_DIR/bin/node" --check "$RELEASE/backend/scripts/native-maintenance.mjs"
install -d -m 0700 -o "$ACCOUNT" -g "$ACCOUNT" "$DATA/steamcmd"
step 3 '配置首次使用时自动准备依赖'
echo '暂不下载 SteamCMD，不安装 Python、screen 和游戏运行库'
OLD_RELEASE=$(readlink -f "$BASE/current" || true)
step 4 '保存原运行世界与服务配置'
BACKUP="$BASE/backups/$(date -u +%Y%m%dT%H%M%SZ)-$$"
install -d -m 0700 "$BACKUP"
[[ ! -f $UNIT ]] || cp "$UNIT" "$BACKUP/service"
[[ ! -f $ENV_FILE ]] || cp "$ENV_FILE" "$BACKUP/environment"
if [[ ! -f $ENV_FILE ]];then
  cat > "$ENV_FILE" <<EOF
FEATHER_HOST=0.0.0.0
FEATHER_PORT=$PORT
FEATHER_DATA=$DATA
FEATHER_GAME=$DATA/dst
FEATHER_STEAM=$DATA/steamcmd
FEATHER_PYTHON=$BASE/current/deploy/feather-python
FEATHER_ALLOW_REGISTRATION=0
FEATHER_SECURE_COOKIE=0
TZ=Asia/Shanghai
EOF
fi
chmod 0600 "$ENV_FILE"
if ! ss -H -ltn "sport = :$PORT" | read -r _;then :;elif ((!ACTIVE));then die "TCP $PORT 已被占用，安装已停止";fi
if ((ACTIVE));then
  echo '安全保存并关闭原生实例中的世界……'
  "$NODE_DIR/bin/node" "$RELEASE/backend/scripts/native-maintenance.mjs" stop "$BACKUP/worlds.json"
  systemctl stop feather-panel.service
fi
if [[ -f $DATA/panel.sqlite ]];then "$NODE_DIR/bin/node" --input-type=module -e 'import {DatabaseSync,backup} from "node:sqlite";const db=new DatabaseSync(process.argv[1],{readOnly:true});await backup(db,process.argv[2]);db.close();' "$DATA/panel.sqlite" "$BACKUP/panel.sqlite";fi
if grep -q '^FEATHER_PYTHON=' "$ENV_FILE";then sed -i "s|^FEATHER_PYTHON=.*|FEATHER_PYTHON=$BASE/current/deploy/feather-python|" "$ENV_FILE";
else printf '\nFEATHER_PYTHON=%s/current/deploy/feather-python\n' "$BASE" >> "$ENV_FILE";fi
ln -sfn "$RELEASE" "$BASE/current.next"
step 5 '切换程序并启动服务'
mv -Tf "$BASE/current.next" "$BASE/current"
sed "s|@NODE@|$NODE_DIR/bin/node|g" "$SOURCE/deploy/feather-panel.service" > "$UNIT"
install -m 0755 "$SOURCE/deploy/featherpanel" /usr/local/bin/featherpanel
install -m 0644 "$SOURCE/deploy/feather-panel-dependencies.socket" /etc/systemd/system/feather-panel-dependencies.socket
sed -e "s|@NODE@|$NODE_DIR/bin/node|g" -e "s|@RELEASE@|$RELEASE|g" "$SOURCE/deploy/feather-panel-dependencies@.service" > /etc/systemd/system/feather-panel-dependencies@.service
systemctl daemon-reload
rollback(){
  echo '新服务启动失败；日志：' >&2
  journalctl -u feather-panel.service -n 30 --no-pager >&2 || true
  systemctl stop feather-panel.service || true
  if [[ -n $OLD_RELEASE && -f $BACKUP/service ]];then
    ln -sfn "$OLD_RELEASE" "$BASE/current.next";mv -Tf "$BASE/current.next" "$BASE/current"
    cp "$BACKUP/service" "$UNIT";[[ ! -f $BACKUP/environment ]] || cp "$BACKUP/environment" "$ENV_FILE";systemctl daemon-reload;systemctl start feather-panel.service
    if ((ACTIVE));then "$NODE_DIR/bin/node" "$OLD_RELEASE/backend/scripts/native-maintenance.mjs" restore "$BACKUP/worlds.json";fi
  fi
  die "安装未完成；备份保留在 $BACKUP"
}
systemctl enable --now feather-panel-dependencies.socket || rollback
systemctl start feather-panel.service || rollback
if ! "$NODE_DIR/bin/node" "$RELEASE/backend/scripts/native-maintenance.mjs" health;then rollback;fi
step 6 '检查健康状态并恢复原运行世界'
systemctl enable feather-panel.service
if ((ACTIVE));then "$NODE_DIR/bin/node" "$RELEASE/backend/scripts/native-maintenance.mjs" restore "$BACKUP/worlds.json" || die "面板已更新，部分世界未能启动，请查看日志；原状态：$BACKUP/worlds.json";fi
printf '\n安装完成：内网 TCP %s，服务名 feather-panel。\n' "$PORT"
echo 'NAT 云服请把自己的公网端口转发到此内网端口。'
echo '查看初始化密钥：sudo featherpanel key'
echo '查看服务状态：sudo featherpanel status'
echo '查看面板日志：sudo featherpanel logs'
echo '再次打开部署管理菜单：sudo featherpanel'
