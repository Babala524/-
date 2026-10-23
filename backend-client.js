/* Loaded only by FeatherPanel backend; standalone index.html remains a local preview. */
(async function connectFeatherPanel() {
  if (!/^https?:$/.test(location.protocol)) return;
  const roomID = new URLSearchParams(location.search).get('room') || '0';
  const serverSnapshot = window.featherPanelInitialState;
  let overview = null, operationBusy = false;
  const cachedMaps=new Map();
  let savedMods = serverSnapshot?.room?.mods || [];
  const selectionKey='feather-pending-mods-v1:'+roomID;
  const initialSelection=localJson(selectionKey,null);
  const initialBrowserMods=loadedRoomDraft?structuredClone(roomDraft.mods):null;
  async function request(route, input, method = input === undefined ? 'GET' : 'POST', requestOptions = {}) {
    const response = await fetch('/api' + route, { method, credentials:'same-origin', headers:input === undefined ? {} : {'Content-Type':'application/json'}, body:input === undefined ? undefined : JSON.stringify(input), signal:requestOptions.signal });
    if (response.status === 401) { location.assign('/login'); throw Error('请重新登录'); }
    const payload = await response.json(); if (!response.ok) throw Error(payload.error || '请求失败'); return payload.data ?? payload;
  }
  const route = suffix => `/rooms/${encodeURIComponent(roomID)}${suffix ? '/' + suffix : ''}`;
  const wait = milliseconds => new Promise(resolve=>setTimeout(resolve,milliseconds));
  async function task(result,onProgress) {
    if (!result?.taskID) return result;
    const until=Date.now()+35*60*1000;
    while(Date.now()<until) {
      const state=await request('/tasks/'+encodeURIComponent(result.taskID));
      if(typeof onProgress==='function')onProgress(state);
      if(state.state==='succeeded')return state.result;
      if(state.state==='failed'||state.state==='cancelled')throw Error(state.error||'后台任务已终止');
      await wait(600);
    }
    throw Error('任务仍未完成，请稍后查看日志');
  }
  window.featherPanelRoom = { id:roomID };
  window.featherModSelectionChanged=()=>{try{localStorage.setItem(selectionKey,JSON.stringify({mods:roomDraft.mods.map(({id,name,enabled,config})=>({id,name,enabled,config})),saved:false}));}catch{}};
  window.featherModSelectionLabel=mod=>{const saved=savedMods.find(item=>item.id===mod.id);return mod.enabled?(saved?.enabled?'已保存启用 · 启动后加载':'待应用 · 已选择启用'):saved?.enabled?'待应用 · 已选择停用':'已安装';};
  window.featherPanelServices = {
    getRoom:()=>request(route('')),
    getInbox:()=>request('/inbox'),
    readInbox:input=>request('/inbox/read',input),
    configureAutoModUpdates:input=>request('/workshop/auto-update',input,'PUT'),
    checkModUpdates:()=>request('/workshop/auto-update/check',{}).then(task),
    getOverview:()=>request(route('status')),
    getWorldStatus:()=>request(route('worlds')),
    getGameUpdate:()=>request('/game/status'),
    getGameUpdateTask:input=>request('/tasks/'+encodeURIComponent(input.taskID)),
    cancelGameUpdate:()=>request('/game/update/cancel',{},'POST'),
    updateGame:async input=>{
      if(operationBusy)throw Error('有操作正在进行，请稍后更新游戏');
      operationBusy=true;
      try{const queued=await request('/game/update',{validate:input?.validate===true},'POST');input?.onQueued?.(queued.taskID);return await task(queued,input?.onProgress);}
      finally{operationBusy=false;refreshOverview();}
    },
    controlWorld:async input=>{
      if(operationBusy)throw Error('房间有操作正在执行，请稍后');
      operationBusy=true;
      try{return await task(await request(route('worlds/control'),{worldID:input.worldID,action:input.action}));}
      finally{operationBusy=false;refreshOverview();}
    },
    searchWorkshop:input=>{const {signal,...body}=input||{};return request('/workshop/search',body,'POST',{signal});},
    syncWorkshop:input=>request('/workshop/details',{ids:input.ids}),
    getInstalledMods:input=>request(route('mods')+(input?.checkUpdates?'?updates=1':'')),
    getModDownloads:()=>request('/workshop/downloads'),
    getModConfig:input=>request(route('mods/config'),{modID:input.modID,retryTranslation:input.retryTranslation===true}),
    downloadMod:input=>request(route('mods/download'),{id:input.id,source:input.source,hash:input.hash}).then(result=>task(result,input.onProgress)),
    getModLibrary:()=>request('/mod-library'),
    collectMod:input=>request(route('mods/collect'),{id:input.id}),
    submitLibraryMod:input=>request('/mod-library/submit',{id:input.id,consent:input.consent}),
    reviewLibraryMod:input=>request('/mod-library/review',input),
    unpublishLibraryMod:input=>request('/mod-library/unpublish',input),
    removeLibraryMod:input=>request('/mod-library/remove',input),
    uploadMod:input=>new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest(),query=new URLSearchParams({filename:input.file.name,id:input.id,name:input.name||''});
      xhr.open('POST','/api'+route('mods/upload')+'?'+query);xhr.timeout=180000;xhr.setRequestHeader('Content-Type','application/zip');
      xhr.upload.onprogress=e=>{if(e.lengthComputable)input.onProgress?.(e.loaded/e.total*100);};
      xhr.onerror=()=>reject(Error('模组上传连接失败'));xhr.ontimeout=()=>reject(Error('模组上传超时'));
      xhr.onload=()=>{try{const payload=JSON.parse(xhr.responseText);if(xhr.status<200||xhr.status>=300)throw Error(payload.error||'模组上传失败');resolve(payload.data??payload);}catch(e){reject(e);}};xhr.send(input.file);
    }).then(result=>task(result,input.onTaskProgress)),
    updateMod:input=>request(route('mods/update'),{id:input.id}).then(result=>task(result,input.onProgress)),
    deleteMod:input=>request(route('mods/delete'),{id:input.id}).then(task),
    getLogs:input=>{const query=new URLSearchParams();if(Number.isFinite(input?.limit))query.set('limit',String(Math.round(input.limit)));if(input?.world&&input.world!=='all')query.set('world',input.world);if(input?.type&&input.type!=='all')query.set('type',input.type);return request(route('logs')+(query.toString()?'?'+query:''));},
    sendAnnouncement:()=>request(route('announcement'),{}),
    getPlayers:()=>request(route('players')),
    updatePlayerList:input=>request(route('players/list'),{kind:input.kind,userid:input.userid,enabled:input.enabled}),
    kickPlayer:input=>request(route('players/kick'),{userid:input.userid}).then(task),
    getMapPreview:input=>request(route('map')+'?world='+encodeURIComponent(input.worldID||'')+'&quality='+(input.quality==='preview'?'preview':'full')+(input.force?'&refresh=1':''),undefined,'GET',{signal:input.signal||AbortSignal.timeout(120000)}),
    getMapDashboard:async input=>{
      const worlds=overview?.worlds||serverSnapshot?.room?.worlds||[];
      const worldID=input?.worldID||worlds.find(world=>world.running)?.directory||worlds[0]?.directory||'';
      return window.featherPanelServices.getMapPreview({worldID,signal:input?.signal,force:input?.force,quality:'preview'});
    },
    getSaves:()=>request(route('saves')),
    deleteSaves:input=>request(route('saves/delete'),{saveIDs:input.saveIDs}),
    restoreSave:input=>request(route('saves/restore'),{saveID:input.saveID}).then(task).then(async result=>{const room=await request(route(''));savedMods=structuredClone(room.mods||[]);if(typeof loadBackendRoom==='function')loadBackendRoom(room);try{if(typeof exportRoomDraft==='function')localStorage.setItem('feather-room-settings-v3',JSON.stringify(exportRoomDraft()));}catch{}if(typeof refreshInstalledMods==='function')await refreshInstalledMods(true);return {...result,room};}),
    downloadSave:input=>{const link=document.createElement('a');link.href='/api'+route('saves/download')+'?saveID='+encodeURIComponent(input.saveID);link.download='';document.body.append(link);link.click();link.remove();return {downloaded:true};},
    getSnapshots:()=>request(route('snapshots')),
    restoreSnapshot:input=>request(route('snapshots/restore'),{snapshotID:input.snapshotID,worldID:input.worldID}).then(task).then(async result=>{const room=await request(route(''));savedMods=structuredClone(room.mods||[]);if(typeof loadBackendRoom==='function')loadBackendRoom(room);try{if(typeof exportRoomDraft==='function')localStorage.setItem('feather-room-settings-v3',JSON.stringify(exportRoomDraft()));}catch{}if(typeof refreshInstalledMods==='function')await refreshInstalledMods(true);return {...result,room};}),
    uploadSave:input=>new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest(),query=new URLSearchParams({filename:input.file.name,name:input.name});
      xhr.open('POST','/api'+route('saves/upload')+'?'+query);xhr.timeout=180000;
      xhr.setRequestHeader('Content-Type','application/octet-stream');
      xhr.upload.onprogress=event=>{if(event.lengthComputable)input.onProgress?.(event.loaded/event.total*100);};
      xhr.onerror=()=>reject(Error('上传连接失败'));xhr.ontimeout=()=>reject(Error('上传超时'));
      xhr.onload=()=>{try{const payload=JSON.parse(xhr.responseText);if(xhr.status<200||xhr.status>=300)throw Error(payload.error||'上传失败');resolve(payload.data??payload);}catch(error){reject(error);}};
      xhr.send(input.file);
    })
  };
  if(typeof refreshInbox==='function'){
    refreshInbox();
    setInterval(()=>{if(!document.hidden)refreshInbox();},30000);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshInbox();});
  }
  let gameCheckPending=false;
  async function refreshGameUpdateIndicator(){
    if(gameCheckPending)return;gameCheckPending=true;
    try{const data=await window.featherPanelServices.getGameUpdate();if(typeof applyGameUpdateStatus==='function')applyGameUpdateStatus(data);}catch{if(typeof renderGameUpdateIndicator==='function')renderGameUpdateIndicator({...gameVersionStatus,state:'unavailable',stale:Boolean(gameVersionStatus?.checkedAt)});}finally{gameCheckPending=false;}
  }
  refreshGameUpdateIndicator();
  setInterval(()=>{if(!document.hidden)refreshGameUpdateIndicator();},60000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshGameUpdateIndicator();});
  // Bind navigation as soon as map services exist; workshop and save loading
  // must not leave the map page inert when users open it immediately.
  const savedGo=go;
  go=function(index){savedGo(index);if(pages[cur]==='logs')refreshManagementLogs();if(pages[cur]==='saves')refreshActiveSaveSection();if(pages[cur]==='players')refreshPlayerManagement();if(pages[cur]==='map'){renderMapWorldButtons(overview?.worlds||serverSnapshot?.room?.worlds||[]);refreshMapDashboard();}};
  // Save the memory copy containing the current password, rather than the password-free local export.
  saveRoomDraft = async function saveRoomToBackend() {
    if(operationBusy){toast('有操作正在进行，请稍后保存');return;}
    try{
      const input=structuredClone(validateRoomDraft());operationBusy=true;showRoomError();roomField('draftState').textContent='● 正在保存';
      const response=await request(route(''),input,'PUT');
      roomField('draftState').textContent='● 已保存到服务器';roomField('draftState').style.color='var(--ok)';
      if(!response.saved)throw Error('服务器未确认保存');
      rememberConsoleWorlds(input.worlds);
      try{localStorage.setItem(roomDraftKey,JSON.stringify(exportRoomDraft()));}catch{toast('服务器已保存，浏览器草稿未能写入');}
      savedMods=structuredClone(input.mods);try{localStorage.setItem(selectionKey,JSON.stringify({mods:input.mods,saved:true}));}catch{}
      renderDownloadedMods();
      const hasRoomSettings = typeof response.requiresRestart === 'boolean';
      const successTitle = hasRoomSettings ? '房间设置保存成功' : '模组设置保存成功';
      const successText = response.requiresRestart ? '配置已写入服务器，当前游戏继续运行，重启后加载新设置。' : hasRoomSettings ? '配置已写入服务器，后续启动时会使用新设置。' : '模组配置已写入服务器，启动游戏时会应用。';
      if(typeof showActionSuccess==='function') showActionSuccess(successTitle,successText);
      else toast(successText);
      await refreshOverview();
    }catch(error){roomField('draftState').textContent='● 保存失败';showRoomError(error.message);toast(error.message);}
    finally{operationBusy=false;}
  };
  async function control(action,extra={}) {
    if(operationBusy){toast('有操作正在进行，请稍后');return;}
    operationBusy=true;
    try{
      const appliesMods=['start','restart'].includes(action),mods=appliesMods?structuredClone(roomDraft.mods.map(({id,name,enabled,config})=>({id,name,enabled,config}))):undefined;
      toast(appliesMods?'正在应用已选择的模组并启动游戏…':'正在执行游戏操作…');
      const result=await task(await request(route('control'),{action,...extra,...(appliesMods?{mods}:{})}));
      cachedMaps.clear();
      if(result.modsSaved){savedMods=mods;try{localStorage.setItem(selectionKey,JSON.stringify({mods,saved:true}));}catch{}renderDownloadedMods();}
      if(['start','restart'].includes(action)){
        showActionSuccess(action==='restart'?'应用并重启成功':'应用模组并启动成功',result.modsSaved?'房间模组配置已保存，游戏世界正在加载。':'游戏操作已完成，模组配置已应用。');
      }else toast(result.modsSaved?'房间模组已应用，游戏正在加载，请查看日志确认':'操作已完成');
      await refreshOverview();return result;
    }
    catch(error){toast(error.message);}
    finally{operationBusy=false;}
  }
  gameOp = name=>control({'启动':'start','关闭':'stop','重启':'restart'}[name]);
  checkWorld = async button=>{
    const label=button.textContent;button.disabled=true;button.textContent='检查中…';
    try{const result=await request(route('control'),{action:'check'});roomField('lobbyCheckResult').textContent=result.message;roomField('lobbyCheckResult').hidden=false;toast(result.message);}
    catch(error){roomField('lobbyCheckResult').textContent='大厅检查失败：'+error.message;roomField('lobbyCheckResult').hidden=false;toast(error.message);}
    finally{button.disabled=false;button.textContent=label;}
  };
  rollback = ()=>control('rollback',{days:Number(roomField('rollbackDays').value.match(/\d+/)?.[0]||1)});
  resetRoom = ()=>{
    roomField('resetDialog').close();
    confirmRoomAction('确认重置全部世界','这会重新生成所有世界，清除当前游戏进度。建议先创建备份。',()=>control('reset'));
  };
  backupImmediately = async()=>{
    if(operationBusy){toast('有操作正在进行，请稍后');return;}operationBusy=true;
    try{toast('正在安全备份，游戏运行时会先停止并在备份后启动');await task(await request(route('saves/backup'),{}));toast('备份已生成');await refreshManagementSaves();await refreshOverview();}
    catch(error){toast(error.message);}finally{operationBusy=false;}
  };
  function statistic(kind,value,suffix,note) {
    const stat=document.querySelector(`[data-detail="${kind}"]`);if(!stat)return;
    const display=stat.querySelector('.v');display.replaceChildren(document.createTextNode(String(value)),makeNode('small',suffix));stat.querySelector('.t').textContent=note;
  }
  function renderOverview(data) {
    const running=data.worlds.filter(world=>world.running).length;
    document.getElementById('srvDot').classList.toggle('off',running===0);
    document.getElementById('srvText').textContent=running?`运行中 · ${running} 层世界`:'已停止 · 离线';
    document.querySelector('#v-console .page-head .sub').textContent=`房间「${data.name}」 · ${data.platform} · 服务器数据`;
    document.querySelector('#v-console .page-head h2').textContent='绯羽 · 控制台';
    savedMods=data.mods||savedMods;
    renderConsoleOverview(data);
    window.featherPanelRoom.directCode=data.directCode;
  }
  async function refreshOverview(raise=false) {
    try{overview=await request(route('status'));renderOverview(overview);return overview;}
    catch(error){if(raise)throw error;document.getElementById('srvText').textContent='未取得服务器状态';document.getElementById('srvDot').classList.add('off');}
  }
  let worldStatusPending = null;
  async function refreshWorldStatus() {
    if(worldStatusPending)return worldStatusPending;
    worldStatusPending=window.featherPanelServices.getWorldStatus().then(data=>{renderConsoleWorlds(data.worlds,data);return data;}).catch(error=>{
      roomField('consoleWorldRefreshState').textContent='资源更新失败，正在重试';
      document.querySelectorAll('.world-power').forEach(button=>button.disabled=true);
    }).finally(()=>worldStatusPending=null);
    return worldStatusPending;
  }
  function loadBackendRoom(data) {
    rememberConsoleWorlds(data.worlds);
    roomDraft={...data,mods:data.mods.map(mod=>({...mod,source:'draft',category:'房间模组',icon:'🧩',configFields:null}))};
    roomField('roomName').value=data.name;applyAnnouncementFields(data);roomField('roomPassword').value=data.password;roomField('roomPlayers').value=data.maxPlayers;roomField('roomPlayersValue').textContent=`${data.maxPlayers} 人`;
    roomField('roomMode').value=data.mode;roomField('worldCount').value=data.worldCount;roomField('roomPause').checked=data.pause;roomField('roomVote').checked=data.vote;
    roomField('backupTime').value=data.automation.backupTime;roomField('autoBackup').checked=data.automation.autoBackup;applyRestartFields(data.automation);
    chooseSetting(document.querySelector(`[data-choice="pvp"] [data-value="${data.pvp?'on':'off'}"]`),true);
    chooseSetting(document.querySelector(`[data-choice="startType"] [data-value="${data.automation.startType}"]`),true);
    renderWorldPorts();renderWorldConfigTabs();renderWorldEditor();renderStandaloneMods();updateRoomStepUI();
    roomField('draftState').textContent='● 已读取服务器配置';
  }
  roomField('rollbackDialog').querySelector('p').textContent='回档将覆盖当前游戏进度；请先确认备份。';
  roomField('resetDialog').querySelector('p').textContent='重置会重新生成全部世界，清除当前进度。';
  roomField('resetWorld').replaceChildren(makeNode('option','全部世界'));
  try{const room=serverSnapshot?.room || await request(route(''));savedMods=structuredClone(room.mods);loadBackendRoom(room);
    const pending=initialSelection&&!initialSelection.saved&&Array.isArray(initialSelection.mods)?initialSelection.mods:!room.mods.length&&initialBrowserMods?.length?initialBrowserMods:null;
    if(pending){roomDraft.mods=pending.map(mod=>({...mod,source:'draft',icon:'🧩',configFields:null}));markRoomDirty();renderStandaloneMods();renderDownloadedMods();}
  }catch(error){toast('请先在房间配置中保存新房间；'+error.message);}
  // Until the first room is saved, suppress the static preview metrics.
  for(const kind of ['days','players','mods','worlds','resources'])statistic(kind,'—','','等待服务器数据');

  document.getElementById('srvText').textContent='正在连接后端…';
  if(serverSnapshot?.overview){overview=serverSnapshot.overview;renderOverview(overview);}else await refreshOverview();
  await refreshWorldStatus();
  if(overview){await refreshInstalledMods();await refreshManagementSaves();}
  const mapService=window.featherPanelServices.getMapPreview;
  window.featherPanelServices.getMapPreview=input=>{
    const key=`${input.worldID||''}:${input.quality==='preview'?'preview':'full'}`;
    const cached=cachedMaps.get(key);if(!input.force&&cached&&Date.now()-cached.time<60000)return Promise.resolve(cached.map);
    return mapService(input).then(map=>{cachedMaps.set(key,{time:Date.now(),map});return map;});
  };
  await refreshModDownloads();
  setInterval(()=>{if(!document.hidden)refreshModDownloads();},2000);
  // Match DMP: preload the workshop page so recommended mods are ready when opened.
  if(typeof searchWorkshop==='function') searchWorkshop('').catch(()=>{});
  setInterval(()=>{if(!document.hidden&&!operationBusy)refreshOverview();},5000);
  setInterval(()=>{if(!document.hidden)refreshWorldStatus();},3000);
  setInterval(()=>{if(!document.hidden&&pages[cur]==='players')refreshPlayerManagement();},15000);
  setInterval(()=>{if(!document.hidden&&pages[cur]==='mods'&&activeModSection==='downloaded'&&Date.now()-installedUpdateCheckAt>=300000)refreshInstalledMods();},60000);
  delete window.featherPanelInitialState;
})();
