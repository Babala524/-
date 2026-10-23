import fs from 'node:fs';
import { inside, demand } from './core.mjs';

export const whitelistFile=(store,id)=>inside(store.cluster(id),'whitelist.txt');
export function readWhitelist(store,id) {
  const file=whitelistFile(store,id);
  return fs.existsSync(file)?[...new Set(fs.readFileSync(file,'utf8').split(/\r?\n/).map(id=>id.trim()).filter(id=>/^KU_[A-Za-z0-9_-]{4,80}$/.test(id)))]:[];
}
export function reservedClusterSource(source,slots) {
  demand(Number.isInteger(slots)&&slots>=0&&slots<=64,'预留名额不合法');
  const lines=source.split(/\r?\n/),out=[];let inNetwork=false,found=false;
  for(const line of lines){
    const section=line.match(/^\s*\[([^\]]+)\]\s*(?:[;#].*)?$/);
    if(section){inNetwork=section[1].trim().toUpperCase()==='NETWORK';out.push(line);if(inNetwork){out.push(`whitelist_slots = ${slots}`);found=true;}continue;}
    if(inNetwork&&/^\s*whitelist_slots\s*=/i.test(line))continue;
    out.push(line);
  }
  if(!found)out.push('[NETWORK]',`whitelist_slots = ${slots}`);
  return out.join('\n');
}
