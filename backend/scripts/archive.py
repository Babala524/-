"""Inspect and extract untrusted room archives without executing their contents."""
import configparser
import json
import os
import pathlib
import re
import shutil
import stat
import sys
import tarfile
import zipfile

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

def extract(archive, destination, byte_limit, validate_room=True):
    destination = pathlib.Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    files, seen, total = [], set(), 0
    def record(name, size, directory, source, mode=0):
        nonlocal total
        if not validate_room: name = name.replace('\\', '/')
        if '\\' in name or '\x00' in name or re.match(r'^[A-Za-z]:', name):
            raise ValueError('存档含不安全的路径')
        clean = pathlib.PurePosixPath(name)
        if clean.is_absolute() or '..' in clean.parts:
            raise ValueError('存档路径超出目录')
        parts = [part for part in clean.parts if part != '.']
        if not parts: return
        key = '/'.join(parts).casefold()
        if key in seen: raise ValueError('存档存在重复路径')
        seen.add(key)
        if len(seen) > 20000: raise ValueError('存档文件数量过多')
        if stat.S_ISLNK(mode) or (mode and stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
            raise ValueError('不支持存档中的链接或设备文件')
        total += size
        if total > byte_limit: raise ValueError('存档解压体积超出限制')
        target = destination.joinpath(*parts)
        if not target.is_relative_to(destination): raise ValueError('非法存档路径')
        files.append((target, directory, size, source))

    is_zip = zipfile.is_zipfile(archive)
    reader = zipfile.ZipFile(archive) if is_zip else tarfile.open(archive, mode='r:gz')
    try:
        if is_zip:
            for item in reader.infolist():
                if item.flag_bits & 1: raise ValueError('不支持加密存档')
                record(item.filename, item.file_size, item.is_dir(), item, item.external_attr >> 16)
        else:
            for item in reader:
                if not (item.isfile() or item.isdir()): raise ValueError('存档含链接或特殊文件')
                record(item.name, item.size, item.isdir(), item)
        used = 0
        for target, directory, declared, source in files:
            if directory:
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            stream = reader.open(source) if is_zip else reader.extractfile(source)
            copied = 0
            with stream, target.open('xb') as output:
                while True:
                    chunk = stream.read(1024 * 1024)
                    if not chunk: break
                    copied += len(chunk); used += len(chunk)
                    if used > byte_limit or copied > declared: raise ValueError('解压文件大小不合法')
                    output.write(chunk)
            if copied != declared: raise ValueError('存档文件不完整')
            os.chmod(target, 0o600)
    finally:
        reader.close()
    if not validate_room:
        # Accept a ZIP containing one enclosing workshop-ID directory as well.
        if not (destination/'modinfo.lua').is_file():
            entries = [entry for entry in destination.iterdir() if entry.name != '__MACOSX']
            while len(entries) == 1 and entries[0].is_dir():
                folder = entries[0]
                for entry in folder.iterdir(): shutil.move(str(entry), str(destination/entry.name))
                folder.rmdir()
                if (destination/'modinfo.lua').is_file(): break
                entries = [entry for entry in destination.iterdir() if entry.name != '__MACOSX']
        if not (destination/'modinfo.lua').is_file(): raise ValueError('模组包缺少根目录 modinfo.lua；一次只上传一个完整模组')
        print(json.dumps({'bytes':total,'files':len(files)}))
        return
    clusters = list(destination.rglob('cluster.ini'))
    if len(clusters) != 1: raise ValueError('请上传包含唯一 cluster.ini 的完整房间存档包')
    cluster = clusters[0].parent
    config = configparser.ConfigParser(interpolation=None)
    config.read(clusters[0], encoding='utf-8-sig')
    if not config.has_section('NETWORK'): raise ValueError('cluster.ini 缺少 NETWORK 配置')
    worlds = [entry for entry in cluster.iterdir() if entry.is_dir() and (entry/'server.ini').is_file()]
    if not worlds or len(worlds) > 8: raise ValueError('未找到有效的世界 server.ini')
    if not any((entry/'save').is_dir() and any((entry/'save').rglob('*')) for entry in worlds):
        raise ValueError('存档包缺少世界保存数据')
    print(json.dumps({'cluster':str(cluster),'worlds':[world.name for world in worlds],'bytes':total},ensure_ascii=False))

def main():
    if len(sys.argv) == 5 and sys.argv[1] == 'mod-pack':
        folder, output, limit = pathlib.Path(sys.argv[2]).resolve(), sys.argv[3], int(sys.argv[4])
        total, count = 0, 0
        with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
            for entry in sorted(folder.rglob('*')):
                if entry.is_symlink(): raise ValueError('模组包含链接')
                if not entry.is_file(): continue
                total += entry.stat().st_size; count += 1
                if total > limit or count > 20000: raise ValueError('模组体积或文件数量超过限制')
                name = entry.relative_to(folder).as_posix()
                item = zipfile.ZipInfo(name, date_time=(2026,1,1,0,0,0))
                item.compress_type = zipfile.ZIP_DEFLATED
                item.external_attr = 0o100600 << 16
                with entry.open('rb') as source, archive.open(item, 'w', force_zip64=True) as target:
                    shutil.copyfileobj(source, target, 1024*1024)
        return
    if len(sys.argv) != 5 or sys.argv[1] not in ('extract','mod-extract'): raise ValueError('参数不合法')
    extract(sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[1]=='extract')

if __name__ == '__main__':
    try: main()
    except Exception as error:
        print(str(error),file=sys.stderr)
        sys.exit(1)
