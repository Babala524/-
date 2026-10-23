import fs from 'node:fs';

// Read only the installed item block; detail/latest timestamps are not an installed version.
export function installedRevision(file,id) {
  if(!fs.existsSync(file))return null;
  const text=fs.readFileSync(file,'utf8'),section=text.indexOf('"WorkshopItemsInstalled"');
  if(section<0)return null;
  let start=text.indexOf('{',section),depth=0,end=start;
  for(;end<text.length;end++){if(text[end]==='{')depth++;if(text[end]==='}'&&--depth===0)break;}
  const match=text.slice(start,end).match(new RegExp('"'+id+'"\\s*\\{([^{}]*)\\}'));
  if(!match)return null;
  const time=Number(match[1].match(/"timeupdated"\s*"(\d+)"/)?.[1]);
  return time>0?{timeUpdated:time,manifest:match[1].match(/"manifest"\s*"(\d+)"/)?.[1]||''}:null;
}

export function contentProgress(text) {
  const matches=[...text.matchAll(/(?:download|Downloaded)\s+(\d+)\s*\/\s*(\d+)/gi)];
  const match=matches.at(-1);if(!match||Number(match[2])<=0)return null;
  const downloaded=Number(match[1]),total=Number(match[2]);
  return {downloadedBytes:downloaded,totalBytes:total,progress:Math.min(99,downloaded/total*100),progressSource:'steam-bytes'};
}
