#!/usr/bin/env bash
# Publish this script alongside FeatherPanel-native.tar.gz and its SHA-256 file.
set -Eeuo pipefail
umask 077
REPOSITORY=Babala524/-
RELEASE_VERSION=latest
INSTALL_ARGS=()
die(){ printf '错误：%s\n' "$*" >&2;exit 1; }
usage(){ printf '用法：sudo bash install-online.sh --repo 用户名/仓库 [--version 标签] [--port 80] [--check]\n'; }
while (($#));do
 case "$1" in
  --repo) (($#>=2)) || die '--repo 缺少仓库';REPOSITORY=$2;shift 2;;
  --version) (($#>=2)) || die '--version 缺少标签';RELEASE_VERSION=$2;shift 2;;
  --port) (($#>=2)) || die '--port 缺少端口';INSTALL_ARGS+=(--port "$2");shift 2;;
  --check) INSTALL_ARGS+=(--check);shift;;
  -h|--help) usage;exit 0;;
  *) die "未知参数：$1";;
 esac
done
[[ $REPOSITORY =~ ^[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+$ && $REPOSITORY != */. && $REPOSITORY != */.. ]] || die '请指定 --repo GitHub用户名/仓库名'
[[ $RELEASE_VERSION =~ ^[A-Za-z0-9_.-]+$ && $RELEASE_VERSION != . && $RELEASE_VERSION != .. ]] || die '版本标签格式不合法'
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || die '目前支持 x86_64 Linux'
[[ -f /etc/os-release ]] || die '无法识别系统'
. /etc/os-release
case "$ID:$VERSION_ID" in ubuntu:22.04|ubuntu:24.04|debian:12|debian:13) ;; *) die '目前支持 Ubuntu 22.04/24.04、Debian 12/13';; esac
((EUID==0)) || die '请使用 sudo bash install-online.sh'
if ! command -v curl >/dev/null || ! command -v python3 >/dev/null || [[ ! -s /etc/ssl/certs/ca-certificates.crt ]];then
 export DEBIAN_FRONTEND=noninteractive
 apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=25 -o Acquire::https::Timeout=25 -o APT::Update::Error-Mode=any update
 apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=25 -o Acquire::https::Timeout=25 install -y --no-install-recommends ca-certificates curl python3
fi
if [[ $RELEASE_VERSION == latest ]];then
 RELEASE="https://github.com/$REPOSITORY/releases/latest/download"
else
 RELEASE="https://github.com/$REPOSITORY/releases/download/$RELEASE_VERSION"
fi
TEMP=$(mktemp -d /tmp/feather-online.XXXXXXXX)
trap 'rm -rf -- "$TEMP"' EXIT
download(){ curl --fail --location --proto '=https' --proto-redir '=https' --retry 3 --retry-all-errors --connect-timeout 15 --max-time 900 --speed-time 30 --speed-limit 1024 "$1" -o "$2"; }
echo '下载 FeatherPanel 原生部署包……'
# Resolve latest once so the archive and checksum always come from the same release.
if [[ $RELEASE_VERSION == latest ]];then
 download "https://api.github.com/repos/$REPOSITORY/releases/latest" "$TEMP/release.json"
 RELEASE_VERSION=$(python3 - "$TEMP/release.json" <<'PY'
import json,re,sys
tag=json.load(open(sys.argv[1],encoding='utf-8')).get('tag_name','')
if not re.fullmatch(r'[A-Za-z0-9_.-]+',tag) or tag in {'.','..'}:raise SystemExit('GitHub 未返回有效发布标签')
print(tag)
PY
 )
 RELEASE="https://github.com/$REPOSITORY/releases/download/$RELEASE_VERSION"
fi
download "$RELEASE/FeatherPanel-native.tar.gz" "$TEMP/release.tar.gz"
download "$RELEASE/FeatherPanel-native.tar.gz.sha256" "$TEMP/checksum"
python3 - "$TEMP" <<'PY'
import hashlib,pathlib,re,sys,tarfile
root=pathlib.Path(sys.argv[1]);archive=root/'release.tar.gz'
checksum=(root/'checksum').read_text(encoding='ascii').strip()
match=re.fullmatch(r'([a-fA-F0-9]{64})\s+\*?FeatherPanel-native\.tar\.gz',checksum)
if not match:raise SystemExit('发布包校验文件格式不合法')
digest=hashlib.sha256()
with archive.open('rb') as stream:
 for chunk in iter(lambda:stream.read(1024*1024),b''):digest.update(chunk)
if digest.hexdigest()!=match[1].lower():raise SystemExit('发布包 SHA-256 校验失败，未执行安装')
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
printf '开始安装版本：%s\n' "$RELEASE_VERSION"
bash "$TEMP/source/FeatherPanel/install.sh" "${INSTALL_ARGS[@]}"
