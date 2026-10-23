"""Small original test textures, never copied from the game's assets."""
import struct,sys,zipfile
from pathlib import Path
root=Path(sys.argv[1])/'data'
def tex(name,w,h,pixels):
    file=root/name;file.parent.mkdir(parents=True,exist_ok=True)
    file.write_bytes(b'KTEX'+struct.pack('<I', (5<<4)|(1<<13))+struct.pack('<HHHI',w,h,w*4,len(pixels))+bytes(pixels))
def xml(name,texture,elements):
    file=root/name;file.parent.mkdir(parents=True,exist_ok=True)
    file.write_text('<Atlas><Texture filename="'+texture+'"/><Elements>'+elements+'</Elements></Atlas>')
(root/'databundles').mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(root/'databundles/scripts.zip','w') as z:
    z.writestr('scripts/tiledefs.lua','\n'.join('TileManager.AddTile("'+name+'",TileRanges.LAND,{}, {noise_texture="unused"}, {noise_texture="'+texture+'"})' for name,texture in [('FOREST','forest'),('GRASS','grass'),('DECIDUOUS','forest')]))
for name,c in [('forest',(35,90,45)),('grass',(150,180,60)),('mini_cobblestone_noise',(110,100,80))]:
    tex('levels/textures/'+name+'.tex',16,16,[v for y in range(16) for x in range(16) for v in tuple(min(255,n+(40 if x%4<2 else 0)) for n in c)+(255,)])
tex('levels/tiles/map_edge.tex',4,4,[255,255,255,128]*16)
xml('levels/tiles/map_edge.xml','map_edge.tex','<Element name="02" u1="0" u2="1" v1="0" v2="1"/>')
tex('minimap/test.tex',4,4,[255,20,20,255]*16)
xml('minimap/minimap_data1.xml','test.tex',''.join('<Element name="'+n+'.png" u1="0" u2="1" v1="0" v2="1"/>' for n in ['igloo','wasphive']))
