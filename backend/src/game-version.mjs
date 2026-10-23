// Compare Steam build IDs, never the unrelated numeric game version.txt value.
// Metadata is read-only: polling cannot launch SteamCMD or update game files.
export function installedGameBuild(text) {
  const app=text.match(/"appid"\s*"(\d+)"/i)?.[1];
  if(app!=='343050')return null;
  return text.match(/"buildid"\s*"([1-9]\d{0,15})"/i)?.[1]||null;
}

export class GameVersionCheck {
  constructor({fetcher=fetch,now=Date.now}={}) {
    this.fetcher=fetcher;this.now=now;this.cache=null;this.pending=null;this.retryAt=0;this.error=null;this.attemptedAt=null;
  }
  async refresh() {
    if(this.pending)return this.pending;
    if(this.now()<this.retryAt)return;
    this.attemptedAt=new Date(this.now()).toISOString();
    this.pending=(async()=>{
      try{
        const response=await this.fetcher('https://api.steamcmd.net/v1/info/343050',{signal:AbortSignal.timeout(8000),headers:{'User-Agent':'FeatherPanel/0.1','Accept':'application/json'}});
        if(!response.ok)throw Error('HTTP '+response.status);
        const chunks=[];let size=0;
        for await(const chunk of response.body){size+=chunk.length;if(size>131072)throw Error('Version metadata too large');chunks.push(Buffer.from(chunk));}
        const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const build=String(data?.data?.['343050']?.depots?.branches?.public?.buildid||'');
        if(!/^[1-9]\d{0,15}$/.test(build))throw Error('Missing public branch build');
        this.cache={latestBuild:build,checkedAt:new Date(this.now()).toISOString()};this.error=null;this.retryAt=this.now()+15*60*1000;
      }catch{this.error='暂时无法检查新版本，稍后会自动重试';this.retryAt=this.now()+60*1000;}
      finally{this.pending=null;}
    })();
    return this.pending;
  }
  async status(installedBuild) {
    await this.refresh();
    const latestBuild=this.cache?.latestBuild||null;
    const comparable=/^[1-9]\d{0,15}$/.test(String(installedBuild))&&latestBuild!==null;
    const available=comparable?BigInt(latestBuild)>BigInt(installedBuild):null;
    return {state:this.error?'unavailable':!comparable?'unknown':available?'available':latestBuild===installedBuild?'current':'ahead',available,installedBuild,latestBuild,checkedAt:this.cache?.checkedAt||null,attemptedAt:this.attemptedAt,nextCheckAt:new Date(this.retryAt).toISOString(),stale:Boolean(this.error&&this.cache),error:this.error,source:'Steam public branch · api.steamcmd.net'};
  }
}
