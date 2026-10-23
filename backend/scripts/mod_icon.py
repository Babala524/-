"""Render fixed, conventional mod icon filenames; never evaluate mod Lua."""
import pathlib
import sys
import struct
from PIL import Image
from render_map import read_tex

Image.MAX_IMAGE_PIXELS = 4194304
folder, output = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
for name in ('modicon.png', 'icon.png', 'modicon.tex', 'icon.tex'):
    source = folder / name
    if not source.is_file() or source.is_symlink() or source.stat().st_size > 8388608:
        continue
    try:
        if source.suffix == '.tex':
            header=source.read_bytes()[:18]
            if len(header)<18: continue
            width,height=struct.unpack_from('<HH',header,8)
            if width*height>4194304: continue
        image = read_tex(source) if source.suffix == '.tex' else Image.open(source).convert('RGBA')
        image.thumbnail((256, 256))
        output.parent.mkdir(parents=True, exist_ok=True)
        image.save(output, 'PNG')
        break
    except Exception:
        continue
