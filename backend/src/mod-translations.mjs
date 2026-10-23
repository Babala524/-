import fs from 'node:fs';
// Display text only. Workshop option identifiers, defaults and values stay unchanged.
const glossary=new Map(Object.entries({
 'enabled':'开启','enable':'开启','disabled':'关闭','disable':'关闭','on':'开启','off':'关闭',
 'true':'是','false':'否','yes':'是','no':'否','default':'默认','normal':'正常','none':'无',
 'always':'始终','never':'从不','show':'显示','hide':'隐藏','very low':'极低','low':'低','high':'高','very high':'极高',
 'random':'随机','reduce':'降低','unlimited':'无限','language':'语言','english':'英语','chinese':'中文',
 'player indicators':'玩家方向指示','player icons':'玩家地图图标','show fires':'显示火源指示','fire icons':'火源地图图标',
 'share map':'共享地图探索','wilderness override':'覆盖荒野模式设置','pings':'地图标记','scoreboard':'查看玩家列表时','charcoal':'使用木炭标记',
 'travel cost':'传送消耗','ownership restriction?':'限制使用他人的传送点',
 'ignoring admin':'管理员不受限制','allow restart':'允许重生换角色','allow resurrect':'允许复活','allow kill':'允许自杀',
 'restart interval (min)':'重生冷却（分钟）','resurrect interval (min)':'复活冷却（分钟）','kill interval (min)':'自杀冷却（分钟）',
 'interval bonus':'每次使用增加冷却','max interval (min)':'最大冷却（分钟）','force drop all':'重生时掉落物品','force drop':'强制掉落',
 "don't force drop":'不强制掉落','map data':'保留地图探索','resurrect health':'复活后生命值','chat mode':'指令聊天方式',
 'say & whisper':'公开聊天和私聊','only say':'仅公开聊天','only whisper':'仅私聊','welcome tips':'首次进入显示提示','tips time':'提示持续时间',
 'the arrow things that show players past the edge of the screen.':'在屏幕边缘用箭头指示其他玩家的方向。',
 'the player icons on the map.':'在地图上显示玩家图标。',
 'show fires with indicators like players.\nthey will smoke when they are visible this way.':'像玩家一样指示火源方向。通过此方式显示时，火源会冒烟。',
 'show fires globally on the map (this will only work if fires are set to show).\nthey will smoke when they are visible this way.':'在整个地图显示火源图标，需要同时开启火源显示；通过此方式显示时火源会冒烟。',
 "share map exploration between players. this will only work if\n'player indicators' and 'player icons' are not both disabled.":'在玩家间共享地图探索。玩家方向指示与玩家地图图标不能同时关闭。',
 'if enabled, it will use the other options you set in wilderness mode.\notherwise, it will not show players, but all fires will smoke and be visible.':'开启后荒野模式也使用这里的其他设置；关闭时不显示玩家，但火源仍会冒烟并显示。',
 'whether to allow players to ping (alt+click) the map.':'允许玩家使用 Alt + 点击在地图上标记位置。',
 'admin can use this all the time.':'管理员可以随时使用，不受冷却限制。',
 'restart cooldown.':'重生换角色的冷却时间。','resurrect cooldown.':'复活的冷却时间。','kill cooldown.':'自杀的冷却时间。',
 'cooling time will increase per use?':'每次使用后是否增加冷却时间。',"max cooling time if 'interval bonus' works.":'开启冷却递增后允许的最大冷却时间。',
 'restart whether to force drop all.':'重生换角色时是否强制掉落全部物品。','restart whether to save the map data.':'重生换角色时是否保留地图探索数据。',
 'after resurrection you will get some health.':'复活后的生命值设置。','say or whisper to use commands.':'使用公开聊天或私聊执行指令。',
 'tell player first join the server how to use this mod.':'玩家首次进入服务器时显示模组使用提示。','how long the tips will last.':'提示显示的持续时间。'
}));
// Exact reviewed translations preserve full meaning. Unknown text stays intact.
const reviewed=new Map(Object.entries(JSON.parse(fs.readFileSync(new URL('./mod-locales-zh.json',import.meta.url),'utf8'))).map(([key,value])=>[key.trim().replace(/\r/g,'').toLowerCase(),value]));
reviewed.set('harder nightmare creatures','更强的梦魇生物');
export function translateModText(text) {
  text=String(text??'');const key=text.trim().replace(/\r/g,'').toLowerCase();
  if(reviewed.has(key))return reviewed.get(key);
  if(glossary.has(key))return glossary.get(key);
  // Native Chinese supplied by mods can include well-known English UI terms.
  if(/[\u3400-\u9fff]/.test(text))return text.replace(/\bInsight\b/g,'洞察').replace(/\bBoss\b/gi,'首领');
  return text;
}
export function translateModFields(fields) {
 return fields.map(field=>({...field,label:translateModText(field.label),hover:translateModText(field.hover),originalLabel:field.label,originalHover:field.hover,
   options:field.options.map(option=>({...option,description:translateModText(option.description),originalDescription:option.description}))}));
}
