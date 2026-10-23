/* Panel descriptions for Island Adventures / Hamlet world overrides.
 * Values come from their customization tables. Unknown fields stay editable
 * as literal values; never invent option lists or execute uploaded Lua. */
(function(root) {
  'use strict';
  const profiles = {forest:'森林',cave:'洞穴',caves:'洞穴',shipwrecked:'海难',porkland:'猪镇',volcanoworld:'火山'};
  const labels = {
    mild:'温和季',hurricane:'飓风季',monsoon:'雨季',dry:'旱季',temperate:'温和季',humid:'潮湿季',lush:'繁茂季',
    shipwrecked_season_start:'海难起始季节',porkland_season_start:'猪镇起始季节',
    volcano:'独立火山世界',volcanoisland:'火山岛',bermudatriangle:'百慕大三角',
    sweet_potato:'甘薯',limpets:'帽贝',mussel_farm:'贻贝养殖场',seaweed:'海带',seashell:'贝壳',bamboo:'竹子',bush_vine:'藤蔓灌木',
    coral:'珊瑚',coral_brain_rock:'智慧树',crate:'木箱',tidalpool:'潮池',sandhill:'沙堆',poisonhole:'毒坑',bioluminescence:'生物荧光',
    magma_rocks:'岩浆矿',shipwrecked_trees:'海难树木',shipwreck:'沉船',waterygrave:'水墓',coffeebush:'咖啡丛',elephantcactus:'象仙人掌',
    rock_obsidian:'黑曜石矿',rock_charcoal:'木炭矿',volcano_shrub:'火山灌木',tar_pool:'焦油池',
    crabhole:'蟹洞',ox:'水牛',doydoy:'渡渡鸟',wildbores:'野猪屋',ballphin:'海豚宫殿',primeape:'猿猴小屋',fishermerm:'渔人小屋',
    lobster:'龙虾',solofish:'狗鱼',jellyfish:'水母',rainbowjellyfish:'彩虹水母',fishinhole:'鱼群',seagull:'海鸥',
    flup:'弹涂鱼',swordfish:'剑鱼',stungray:'恶臭蝠鲼',snake:'蛇',dragoon:'龙骑士',
    floods:'洪水',tides:'潮汐',dragoonegg:'龙骑士蛋',oceanwaves:'海浪',whalehunt:'鲸鱼追踪',alternatewhalehunt:'虎鲸概率',
    crocodog:'鳄狗袭击',yellowcrocodog:'黄色鳄狗',bluecrocodog:'蓝色鳄狗',waterencounters:'海上遭遇',
    palmtree:'椰树',jungletree:'丛林树',mangrovetree:'红树林',magmarock:'岩浆矿',crab:'螃蟹',sharkitten:'虎鲨幼崽',
    mosquito:'蚊子',chessnavy:'发条战船',twister:'豹卷风',tigershark:'虎鲨',kraken:'海妖',
    dungpile:'粪堆',hippopotamoose:'河马',peagawk:'孔雀',pog:'食人花犬',pangolden:'淘金兽',hanging_vine_patch:'悬挂藤蔓',
    thunderbirdnest:'雷鸟巢',asparagus:'芦笋',grass_tall:'高草',grass_tall_bunches:'高草丛',lotus:'莲花',lost_relics:'失落遗物',
    ruined_sculptures:'遗迹雕像',jungle_border_vine:'丛林边缘藤蔓',deep_jungle_fern_noise:'深丛林蕨类',
    bill_setting:'鸭嘴豪猪',frog_poison_setting:'箭毒蛙',giantgrub_setting:'巨型蛆虫',mosquito_setting:'蚊子',roc_setting:'大鹏',
    weevole_setting:'象鼻鼠',pugalisk_fountain:'铁巨蛇喷泉',dungbeetle_setting:'蜣螂',glowfly_setting:'荧光虫',
    hanging_vine_setting:'抓人藤蔓',hippopotamoose_setting:'河马',mandrakeman_setting:'曼德拉长老',piko_setting:'松鼠',thunderbird_setting:'雷鸟',
    brambles:'荆棘',fog:'雾',glowflycycle:'荧光虫生命周期',poison:'中毒机制',hayfever:'花粉过敏',pigbandit:'蒙面猪人',vampirebat:'吸血蝙蝠',
    ia_boats:'海难船只',dst_boats:'联机版船只',ia_drowning:'海难溺水机制',clocktype:'昼夜周期类型',pl_clocktype:'猪镇时钟类型',
    has_ocean:'生成海洋',keep_disconnected_tiles:'保留独立地块',layout_mode:'地形连接方式',task_set:'生物群落',start_location:'出生点'
  };
  // BEGIN expansion icon map
  const expansionImages = {
    "shipwrecked": {
      "alternatewhalehunt": "shipwrecked/alternatewhaling.png",
      "alternatewhaling": "shipwrecked/alternatewhaling.png",
      "ballphin": "shipwrecked/ballphinhouse.png",
      "ballphin_setting": "shipwrecked/ballphins.png",
      "ballphinhouse": "shipwrecked/ballphinhouse.png",
      "ballphins": "shipwrecked/ballphins.png",
      "bamboo": "shipwrecked/bamboo.png",
      "bermudatriangle": "shipwrecked/bermudatriangle.png",
      "berrybush": "shipwrecked/berrybush.png",
      "bioluminescence": "shipwrecked/bioluminescence.png",
      "bioluminescence_regrowth": "shipwrecked/bioluminescence.png",
      "birds": "shipwrecked/birds.png",
      "blank_season_red": "shipwrecked/blank_season_red.png",
      "blank_season_yellow": "shipwrecked/blank_season_yellow.png",
      "blank_world": "shipwrecked/blank_world.png",
      "bluecrocodog": "shipwrecked/monsooncrocodogs.png",
      "braincoral": "shipwrecked/braincoral.png",
      "bush_vine": "shipwrecked/vines.png",
      "butterfly": "shipwrecked/butterfly.png",
      "chess_monsters": "shipwrecked/chess_monsters.png",
      "chessnavy_setting": "shipwrecked/chess_monsters.png",
      "coffeebush": "shipwrecked/coffeebush.png",
      "coral": "shipwrecked/coral.png",
      "coral_brain_rock": "shipwrecked/braincoral.png",
      "coral_brain_rock_regrowth": "shipwrecked/braincoral.png",
      "crab_setting": "shipwrecked/crabbits.png",
      "crabbithole": "shipwrecked/crabbithole.png",
      "crabbits": "shipwrecked/crabbits.png",
      "crabhole": "shipwrecked/crabbithole.png",
      "crate": "shipwrecked/crates.png",
      "crates": "shipwrecked/crates.png",
      "crocodog": "shipwrecked/crocodogattacks.png",
      "crocodogattacks": "shipwrecked/crocodogattacks.png",
      "day": "shipwrecked/day.png",
      "dogfish": "shipwrecked/dogfish.png",
      "doydoy": "shipwrecked/doydoy.png",
      "dragoon": "shipwrecked/dragoonden.png",
      "dragoon_setting": "shipwrecked/dragoons.png",
      "dragoonden": "shipwrecked/dragoonden.png",
      "dragoonegg": "shipwrecked/dragooneggs.png",
      "dragooneggs": "shipwrecked/dragooneggs.png",
      "dragoons": "shipwrecked/dragoons.png",
      "dry": "shipwrecked/dry.png",
      "drycrocodogs": "shipwrecked/drycrocodogs.png",
      "dst_boats": "core/cookieboats.png",
      "elephantcactus": "shipwrecked/elephantcactus_active.png",
      "elephantcactus_active": "shipwrecked/elephantcactus_active.png",
      "fishermerm": "shipwrecked/fishermermhouse.png",
      "fishermerm_setting": "shipwrecked/merms.png",
      "fishermermhouse": "shipwrecked/fishermermhouse.png",
      "fishinhole": "shipwrecked/shoals.png",
      "floods": "shipwrecked/floods.png",
      "flup": "shipwrecked/flups.png",
      "flups": "shipwrecked/flups.png",
      "grass": "shipwrecked/grass.png",
      "hurricane": "shipwrecked/hurricane.png",
      "ia_boats": "core/smallboats.png",
      "ia_drowning": "core/deadlydrowning.png",
      "jellyfish": "shipwrecked/jellyfish.png",
      "jellyfish_setting": "shipwrecked/jellyfish.png",
      "jungletree": "shipwrecked/jungletree.png",
      "jungletree_regrowth": "shipwrecked/jungletree.png",
      "kraken": "shipwrecked/kraken.png",
      "krampus": "shipwrecked/krampus.png",
      "limpets": "shipwrecked/limpets.png",
      "lobster": "shipwrecked/lobsterhole.png",
      "lobster_setting": "shipwrecked/lobsters.png",
      "lobsterhole": "shipwrecked/lobsterhole.png",
      "lobsters": "shipwrecked/lobsters.png",
      "magma_rocks": "shipwrecked/magmarocks.png",
      "magmarock_regrowth": "shipwrecked/magmarocks.png",
      "magmarocks": "shipwrecked/magmarocks.png",
      "magmarocks_gold": "shipwrecked/magmarocks_gold.png",
      "mangrovetree": "shipwrecked/mangrovetree.png",
      "mangrovetree_regrowth": "shipwrecked/mangrovetree.png",
      "merms": "shipwrecked/merms.png",
      "mild": "shipwrecked/mild.png",
      "monsoon": "shipwrecked/monsoon.png",
      "monsooncrocodogs": "shipwrecked/monsooncrocodogs.png",
      "mosquito": "shipwrecked/mosquitos.png",
      "mosquitos": "shipwrecked/mosquitos.png",
      "mussel_farm": "shipwrecked/mussels.png",
      "mussels": "shipwrecked/mussels.png",
      "oceanwaves": "shipwrecked/waves.png",
      "ox": "shipwrecked/ox.png",
      "palmguard": "shipwrecked/palmguard.png",
      "palmtree_regrowth": "shipwrecked/trees.png",
      "poison": "core/poison.png",
      "poisonhole": "shipwrecked/poisonhole.png",
      "primeape": "shipwrecked/primeapehut.png",
      "primeape_setting": "core/monkeys.png",
      "primeapehut": "shipwrecked/primeapehut.png",
      "rainbowjellyfish": "shipwrecked/rainbowjellyfish.png",
      "rainbowjellyfish_setting": "shipwrecked/rainbowjellyfish.png",
      "resurrection": "shipwrecked/resurrection.png",
      "rock_charcoal": "shipwrecked/rock_charcoal.png",
      "rock_charcoal_regrowth": "shipwrecked/rock_charcoal.png",
      "rock_obsidian": "shipwrecked/rock_obsidian.png",
      "rock_obsidian_regrowth": "shipwrecked/rock_obsidian.png",
      "sand": "shipwrecked/sand.png",
      "sandhill": "shipwrecked/sand.png",
      "sandhill_regrowth": "shipwrecked/sand.png",
      "seagull": "shipwrecked/seagulls.png",
      "seagulls": "shipwrecked/seagulls.png",
      "seashell": "shipwrecked/seashell.png",
      "seashell_regrowth": "shipwrecked/seashell.png",
      "season_start": "shipwrecked/season_start.png",
      "seaweed": "shipwrecked/seaweed.png",
      "sharkitten": "shipwrecked/sharkitten.png",
      "sharkitten_setting": "shipwrecked/sharkitten.png",
      "sharx": "shipwrecked/sharx.png",
      "shipwreck": "shipwrecked/wrecks.png",
      "shipwrecked_season_start": "shipwrecked/season_start.png",
      "shipwrecked_trees": "shipwrecked/trees.png",
      "shoals": "shipwrecked/shoals.png",
      "snake": "shipwrecked/snakeden.png",
      "snake_setting": "core/snakes.png",
      "snakeden": "shipwrecked/snakeden.png",
      "snakes": "shipwrecked/snakes.png",
      "solofish": "shipwrecked/dogfish.png",
      "solofish_setting": "shipwrecked/dogfish.png",
      "stinkrays": "shipwrecked/stinkrays.png",
      "stungray": "shipwrecked/stinkrays.png",
      "stungray_setting": "shipwrecked/stinkrays.png",
      "sweet_potato": "shipwrecked/sweetpotatos.png",
      "sweet_potato_regrowth": "shipwrecked/sweetpotatos.png",
      "sweetpotatos": "shipwrecked/sweetpotatos.png",
      "swordfish": "shipwrecked/swordfish.png",
      "swordfish_setting": "shipwrecked/swordfish.png",
      "tar_pool": "shipwrecked/tarpools.png",
      "tarpools": "shipwrecked/tarpools.png",
      "tidalpool": "shipwrecked/tidalpools.png",
      "tidalpools": "shipwrecked/tidalpools.png",
      "tides": "shipwrecked/tides.png",
      "tigershark": "shipwrecked/tigershark.png",
      "trees": "shipwrecked/trees.png",
      "twister": "shipwrecked/twister.png",
      "vines": "shipwrecked/vines.png",
      "volcano": "shipwrecked/volcano.png",
      "volcano_island": "shipwrecked/volcano_island.png",
      "volcano_shrub": "shipwrecked/volcano_shrub.png",
      "volcano_shrub_regrowth": "shipwrecked/volcano_shrub.png",
      "volcanoisland": "shipwrecked/volcano_island.png",
      "waterencounters": "shipwrecked/waterencounters.png",
      "waterygrave": "shipwrecked/waterygraves.png",
      "waterygraves": "shipwrecked/waterygraves.png",
      "waves": "shipwrecked/waves.png",
      "whalehunt": "shipwrecked/whales.png",
      "whales": "shipwrecked/whales.png",
      "wildborehouse": "shipwrecked/wildborehouse.png",
      "wildbores": "shipwrecked/wildborehouse.png",
      "wildbores_setting": "shipwrecked/wildbores.png",
      "world_size": "shipwrecked/world_size.png",
      "wrecks": "shipwrecked/wrecks.png",
      "yellowcrocodog": "shipwrecked/drycrocodogs.png",
      "clocktype": "day.png",
      "pl_clocktype": "day.png",
      "layout_mode": "branching.png",
      "keep_disconnected_tiles": "loop.png",
      "no_joining_islands": "loop.png",
      "no_wormholes_to_disconnected_tiles": "loop.png",
      "has_ocean": "world_size.png"
    },
    "porkland": {
      "adult_flytraps": "porkland/adult_flytraps.png",
      "aloe": "porkland/aloe.png",
      "aporkalypse": "porkland/aporkalypse.png",
      "asparagus": "porkland/asparagus.png",
      "bats": "porkland/bats.png",
      "bill_setting": "porkland/platypine.png",
      "blank_season_red": "porkland/blank_season_red.png",
      "blank_season_yellow": "porkland/blank_season_yellow.png",
      "blank_world": "porkland/blank_world.png",
      "brambles": "porkland/brambles.png",
      "butterfly": "porkland/butterfly.png",
      "claw_trees": "porkland/claw_trees.png",
      "creeping_vines": "porkland/creeping_vines.png",
      "crumbling_brazier": "porkland/crumbling_brazier.png",
      "dart_traps": "porkland/dart_traps.png",
      "day": "porkland/day.png",
      "deep_jungle_fern_noise": "porkland/deep_jungle_fern_noise.png",
      "dst_boats": "core/cookieboats.png",
      "dungbeetle": "porkland/dungbeetle.png",
      "dungbeetle_setting": "porkland/dungbeetle.png",
      "dungpile": "porkland/dungpile.png",
      "flipping_rocks": "porkland/flipping_rocks.png",
      "flowers": "porkland/flowers.png",
      "fog": "porkland/fog.png",
      "frog_poison_setting": "porkland/poison_dart_frogs.png",
      "giant_grubs": "porkland/giant_grubs.png",
      "giantgrub_setting": "porkland/giant_grubs.png",
      "glowflies": "porkland/glowflies.png",
      "glowfly_life_cycle": "porkland/glowfly_life_cycle.png",
      "glowfly_setting": "porkland/glowflies.png",
      "glowflycycle": "porkland/glowfly_life_cycle.png",
      "gnat": "porkland/gnat.png",
      "gnat_mounds": "porkland/gnat_mounds.png",
      "grabbing_vine": "porkland/grabbing_vine.png",
      "grass": "porkland/grass.png",
      "grass_tall": "porkland/grass_tall.png",
      "grass_tall_bunches": "porkland/grass_tall_bunches.png",
      "grass_tall_infected": "porkland/grass_tall_infected.png",
      "great_leafy_stalks": "porkland/great_leafy_stalks.png",
      "guard_towers": "porkland/guard_towers.png",
      "hanging_vine": "porkland/hanging_vine.png",
      "hanging_vine_patch": "porkland/hanging_vine.png",
      "hanging_vine_setting": "porkland/grabbing_vine.png",
      "hayfever": "porkland/hayfever.png",
      "hippopotamoose": "porkland/hippopotamoose.png",
      "hippopotamoose_setting": "porkland/hippopotamoose.png",
      "honey_chests": "porkland/honey_chests.png",
      "humid": "porkland/humid.png",
      "ia_boats": "core/smallboats.png",
      "ia_drowning": "core/deadlydrowning.png",
      "jungle_border_vine": "porkland/jungle_border_vine.png",
      "kingfisher": "porkland/kingfisher.png",
      "lamp_posts": "porkland/lamp_posts.png",
      "lightning": "porkland/lightning.png",
      "lily_pads": "porkland/lily_pads.png",
      "lost_relics": "porkland/lost_relics.png",
      "lost_sculptures": "porkland/lost_sculptures.png",
      "lotus": "porkland/lotus.png",
      "lush": "porkland/lush.png",
      "mandrake_men": "porkland/mandrake_men.png",
      "mandrakeman_setting": "porkland/mandrake_men.png",
      "mant_comb_homes": "porkland/mant_comb_homes.png",
      "mant_lamps": "porkland/mant_lamps.png",
      "mant_queen": "porkland/mant_queen.png",
      "mants": "porkland/mants.png",
      "mean_flytraps": "porkland/mean_flytraps.png",
      "mosquito_setting": "porkland/mosquitos.png",
      "mosquitos": "porkland/mosquitos.png",
      "mushrooms": "porkland/mushrooms.png",
      "nettle": "porkland/nettle.png",
      "orange_pikos": "porkland/orange_pikos.png",
      "pangolden": "porkland/pangolden.png",
      "peagawk": "porkland/peagawk.png",
      "pig_bandit": "porkland/pig_bandit.png",
      "pig_ghosts": "porkland/pig_ghosts.png",
      "pig_houses": "porkland/pig_houses.png",
      "pigbandit": "porkland/pig_bandit.png",
      "piko_setting": "porkland/orange_pikos.png",
      "pikos": "porkland/pikos.png",
      "platypine": "porkland/platypine.png",
      "pog": "porkland/pogs.png",
      "pogs": "porkland/pogs.png",
      "poison": "core/poison.png",
      "poison_dart_frogs": "porkland/poison_dart_frogs.png",
      "porkland_season_start": "porkland/season_start.png",
      "primeape_setting": "core/monkeys.png",
      "pugalisk": "porkland/pugalisk.png",
      "pugalisk_fountain": "porkland/pugalisk_fountain.png",
      "rabid_beetles": "porkland/rabid_beetles.png",
      "radish": "porkland/radish.png",
      "rain": "porkland/rain.png",
      "rainforest_trees": "porkland/rainforest_trees.png",
      "reeds": "porkland/reeds.png",
      "roc": "porkland/roc.png",
      "roc_setting": "porkland/roc.png",
      "ruined_sculptures": "porkland/lost_sculptures.png",
      "rusted_hulks": "porkland/rusted_hulks.png",
      "sapling": "porkland/sapling.png",
      "scorpions": "porkland/scorpions.png",
      "season_start": "porkland/season_start.png",
      "skeletons": "porkland/skeletons.png",
      "small_ruins": "porkland/small_ruins.png",
      "snake_setting": "core/snakes.png",
      "snakes": "porkland/snakes.png",
      "spike_traps": "porkland/spike_traps.png",
      "stalagmites": "porkland/stalagmites.png",
      "tea_trees": "porkland/tea_trees.png",
      "temperate": "porkland/temperate.png",
      "thunderbird_setting": "porkland/thunderbirds.png",
      "thunderbirdnest": "porkland/thunderbirds.png",
      "thunderbirds": "porkland/thunderbirds.png",
      "tropical_flowers": "porkland/tropical_flowers.png",
      "tuber_trees": "porkland/tuber_trees.png",
      "vampire_bat_caves": "porkland/vampire_bat_caves.png",
      "vampire_bats": "porkland/vampire_bats.png",
      "vampirebat": "porkland/vampire_bats.png",
      "weevole": "porkland/weevole.png",
      "weevole_setting": "porkland/weevole.png",
      "world_size": "porkland/world_size.png",
      "clocktype": "day.png",
      "pl_clocktype": "day.png",
      "layout_mode": "branching.png",
      "keep_disconnected_tiles": "loop.png",
      "no_joining_islands": "loop.png",
      "no_wormholes_to_disconnected_tiles": "loop.png",
      "has_ocean": "world_size.png"
    }
  };
  // END expansion icon map
  const words = {wet:'飓风季',green:'雨季',dry:'旱季',humid:'潮湿季',lush:'繁茂季',
    'mild|green':'温和季或雨季','wet|dry':'飓风季或旱季','mild|wet|green|dry':'随机季节',
    'temperate|humid|lush':'随机季节'};
  const split = text => text.split(/\s+/).filter(Boolean);
  const make = (keys, title, configs, generation=false) => ({keys:split(keys),title,configs,generation});
  function kind(world, parsed) {
    const location = parsed.metadata?.location;
    if (location) return location.toLowerCase();
    const task = parsed.values.task_set;
    if(task==='volcano')return 'volcanoworld';
    return ['shipwrecked','porkland','volcanoworld'].includes(task) ? task : world.type === 'caves' ? 'cave' : 'forest';
  }
  function model(world, parsed, dmp, groupLabels) {
    const location=kind(world,parsed),title=profiles[location]||parsed.metadata?.location||'自定义世界';
    const definitions=new Map(),groups=[],seen=new Set(),present=new Set(parsed.entries.map(e=>e.name));
    const add = (group,index) => {
      const keys=group.keys.filter(key=>present.has(key)&&!seen.has(key));
      keys.forEach(key=>seen.add(key));
      if(keys.length)groups.push({...group,id:group.id||'mod-'+index,keys});
    };
    const custom=customGroups(location,dmp);
    custom.forEach((group,index)=>{
      group.keys.forEach(key=>definitions.set(key,{i18n:{zh:label(key)},configs:group.configs,customConfigsValue:Object.fromEntries(Object.entries(words).map(([key,zh])=>[key,{zh}]))}));
      add(group,index);
    });
    const cave=location==='cave'||location==='caves';
    for(const [prefix,source,generation] of [['rule',cave?dmp.cavesWorldRule:dmp.groundWorldRule,false],['gen',cave?dmp.cavesWorldGeneration:dmp.groundWorldGeneration,true]]){
      for(const [id,keys] of Object.entries(source))add({id:prefix+'-'+id,title:(generation?'世界生成 · ':'世界规则 · ')+(groupLabels[id]||id),keys,generation});
    }
    // Every imported override must be represented, even if a future mod adds
    // a field that neither the panel nor DMP knows about.
    add({id:'custom',title:'模组与自定义参数',keys:parsed.entries.map(e=>e.name)},'custom');
    for(const entry of parsed.entries){
      if(definitions.has(entry.name))continue;
      const original=(cave&&dmp.caveOverrideWorldGenerationWorld[entry.name])||dmp.overrides[entry.name];
      const rawProfileField=custom.length&&['task_set','start_location'].includes(entry.name);
      definitions.set(entry.name,original&&!rawProfileField?original:{i18n:{zh:label(entry.name)},raw:true});
    }
    const images=expansionImages[location==='volcanoworld'?'shipwrecked':location];
    if(images)for(const [key,definition] of definitions){
      const image=images[key]||expansionImages.shipwrecked[key]||expansionImages.porkland[key]||dmp.overrides[key]?.image;
      if(image)definitions.set(key,{...definition,image});
    }
    return {location,title,groups,definitions};
  }
  function customGroups(location,dmp) {
    const frequency=dmp.overrides.lightning.configs,worldgen=dmp.overrides.grass.configs,season=dmp.overrides.autumn.configs;
    let custom=[];
    if(location==='shipwrecked')custom=[
      make('mild hurricane monsoon dry','海难 · 季节规则',season),
      make('shipwrecked_season_start','海难 · 起始季节',['default','wet','green','dry','mild|green','wet|dry','mild|wet|green|dry'],true),
      make('sweet_potato limpets mussel_farm seaweed seashell bamboo bush_vine coral coral_brain_rock crate tidalpool sandhill poisonhole bioluminescence magma_rocks tar_pool shipwrecked_trees shipwreck waterygrave coffeebush elephantcactus rock_obsidian rock_charcoal volcano_shrub','海难 · 资源生成',worldgen,true),
      make('crabhole ox wildbores ballphin primeape fishermerm lobster solofish jellyfish rainbowjellyfish fishinhole seagull flup swordfish stungray snake dragoon','海难 · 生物生成',worldgen,true),
      make('bermudatriangle','海难 · 地形生成',worldgen,true),
      make('volcano doydoy','海难 · 特殊世界生成',['never','default'],true),
      make('volcanoisland','海难 · 火山岛',['none','always'],true),
      make('floods tides dragoonegg oceanwaves whalehunt alternatewhalehunt crocodog waterencounters','海难 · 环境与袭击',frequency),
      make('yellowcrocodog bluecrocodog','海难 · 特殊鳄狗',['never','default']),
      make('sweet_potato_regrowth palmtree_regrowth jungletree_regrowth mangrovetree_regrowth coral_brain_rock_regrowth seashell_regrowth sandhill_regrowth rock_obsidian_regrowth rock_charcoal_regrowth volcano_shrub_regrowth magmarock_regrowth bioluminescence_regrowth','海难 · 资源再生',dmp.overrides.regrowth.configs),
      make('crab_setting wildbores_setting ballphin_setting fishermerm_setting sharkitten_setting lobster_setting jellyfish_setting rainbowjellyfish_setting solofish_setting swordfish_setting stungray_setting chessnavy_setting dragoon_setting twister tigershark kraken','海难 · 生物与巨兽',frequency)
    ];
    if(location==='volcanoworld')custom=[
      make('mild hurricane monsoon dry','火山 · 季节规则',season),
      make('shipwrecked_season_start','火山 · 起始季节',['default','wet','green','dry','mild|green','wet|dry','mild|wet|green|dry'],true),
      make('magma_rocks coffeebush elephantcactus rock_obsidian rock_charcoal volcano_shrub','火山 · 资源生成',worldgen,true),
      make('dragoon','火山 · 生物生成',worldgen,true),
      make('dragoonegg','火山 · 龙骑士蛋',frequency),
      make('rock_obsidian_regrowth rock_charcoal_regrowth volcano_shrub_regrowth magmarock_regrowth','火山 · 资源再生',dmp.overrides.regrowth.configs),
      make('wildbores_setting fishermerm_setting dragoon_setting','火山 · 生物规则',frequency)
    ];
    if(location==='porkland')custom=[
      make('temperate humid lush','猪镇 · 季节规则',season),
      make('porkland_season_start','猪镇 · 起始季节',['default','humid','lush','temperate|humid|lush'],true),
      make('dungpile hippopotamoose peagawk pog pangolden hanging_vine_patch thunderbirdnest','猪镇 · 生物生成',worldgen,true),
      make('asparagus grass_tall grass_tall_bunches lotus','猪镇 · 资源生成',worldgen,true),
      make('lost_relics ruined_sculptures jungle_border_vine deep_jungle_fern_noise','猪镇 · 遗迹与丛林',frequency,true),
      make('bill_setting frog_poison_setting giantgrub_setting mosquito_setting weevole_setting dungbeetle_setting glowfly_setting hanging_vine_setting hippopotamoose_setting mandrakeman_setting piko_setting thunderbird_setting','猪镇 · 生物规则',frequency),
      make('pugalisk_fountain pigbandit vampirebat','猪镇 · 特殊生物',frequency),
      make('roc_setting brambles fog glowflycycle poison hayfever','猪镇 · 环境规则',['never','default'])
    ];
    if(['shipwrecked','porkland','volcanoworld'].includes(location)){
      custom.push(make('ia_boats dst_boats ia_drowning'+(location==='porkland'?'':' poison'),'扩展世界 · 船只与生存',['none','always']));
      custom.push(make('primeape_setting snake_setting','扩展世界 · 生物规则',frequency));
    }
    return custom;
  }
  function label(key){
    if(labels[key])return labels[key];
    for(const [suffix,word] of [['_regrowth','再生'],['_setting','刷新']])if(key.endsWith(suffix)){
      const base=key.slice(0,-suffix.length);if(labels[base])return labels[base]+' · '+word;
    }
    return key;
  }
  // Static presets target Island Adventures' registered locations. Keep generation
  // identifiers explicit: a forest task set cannot generate a Shipwrecked world.
  function preset(location,mode,dmp) {
    if(!['shipwrecked','porkland','volcanoworld'].includes(location))throw Error('这个世界类型请保留原配置或使用自定义预设');
    if(!['endless','survival','relaxed','wilderness','lightsOut'].includes(mode))throw Error('海难、猪镇和火山支持无尽、生存、轻松、荒野和暗无天日模式');
    const entries=dmp.validateLevelData(dmp.presets[mode].master).entries,overrides={};
    const common=new Set([...dmp.groundWorldRule.events,...dmp.groundWorldRule.survivors,
      ...'day spawnmode ghostenabled portalresurection ghostsanitydrain resettime basicresource_regrowth regrowth flowers_regrowth butterfly birds lightning weather'.split(' '),
      ...(location==='volcanoworld'?[]:'grass rock sapling flint reeds mushroom berrybush flowers boons'.split(' '))]);
    for(const entry of entries)if(common.has(entry.name))overrides[entry.name]=entry.type==='boolean'?entry.value==='true':entry.type==='number'?Number(entry.value):entry.value;
    for(const group of customGroups(location,dmp))if(group.configs.includes('default'))for(const key of group.keys)overrides[key]='default';
    Object.assign(overrides,{season_start:'default',world_size:'default',has_ocean:true,keep_disconnected_tiles:true,dst_boats:'none',ia_boats:'always',ia_drowning:'always'});
    if(location==='shipwrecked')Object.assign(overrides,{task_set:'shipwrecked',start_location:mode==='lightsOut'?'shipwrecked_darkness':'shipwrecked_default',layout_mode:'LinkNodesByKeys',clocktype:'tropical',poi:'never',volcanoisland:'none',poison:'always'});
    else if(location==='volcanoworld')Object.assign(overrides,{task_set:'volcano',start_location:'volcano_default',world_size:'small',has_ocean:false,layout_mode:'LinkNodesByKeys',clocktype:'tropical',boons:'never',poi:'never',traps:'never',prefabswaps_start:'classic',grassgekkos:'never',poison:'always'});
    else Object.assign(overrides,{task_set:'porkland',start_location:'PorkLandStart',layout_mode:'RestrictNodesByKey',wormhole_prefab:'wormhole',roads:'never',branching:'least',prefabswaps_start:'classic',specialevent:'none',grassgekkos:'never',frograin:'never',wildfires:'never',deerclops:'never',bearger:'never',deciduousmonster:'never',perd:'never',penguins:'never',hunt:'never',no_wormholes_to_disconnected_tiles:true,no_joining_islands:false,clocktype:'plateau',pl_clocktype:'porkland'});
    // The relaxed preset changes survival rules without replacing the location.
    if(location==='shipwrecked'&&mode==='relaxed'){overrides.crocodog='rare';overrides.has_ia_drowning='none';overrides.wildfires='never';}
    const ids={survival:'SURVIVAL_SHIPWRECKED_CLASSIC',endless:'SHIPWRECKED_ENDLESS',relaxed:'SHIPWRECKED_RELAXED',wilderness:'SHIPWRECKED_WILDERNESS',lightsOut:'SHIPWRECKED_LIGHTS_OUT'};
    const id=location==='porkland'?'PORKLAND_DEFAULT':location==='volcanoworld'?'SURVIVAL_VOLCANO_CLASSIC':ids[mode];
    const scalar=value=>typeof value==='string'?JSON.stringify(value):String(value);
    const lines=Object.keys(overrides).sort().map(key=>'    '+key+' = '+scalar(overrides[key])+',');
    const source='-- FeatherPanel: '+profiles[location]+'世界配置，可直接使用可视化调整。\nreturn {\n'
      +'  id = '+scalar(id)+',\n  location = '+scalar(location)+',\n  name = '+scalar(profiles[location])+',\n  desc = '+scalar(profiles[location]+'世界配置')+',\n'
      +'  settings_id = '+scalar(id)+',\n  worldgen_id = '+scalar(id)+',\n  version = '+(location==='porkland'?2:4)+',\n'
      +'  override_level_string = false,\n  playstyle = '+scalar(mode==='lightsOut'?'lightsout':mode)+',\n'
      +'  background_node_range = {0, '+(location==='volcanoworld'?0:location==='porkland'?1:2)+'},\n  numrandom_set_pieces = 0,\n  random_set_pieces = {},\n  required_prefabs = {"multiplayer_portal"},\n'
      +'  overrides = {\n'+lines.join('\n')+'\n  },\n}\n';
    dmp.validateLevelData(source);return source;
  }
  root.FeatherWorldCustomize={kind,model,profiles,preset};
})(typeof window==='object'?window:globalThis);
