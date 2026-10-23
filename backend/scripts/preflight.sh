#!/bin/sh
# Read-only inventory; never starts/stops containers or alters installed services.
set -eu
printf '\nSystem\n'
uname -a
if [ -f /etc/os-release ]; then cat /etc/os-release; fi
printf '\nResources\n'
free -h
df -h /
printf '\nListening ports\n'
ss -lntup
printf '\nDocker\n'
if command -v docker >/dev/null 2>&1; then
  docker version --format '{{.Server.Version}}' || true
  docker compose version || true
  docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
else
  printf 'Docker is not installed\n'
fi
printf '\nCandidate panel TCP port 80 and game UDP ports 11001-11008 must be checked against the inventory above.\n'
