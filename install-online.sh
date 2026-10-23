#!/usr/bin/env bash
# Online installer and native service menu. Publish the generated dist/ entry.
set -Eeuo pipefail
umask 077
REPOSITORY=Babala524/-
RELEASE_VERSION=latest
BUNDLED_VERSION=
BUNDLED_SHA256=
DOWNLOAD_LINE=auto
MODE=auto
REFRESH=0
INSTALL_ARGS=()
die(){ printf '错误：%s\n' "$*" >&2;exit 1; }
usage(){ printf '用法：sudo bash install-online.sh [--menu|--install] [--line auto|direct|gh-proxy.com|ghfast.top]\n       [--repo 用户名/仓库] [--version 标签] [--port 80] [--check]\n终端运行默认显示管理菜单；无人值守安装请使用 --install。\n'; }
while (($#));do
 case "$1" in
  --repo) (($#>=2)) || die '--repo 缺少仓库';REPOSITORY=$2;shift 2;;
  --version) (($#>=2)) || die '--version 缺少标签';RELEASE_VERSION=$2;shift 2;;
  --line) (($#>=2)) || die '--line 缺少下载线路';DOWNLOAD_LINE=$2;shift 2;;
  --menu) MODE=menu;shift;;
  --install) MODE=install;shift;;
  --refresh) REFRESH=1;shift;;
  --port) (($#>=2)) || die '--port 缺少端口';INSTALL_ARGS+=(--port "$2");shift 2;;
  --check) INSTALL_ARGS+=(--check);MODE=install;shift;;
  -h|--help) usage;exit 0;;
  *) die "未知参数：$1";;
 esac
done
[[ $REPOSITORY =~ ^[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+$ && $REPOSITORY != */. && $REPOSITORY != */.. ]] || die '请指定 --repo GitHub用户名/仓库名'
[[ $RELEASE_VERSION =~ ^[A-Za-z0-9_.-]+$ && $RELEASE_VERSION != . && $RELEASE_VERSION != .. ]] || die '版本标签格式不合法'
case "$DOWNLOAD_LINE" in auto|direct|gh-proxy.com|ghfast.top) ;; *) die '未知下载线路';; esac
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || die '目前支持 x86_64 Linux'
[[ -f /etc/os-release ]] || die '无法识别系统'
. /etc/os-release
case "$ID:$VERSION_ID" in ubuntu:22.04|ubuntu:24.04|debian:12|debian:13) ;; *) die '目前支持 Ubuntu 22.04/24.04、Debian 12/13';; esac
((EUID==0)) || die '请使用 sudo bash install-online.sh'
SELF=$(readlink -f -- "${BASH_SOURCE[0]}")
if [[ $MODE == auto ]];then
 if [[ -t 0 ]];then MODE=menu;else MODE=install;fi
fi
fetch_file(){
 local origin=$1 output=$2 limit=${3:-900} line target attempt
 local -a lines
 case "$DOWNLOAD_LINE" in auto) lines=(direct gh-proxy.com ghfast.top);; *) lines=("$DOWNLOAD_LINE");; esac
 for line in "${lines[@]}";do
  if [[ $line == direct ]];then target=$origin;else target="https://$line/$origin";fi
  for attempt in 1 2;do
   printf '下载线路：%s · 尝试 %s/2\n' "$line" "$attempt" >&2
   if curl --fail --location --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time "$limit" --speed-time 25 --speed-limit 1024 --progress-bar "$target" -o "$output.part";then
    mv -f -- "$output.part" "$output";return 0
   fi
   rm -f -- "$output.part"
   printf '当前线路下载失败。\n' >&2
  done
  [[ $DOWNLOAD_LINE != auto ]] || printf '切换下一条下载线路……\n' >&2
 done
 echo '下载失败。请检查网络，或重新运行选择其他线路。' >&2
 return 1
}
select_line(){
 printf '\n下载线路\n  1. 自动切换（默认）\n  2. GitHub 直连\n  3. gh-proxy.com\n  4. ghfast.top\n'
 local answer
 read -r -p '请选择 [1]：' answer || return 1
 case "${answer:-1}" in 1) DOWNLOAD_LINE=auto;;2) DOWNLOAD_LINE=direct;;3) DOWNLOAD_LINE=gh-proxy.com;;4) DOWNLOAD_LINE=ghfast.top;;*) echo '选项无效';return 1;;esac
}
if [[ $MODE == menu ]];then
 while true;do
  printf '\n━━━━━━━━ 绯羽 FeatherPanel ━━━━━━━━\n'
  if [[ -f /opt/feather-panel-native/.native-install ]];then
   printf '原生部署：已安装 · '
   if systemctl is-active --quiet feather-panel.service;then echo '运行中';else echo '已停止或启动失败';fi
  else echo '原生部署：未安装';fi
  printf '  1. 安装面板\n  2. 更新面板\n  3. 启动面板\n  4. 安全停止面板\n  5. 安全重启面板\n  6. 查看服务状态\n  7. 查看最近日志\n  8. 查看初始化密钥\n  9. 检查安装环境\n  0. 退出\n'
  read -r -p '请输入编号：' choice || exit 0
  case "$choice" in
   0) exit 0;;
   1|2|9)
    if [[ $choice == 2 && ! -f /opt/feather-panel-native/.native-install ]];then echo '请先安装原生面板。';continue;fi
    select_line || continue
    args=(--install --repo "$REPOSITORY" --line "$DOWNLOAD_LINE" --version "$RELEASE_VERSION" "${INSTALL_ARGS[@]}")
    if [[ $choice == 2 ]];then args+=(--refresh);fi
    if [[ $choice == 9 ]];then args+=(--check);fi
    if [[ $choice != 2 && ! -f /etc/feather-panel.env && ${#INSTALL_ARGS[@]} == 0 ]];then
     read -r -p '内网 TCP 端口 [80]：' menu_port || exit 0
     args+=(--port "${menu_port:-80}")
    fi
    if bash "$SELF" "${args[@]}";then echo '操作完成。';else echo '操作失败，详情见上方错误；可重新选择线路重试。';fi
    ;;
   3|4|5|6|7|8)
    if [[ ! -f /opt/feather-panel-native/.native-install || ! -x /usr/local/bin/featherpanel ]];then echo '请先安装原生面板。';continue;fi
    case "$choice" in 3) action=start;;4) action=stop;;5) action=restart;;6) action=status;;7) action=logs-recent;;8) action=key;;esac
    if /usr/local/bin/featherpanel "$action";then :;else echo '操作未完成，请检查上述服务信息。';fi
    ;;
   *) echo '请输入 0～9。';;
  esac
 done
fi
STAGE='环境与工具检查'
trap 'printf "\n失败步骤：%s。未完成安装，请按上述错误处理后重试。\n" "$STAGE" >&2' ERR
printf '\n[1/5] %s\n' "$STAGE"
if ! command -v curl >/dev/null || ! command -v python3 >/dev/null || [[ ! -s /etc/ssl/certs/ca-certificates.crt ]];then
 export DEBIAN_FRONTEND=noninteractive
 apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=25 -o Acquire::https::Timeout=25 -o APT::Update::Error-Mode=any update
 apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=25 -o Acquire::https::Timeout=25 install -y --no-install-recommends ca-certificates curl python3
fi
TEMP=$(mktemp -d /tmp/feather-online.XXXXXXXX)
trap 'rm -rf -- "$TEMP"' EXIT
STAGE='定位发布版本';printf '\n[2/5] %s\n' "$STAGE"
EXPECTED_SHA256=
if [[ $REPOSITORY == Babala524/- && $RELEASE_VERSION == latest && -n $BUNDLED_VERSION && $REFRESH == 0 ]];then
 RELEASE_VERSION=$BUNDLED_VERSION;EXPECTED_SHA256=$BUNDLED_SHA256
else
 if [[ $RELEASE_VERSION == latest ]];then META_URL="https://github.com/$REPOSITORY/releases/latest/download/release-info.json";
 else META_URL="https://github.com/$REPOSITORY/releases/download/$RELEASE_VERSION/release-info.json";fi
 fetch_file "$META_URL" "$TEMP/release.json" 60
 python3 - "$TEMP/release.json" "$RELEASE_VERSION" > "$TEMP/version" <<'PY'
import json,re,sys
info=json.load(open(sys.argv[1],encoding='utf-8'));tag=info.get('version','');digest=info.get('sha256','')
if not isinstance(tag,str) or not re.fullmatch(r'[A-Za-z0-9_.-]+',tag) or tag in {'.','..'}:raise SystemExit('发布版本信息无效')
if not isinstance(digest,str) or not re.fullmatch(r'[a-f0-9]{64}',digest):raise SystemExit('发布包摘要无效')
if sys.argv[2]!='latest' and sys.argv[2]!=tag:raise SystemExit('发布标签与版本信息不匹配')
print(tag);print(digest)
PY
 read -r RELEASE_VERSION < "$TEMP/version"
 EXPECTED_SHA256=$(sed -n '2p' "$TEMP/version")
fi
[[ $RELEASE_VERSION =~ ^[A-Za-z0-9_.-]+$ && $RELEASE_VERSION != . && $RELEASE_VERSION != .. && $EXPECTED_SHA256 =~ ^[a-f0-9]{64}$ ]] || die '发布包版本或摘要无效'
RELEASE="https://github.com/$REPOSITORY/releases/download/$RELEASE_VERSION"
printf '选定版本：%s\n' "$RELEASE_VERSION"
STAGE='下载完整部署包';printf '\n[3/5] %s\n' "$STAGE"
fetch_file "$RELEASE/FeatherPanel-native.tar.gz" "$TEMP/release.tar.gz"
STAGE='校验并解压部署包';printf '\n[4/5] %s\n' "$STAGE"
python3 - "$TEMP" "$EXPECTED_SHA256" <<'PY'
import hashlib,pathlib,re,sys,tarfile
root=pathlib.Path(sys.argv[1]);archive=root/'release.tar.gz'
digest=hashlib.sha256()
with archive.open('rb') as stream:
 for chunk in iter(lambda:stream.read(1024*1024),b''):digest.update(chunk)
if digest.hexdigest()!=sys.argv[2]:raise SystemExit('发布包 SHA-256 校验失败，未执行安装')
with tarfile.open(archive,'r:gz') as tar:
 members=tar.getmembers();seen=set();total=0
 if len(members)>50000:raise SystemExit('发布包文件数超出限制')
 for item in members:
  name=pathlib.PurePosixPath(item.name)
  if name.is_absolute() or '..' in name.parts or not name.parts or name.parts[0]!='FeatherPanel' or '\\' in item.name or item.name in seen or not (item.isfile() or item.isdir()):raise SystemExit('发布包包含不允许的路径或文件')
  seen.add(item.name);total+=item.size
  if total>2*1024**3:raise SystemExit('发布包解压大小超出限制')
 if 'FeatherPanel/install.sh' not in seen:raise SystemExit('发布包缺少安装入口')
 tar.extractall(root/'source',members=members)
print('发布包校验通过')
PY
STAGE='安装并启动服务';printf '\n[5/5] %s · %s\n' "$STAGE" "$RELEASE_VERSION"
FEATHER_RELEASE_VERSION="$RELEASE_VERSION" bash "$TEMP/source/FeatherPanel/install.sh" "${INSTALL_ARGS[@]}"
