"""Render DST saves with textures and icons from the installed game.

Game assets stay in the game's data directory; none are bundled with the panel.
Only static metadata is read. No Lua from saves, game files or mods is executed.
"""
import io
import json
import math
import re
import struct
import sys
import zipfile
from functools import lru_cache
from pathlib import Path
import xml.etree.ElementTree as ET

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageStat


def read_tex(filename):
    """Decode a Klei KTEX mip level using Pillow's native BC decoder."""
    data = Path(filename).read_bytes()
    if data[:4] != b'KTEX' or len(data) < 18:
        raise ValueError('Invalid KTEX texture')
    header, = struct.unpack_from('<I', data, 4)
    pixel_format, mips = (header >> 4) & 31, (header >> 13) & 31
    if not 1 <= mips <= 16:
        raise ValueError('Invalid KTEX mip count')
    width, height, pitch, size = struct.unpack_from('<HHHI', data, 8)
    if not 1 <= width <= 8192 or not 1 <= height <= 8192:
        raise ValueError('Invalid KTEX dimensions')
    offset = 8 + 10 * mips
    payload = data[offset:offset+size]
    if len(payload) != size:
        raise ValueError('Incomplete KTEX texture')
    if pixel_format in (0, 1, 2):
        fourcc = [b'DXT1', b'DXT3', b'DXT5'][pixel_format]
        dds = bytearray(128)
        dds[:4] = b'DDS '
        struct.pack_into('<7I', dds, 4, 124, 0x81007, height, width, size, 0, 0)
        struct.pack_into('<II4s', dds, 76, 32, 4, fourcc)
        struct.pack_into('<I', dds, 108, 0x1000)
        image = Image.open(io.BytesIO(dds + payload)).convert('RGBA')
    elif pixel_format in (4, 5):
        mode = 'RGB' if pixel_format == 4 else 'RGBA'
        image = Image.frombytes(mode, (width, height), payload).convert('RGBA')
    else:
        raise ValueError('Unsupported KTEX pixel format: '+str(pixel_format))
    return image.transpose(Image.Transpose.FLIP_TOP_BOTTOM)


def atlas_elements(filename):
    root = ET.parse(filename).getroot()
    return root.find('Texture').get('filename'), list(root.find('Elements'))


def atlas_crop(image, element):
    w, h = image.size
    return image.crop((round(float(element.get('u1'))*w), round((1-float(element.get('v2')))*h),
                       round(float(element.get('u2'))*w), round((1-float(element.get('v1')))*h)))


def game_text(root, name):
    loose = root/name
    if loose.is_file():
        return loose.read_text(encoding='utf-8')
    with zipfile.ZipFile(root/'databundles/scripts.zip') as bundle:
        return bundle.read(name).decode('utf-8')


def tile_definitions(root):
    definitions = {}
    text=game_text(root,'scripts/tiledefs.lua')
    for order,match in enumerate(re.finditer(r'TileManager\.AddTile\(\s*"([A-Z0-9_]+)"([\s\S]*?)(?=\nTileManager\.AddTile\(|\Z)', text)):
        name, body = match.groups()
        # Each AddTile has a ground table followed by its minimap table.
        textures = re.findall(r'noise_texture\s*=\s*"([\w/._]+)"', body)
        if len(textures) < 2:
            continue
        definitions[name] = {'texture': textures[1], 'order': order, 'ocean': 'TileRanges.OCEAN' in body}
    return definitions


NEIGHBORS = [(-1,-1),(0,-1),(1,-1),(-1,0),(1,0),(-1,1),(0,1),(1,1)]
ALIASES = {'killerbeehive':'wasphive', 'walrus_camp':'igloo',
           'evergreen_sparse':'evergreen_lumpy', 'deciduoustree':'deciduous_tree',
           'rock1':'rock', 'rock2':'rock_gold', 'rock_flintless':'rock',
           'sinkhole':'cave_open', 'cave_entrance':'cave_closed', 'cave_entrance_open':'cave_open',
           'resurrectionstone':'resurrection_stone', 'ruins_statue_head':'statue_ruins',
           'ruins_statue_mage':'statue_ruins', 'rabbithole':'rabbit_hole',
           'multiplayer_portal':'portal', 'multiplayer_portal_moonrock':'portal_moonrock',
           'mushtree_tall':'mushroom_tree', 'mushtree_medium':'mushroom_tree_med',
           'mushtree_small':'mushroom_tree_small', 'mushtree_moon':'mushroom_tree_moon',
           'pond':'pond', 'pond_mos':'pond_mos', 'pond_cave':'pond_cave'}


class Assets:
    def __init__(self, root, manifest=None):
        self.root = Path(root)
        manifest=manifest or {}
        self.manifest=manifest
        self.allowed=[self.root]+[self.root.parent/'mods'/('workshop-'+mod) for mod in manifest.get('mods',[]) if re.fullmatch(r'\d{6,20}',mod)]
        self.defs = tile_definitions(self.root)
        self.warnings=list(manifest.get('warnings',[]))
        for item in manifest.get('terrains',[]):
            self.defs[item['name']]={**item,'order':item.get('order',self.defs.get(item['name'],{}).get('order',len(self.defs)))}
        for item in manifest.get('overrides',[]):
            definition=self.defs.get(item['name'])
            if definition is None:
                continue
            definition['mod']=item['mod']
            prop={'noise_texture':'texture','name':'edge','texture_name':'edge','atlas':'atlas'}.get(item['property'])
            if prop:
                definition[prop]=item['file']
        for item in manifest.get('orders',[]):
            definition,target=self.defs.get(item['name']),self.defs.get(item['target'])
            if definition and target and not definition.get('runtime'):
                definition['order']=target['order']+(.01 if item.get('after') else -.01)
        self.elements = {}
        self.aliases=dict(manifest.get('aliases',{}))
        atlases=[*sorted((self.root/'minimap').glob('minimap_data*.xml')),*manifest.get('atlases',[])]
        for filename in atlases:
            try:
                xml=self.safe_file(filename)
                texture, elements = atlas_elements(xml)
            except (OSError,ET.ParseError,AttributeError,ValueError) as error:
                self.warn('地图图集无法读取：'+Path(filename).name)
                continue
            if not texture: continue
            try:
                texture_path=self.safe_file(xml.parent/texture)
            except (OSError,ValueError):
                self.warn('地图图集缺少材质：'+xml.name)
                continue
            for el in elements:
                if el.get('name'):
                    self.elements[el.get('name').removesuffix('.tex').removesuffix('.png')] = (texture_path, el)

    def warn(self,message):
        if message not in self.warnings and len(self.warnings)<24:
            self.warnings.append(message)

    def safe_file(self,filename):
        file=Path(filename).absolute()
        if not any(file.is_relative_to(base.absolute()) for base in self.allowed):
            raise ValueError('Map resource outside enabled mods and game data')
        # A symlink at any level must not escape its permitted resource tree.
        if not any(file.resolve().is_relative_to(base.resolve()) for base in self.allowed):
            raise ValueError('Map resource symlink outside permitted directories')
        if not file.is_file() or file.stat().st_size>64*1048576:
            raise ValueError('Map resource missing or too large')
        return file

    @lru_cache(maxsize=40)
    def texture(self, name):
        if not isinstance(name,str):
            raise FileNotFoundError('Unresolved map texture')
        if Path(name).is_absolute():
            return read_tex(self.safe_file(name))
        if not re.fullmatch(r'[\w.-]+', name):
            raise ValueError('Invalid game texture name')
        return read_tex(self.safe_file(self.root/'levels/textures'/(name if name.endswith('.tex') else name+'.tex')))

    @lru_cache(maxsize=3)
    def icon_atlas(self, filename):
        return read_tex(self.safe_file(filename))

    @lru_cache(maxsize=600)
    def icon(self, prefab, size, stage=0, burnt=False, stump=False):
        name = self.aliases.get(prefab,ALIASES.get(prefab,prefab)).removesuffix('.png').removesuffix('.tex')
        if prefab in ('evergreen','evergreen_sparse'):
            # These exact variants are present in the game's icon atlas.
            candidates = [name+('_stump' if stump else '_burnt' if burnt else ''), name]
        else:
            candidates = [name, prefab]
        for candidate in candidates:
            item = self.elements.get(candidate)
            if item:
                atlas, element = item
                try:
                    image = atlas_crop(self.icon_atlas(atlas), element)
                except (OSError,ValueError,struct.error):
                    self.warn('地图图标无法读取：'+candidate)
                    continue
                image.thumbnail((size,size), Image.Resampling.LANCZOS)
                return image
        return None

    @lru_cache(maxsize=16)
    def edges(self,scale,texture_file=None,atlas_file=None):
        return edge_masks(self,scale,texture_file,atlas_file)


def edge_masks(assets, scale, texture_file=None, atlas_file=None):
    """Match the game's 48 edge sprites to the surrounding terrain cells.

    Interiors use the full sprite. Boundary cells use the original hand drawn
    alpha silhouettes, so shores and biome borders do not follow square pixels.
    """
    root=assets.root
    image=read_tex(assets.safe_file(texture_file or root/'levels/tiles/map_edge.tex'))
    _, elements=atlas_elements(assets.safe_file(atlas_file or root/'levels/tiles/map_edge.xml'))
    shapes=[atlas_crop(image,e).getchannel('A') for e in elements if e.get('name')!='01']
    if not shapes or len(shapes)>256:
        raise ValueError('Invalid map edge atlas')
    small=[list(mask.resize((12,12),Image.Resampling.BOX).getdata()) for mask in shapes]
    # The target is binary: a pixel is white if ANY neighboring cell reaches
    # it. Precompute those eight coverages instead of repeating distances for
    # every combination. Squared distance to a binary target differs between
    # shapes by sum(a*a) - 510*sum(a for white pixels); the constant cancels.
    coverage=[]
    for y in range(12):
        for x in range(12):
            px,py=(x+.5)/12,(y+.5)/12
            coverage.append(sum(1<<i for i,(dx,dy) in enumerate(NEIGHBORS)
                                if math.hypot(max(dx-px,0,px-dx-1),max(dy-py,0,py-dy-1))<.24))
    squares=[sum(a*a for a in values) for values in small]
    resized={}
    lookup={0:Image.new('L',(scale,scale),0)}
    for bits in range(1,256):
        white=[i for i,neighbors in enumerate(coverage) if neighbors & bits]
        winner=min(range(len(shapes)),key=lambda n:squares[n]-510*sum(small[n][i] for i in white))
        if winner not in resized:
            resized[winner]=shapes[winner].resize((scale,scale),Image.Resampling.LANCZOS)
        lookup[bits]=resized[winner]
    return lookup


def repeat_texture(texture, size, period, origin=(0,0), tint=None):
    tile=texture.convert('RGB').resize((period,period),Image.Resampling.LANCZOS)
    if tint:
        tile=ImageChops.multiply(tile,Image.new('RGB',tile.size,tint))
    out=Image.new('RGB',size)
    for y in range(-origin[1]%period-period,size[1],period):
        for x in range(-origin[0]%period-period,size[0],period):
            out.paste(tile,(x,y))
    return out


def smooth_path(points):
    if len(points)<3:
        return points
    result=[]
    extended=[points[0]]+points+[points[-1]]
    for i in range(1,len(extended)-2):
        a,b,c,d=extended[i-1:i+3]
        for j in range(8):
            t=j/8
            result.append(tuple(.5*((2*b[k])+(-a[k]+c[k])*t+(2*a[k]-5*b[k]+4*c[k]-d[k])*t*t+(-a[k]+3*b[k]-3*c[k]+d[k])*t*t*t) for k in (0,1)))
    return result+[points[-1]]


def render(data, assets):
    width,height=data['width'],data['height']
    if not isinstance(width,int) or not isinstance(height,int) or not 1<=width<=2048 or not 1<=height<=2048:
        raise ValueError('Invalid map size')
    tiles=data['tiles']
    if len(tiles)!=width*height:
        raise ValueError('Incomplete map data')
    scale_limit=data.get('scaleLimit',8)
    if not isinstance(scale_limit,int):
        scale_limit=8
    scale=max(1,min(8,max(1,scale_limit),4096//max(width,height)))
    size=(width*scale,height*scale)
    # Save tile rows run from negative to positive Z. Flip the terrain, then use
    # the same north-up world transform for roads, structures and target icons.
    tiles=[tiles[(height-1-y)*width+x] for y in range(height) for x in range(width)]
    names={int(k):v for k,v in data['names'].items()}
    positions={}
    for i,tile in enumerate(tiles):
        positions.setdefault(tile,[]).append(i)
    masks=assets.edges(scale)
    cave=not any(name.startswith('OCEAN') and len(positions.get(tile,[]))>100 for tile,name in names.items())
    result=Image.new('RGB',size,'#25231f' if cave else '#b9ad8d')
    missing=[];legend=[]
    ordered=sorted(positions,key=lambda t:assets.defs.get(names.get(t,''),{}).get('order',-1))
    for tile in ordered:
        name=names.get(tile,'')
        definition=assets.defs.get(name)
        if not definition:
            if tile != 0 and name not in ('IMPASSABLE','UNDERGROUND','INVALID','FAKE_GROUND'):
                missing.append(name or str(tile))
            continue
        try:
            # ocean_noise is a packed shader input, not a displayable RGB map.
            # Use the game's hand drawn water minimap texture for this layer.
            ocean_shader=definition['ocean'] and (not definition.get('mod') or Path(definition.get('texture') or '').stem=='ocean_noise')
            texture=assets.texture('mini_water_shallow' if ocean_shader else definition['texture'])
        except (FileNotFoundError,ValueError,OSError,struct.error):
            missing.append(name)
            continue
        layer_masks=masks
        if definition.get('edge') or definition.get('atlas'):
            try:
                layer_masks=assets.edges(scale,definition.get('edge'),definition.get('atlas'))
            except (OSError,ValueError,ET.ParseError,struct.error,AttributeError):
                assets.warn('地形 '+name+' 的自定义边缘无法读取，使用原版边缘')
        cells=positions[tile]
        left=max(0,min(i%width for i in cells)-1)*scale
        top=max(0,min(i//width for i in cells)-1)*scale
        right=min(width,max(i%width for i in cells)+2)*scale
        bottom=min(height,max(i//width for i in cells)+2)*scale
        region=(right-left,bottom-top)
        mask=Image.new('L',region,0);draw=ImageDraw.Draw(mask)
        boundary={}
        for index in positions[tile]:
            x,y=index%width,index//width
            draw.rectangle((x*scale-left,y*scale-top,(x+1)*scale-left-1,(y+1)*scale-top-1),fill=255)
            for dx,dy in NEIGHBORS:
                nx,ny=x+dx,y+dy
                if 0<=nx<width and 0<=ny<height and tiles[ny*width+nx]!=tile:
                    boundary[ny*width+nx]=True
        for index in boundary:
            x,y=index%width,index//width;bits=0
            for bit,(dx,dy) in enumerate(NEIGHBORS):
                nx,ny=x+dx,y+dy
                if 0<=nx<width and 0<=ny<height and tiles[ny*width+nx]==tile:
                    bits|=1<<bit
            mask.paste(layer_masks[bits],(x*scale-left,y*scale-top))
        bounds=mask.getbbox()
        if not bounds:
            continue
        # map_edge's parchment colour multiplies the noise in minimap.ksh.
        tint='#e3be74'
        if definition['ocean']:
            tint={'OCEAN_COASTAL_SHORE':'#d0e4d5','OCEAN_COASTAL':'#b2d4d1','OCEAN_SWELL':'#86abbc','OCEAN_ROUGH':'#657f9c','OCEAN_HAZARDOUS':'#4d6078','OCEAN_BRINEPOOL':'#b2cf94'}.get(name,'#b2d4d1')
        patterned=repeat_texture(texture,region,scale*16,(left,top),tint)
        result.paste(patterned,(left,top),mask)
        rgb=tuple(round(v) for v in ImageStat.Stat(patterned.resize((1,1))).mean)
        legend.append({'name':name,'color':'#%02x%02x%02x'%rgb})
    def project(x,z):
        return ((width/2+x/4)*scale,(height/2-z/4)*scale)
    roadmask=Image.new('L',size,0);draw=ImageDraw.Draw(roadmask);roadcount=0
    for road in data.get('roads',[]):
        if not isinstance(road,list):
            continue
        points=[project(*p[:2]) for p in road[1:] if isinstance(p,list) and len(p)>=2 and all(isinstance(v,(int,float)) and math.isfinite(v) and abs(v)<100000 for v in p[:2])]
        if len(points)>1:
            draw.line(smooth_path(points),fill=210,width=max(2,round(scale*.5)),joint='curve');roadcount+=1
    if roadcount:
        roadtexture=repeat_texture(assets.texture('mini_cobblestone_noise'),size,scale*8,tint='#927653')
        result.paste(roadtexture,(0,0),roadmask)
    iconcount=0
    # Common vegetation stays smaller than structures; targets are drawn last.
    entity_limit=data.get('entityLimit',50000)
    if not isinstance(entity_limit,int):
        entity_limit=50000
    entities=data.get('entities',[])[:50000]
    targets={'walrus_camp','wasphive','killerbeehive'}
    limit=max(0,min(50000,entity_limit))
    entities=([e for e in entities if e.get('prefab') in targets]+[e for e in entities if e.get('prefab') not in targets])[:limit]
    vegetation=lambda p:any(part in p for part in ('tree','evergreen','grass','sapling','berrybush','flower','rock','boulder','flint'))
    entities=sorted(entities,key=lambda e:(2 if e.get('prefab') in targets else 0 if vegetation(e.get('prefab','')) else 1, -e.get('z',0)))
    if not entities:
        entities=[{'prefab':'walrus_camp' if m.get('kind')=='海象营地' else 'wasphive',**m} for m in data.get('markers',[])]
    # Paste with the icon's alpha channel directly, avoiding a second full-size
    # RGBA map allocation on small servers.
    for entity in entities:
        x,z=entity.get('x'),entity.get('z');prefab=entity.get('prefab','')
        if not isinstance(x,(int,float)) or not isinstance(z,(int,float)) or not math.isfinite(x) or not math.isfinite(z):
            continue
        px,py=project(x,z)
        if not (0<=px<size[0] and 0<=py<size[1]):
            continue
        icon_size=round(scale*(4.5 if prefab in targets else 1.9 if vegetation(prefab) else 3))
        icon=assets.icon(prefab,icon_size,entity.get('stage') or 0,entity.get('burnt',False),entity.get('stump',False))
        if icon is not None:
            result.paste(icon,(round(px-icon.width/2),round(py-icon.height/2)),icon);iconcount+=1
    return result.convert('RGB'),{'renderer':'klei-textures-v1','imageWidth':size[0],'imageHeight':size[1],
             'iconCount':iconcount,'roadCount':roadcount,'missingTerrains':missing,'legend':legend,
             'modAssets':{'mods':assets.manifest.get('mods',[]),'runtimeResolved':assets.manifest.get('runtimeResolved',False),'terrainDefinitions':len(assets.manifest.get('terrains',[])),
                          'atlasCount':len(assets.manifest.get('atlases',[])),'warnings':assets.warnings}}


def main():
    if sys.platform == 'linux':
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (512*1048576, 512*1048576))
    if len(sys.argv)!=4:
        raise ValueError('Expected game data directory, input JSON and output PNG')
    root,input_file,output_file=map(Path,sys.argv[1:])
    if input_file.stat().st_size>32*1048576:
        raise ValueError('Map input exceeds the size limit')
    data=json.loads(input_file.read_text(encoding='utf-8'))
    image,meta=render(data,Assets(root,data.get('modAssets')))
    if output_file.suffix.lower()=='.webp':
        image.save(output_file,'WEBP',quality=78,method=4)
    else:
        image.save(output_file,'PNG',compress_level=4)
    print(json.dumps(meta,ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error),file=sys.stderr)
        raise SystemExit(1)
