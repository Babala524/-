#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
[[ $EUID == 0 && $# == 1 ]] || exit 1
case "$1" in python|map|game) group=$1;;*) exit 1;;esac
exec 9>/run/lock/feather-panel-dependencies.lock
flock -w 1100 9 || { echo '其他依赖安装仍在进行，请稍后重试' >&2;exit 1; }
. /etc/os-release
case "$ID:$VERSION_ID" in ubuntu:22.04|ubuntu:24.04|debian:12|debian:13) ;;*) exit 1;;esac
packages=()
case "$group" in
 python) packages=(python3);;
 map) packages=(python3 python3-pil fonts-noto-cjk);;
 game)
  packages=(screen lib32gcc-s1 lib32stdc++6 libcurl4:amd64)
  case "$ID:$VERSION_ID" in
   ubuntu:24.04|debian:13) packages=(screen lib32gcc-s1 lib32stdc++6 libcurl4t64:amd64 libcurl4t64:i386 libcurl3t64-gnutls:amd64 libcurl3t64-gnutls:i386);;
   *) packages+=(libcurl4:i386 libcurl3-gnutls:amd64 libcurl3-gnutls:i386);;
  esac;;
esac
missing=()
for package in "${packages[@]}";do
 [[ $(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true) == 'install ok installed' ]] || missing+=("$package")
done
if ((${#missing[@]}));then
 if [[ $group == game ]] && ! dpkg --print-foreign-architectures | grep -qx i386;then dpkg --add-architecture i386;fi
 options=(-o Acquire::Retries=2 -o Acquire::http::Timeout=25 -o Acquire::https::Timeout=25 -o DPkg::Lock::Timeout=120)
 apt-get "${options[@]}" -o APT::Update::Error-Mode=any update
 apt-get "${options[@]}" install -y --no-install-recommends "${missing[@]}"
else echo '运行依赖已齐全，直接复用';fi
case "$group" in python) /usr/bin/python3 -c 'import zipfile';;map) /usr/bin/python3 -c 'from PIL import Image';;game) screen --version >/dev/null;;esac
