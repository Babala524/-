#!/usr/bin/env python3
"""Build the native installation assets from a clean source checkout."""
import hashlib
import argparse
import json
import pathlib
import re
import tarfile
import urllib.request

source=pathlib.Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument('--version',required=True,help='GitHub release tag, e.g. v2026.10.23.1')
version=parser.parse_args().version
if not re.fullmatch(r'[A-Za-z0-9_.-]+',version) or version in {'.','..'}:raise SystemExit('Invalid release tag')
output=source/'dist'
output.mkdir(exist_ok=True)
node_version='24.22.1'
node_sha='6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6'
runtime=source/'runtime'/f'node-v{node_version}-linux-x64.tar.xz'
runtime.parent.mkdir(exist_ok=True)
if not runtime.exists():
 print('Fetching official Node runtime for the release package...',flush=True)
 temp=runtime.with_suffix('.part')
 try:
  with urllib.request.urlopen(f'https://nodejs.org/dist/v{node_version}/{runtime.name}',timeout=60) as response,temp.open('wb') as stream:
   while chunk:=response.read(1048576):stream.write(chunk)
  if hashlib.sha256(temp.read_bytes()).hexdigest()!=node_sha:raise SystemExit('Node runtime checksum mismatch')
  temp.replace(runtime)
 finally:temp.unlink(missing_ok=True)
if hashlib.sha256(runtime.read_bytes()).hexdigest()!=node_sha:raise SystemExit('Node runtime checksum mismatch')
roots=['backend','vendor','licenses','assets','deploy','docs','scripts','.github',
       'index.html','backend-client.js','wallpaper.mp4','install.sh','install-online.sh',
       'README.md','THIRD_PARTY_NOTICES.md','Dockerfile','compose.yaml','.env.example',
       '.dockerignore','.gitignore','.gitattributes','backend-contract.md']
denied={'__pycache__','node_modules','.git','data','.env'}
files=[runtime]
for name in roots:
 target=source/name
 for item in sorted(target.rglob('*')) if target.is_dir() else [target]:
  if not item.is_file() or item.is_symlink():continue
  relative=item.relative_to(source)
  if any(part in denied for part in relative.parts) or item.suffix.lower() in {'.pem','.key','.pyc','.pfx','.p12','.log'}:continue
  files.append(item)
for required in ['install.sh','install-online.sh','backend/src/server.mjs','assets/wallpaper-mobile.mp4']:
 if source/required not in files:raise SystemExit('Missing release file: '+required)
archive=output/'FeatherPanel-native.tar.gz'
with tarfile.open(archive,'w:gz') as tar:
 for item in sorted(files):
  relative=item.relative_to(source)
  info=tar.gettarinfo(str(item),arcname='FeatherPanel/'+relative.as_posix())
  info.uid=info.gid=0;info.uname=info.gname='root'
  info.mode=0o755 if relative.as_posix() in {'install.sh','install-online.sh','deploy/featherpanel','deploy/feather-python'} else 0o644
  with item.open('rb') as stream:tar.addfile(info,stream)
digest=hashlib.sha256()
with archive.open('rb') as stream:
 for chunk in iter(lambda:stream.read(1024*1024),b''):digest.update(chunk)
checksum=digest.hexdigest()
(output/'FeatherPanel-native.tar.gz.sha256').write_text(checksum+'  FeatherPanel-native.tar.gz\n',encoding='ascii')
(output/'release-info.json').write_text(json.dumps({'version':version,'sha256':checksum},indent=2)+'\n',encoding='ascii')
script=(source/'install-online.sh').read_text(encoding='utf-8')
script=script.replace('BUNDLED_VERSION=\n','BUNDLED_VERSION='+version+'\n',1).replace('BUNDLED_SHA256=\n','BUNDLED_SHA256='+checksum+'\n',1)
(output/'install-online.sh').write_text(script,encoding='utf-8',newline='\n')
print(f'{len(files)} files; {archive.stat().st_size} bytes; SHA-256 {digest.hexdigest()}')
