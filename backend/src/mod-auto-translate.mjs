import { sha } from './core.mjs';
import { translateModFields, translateModText } from './mod-translations.mjs';

const english = text => /[A-Za-z]{2}/.test(text) && !/[\u3400-\u9fff]/.test(text);
const placeholders = text => (text.match(/%(?:\d+\$)?[-+.#\d]*[sdif]|\{[^{}\n]+\}/g) || []).sort();
const numbers = text => (text.match(/\d+(?:\.\d+)?/g) || []).sort();
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
export function translationSegments(text, limit = 450) {
  // Keep separators so paragraph boundaries and whitespace survive translation.
  const parts=[];
  for(const paragraph of text.split(/(\n+)/)) {
    if(!paragraph)continue;
    let chunk='';
    for(const token of paragraph.split(/(\s+)/)) {
      if(Buffer.byteLength(chunk+token)>limit && chunk){parts.push(chunk);chunk='';}
      for(const char of token){if(Buffer.byteLength(chunk+char)>limit){parts.push(chunk);chunk='';}chunk+=char;}
    }
    if(chunk)parts.push(chunk);
  }
  return parts;
}

export class ModAutoTranslate {
  constructor(store) {
    this.db=store.db;this.config=store.config;this.fetch=fetch;this.jobs=new Map();this.queue=[];this.running=false;this.closed=false;
    this.abort=new AbortController();this.provider=this.config.translationProvider;
    this.enabled=['mymemory','libretranslate'].includes(this.provider);
    this.engine=this.provider+':'+(this.provider==='libretranslate'?this.config.translationURL:'v1')+':en:zh-CN';
    this.db.exec(`CREATE TABLE IF NOT EXISTS mod_translations(engine TEXT NOT NULL, hash TEXT NOT NULL, source TEXT NOT NULL, translated TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY(engine,hash));
      CREATE TABLE IF NOT EXISTS translation_meta(engine TEXT PRIMARY KEY, cooldown INTEGER NOT NULL);`);
    this.cooldown=Number(this.db.prepare('SELECT cooldown FROM translation_meta WHERE engine=?').get(this.engine)?.cooldown)||0;
  }
  cached(text){return this.db.prepare('SELECT translated FROM mod_translations WHERE engine=? AND hash=? AND source=?').get(this.engine,sha(text),text)?.translated;}
  fields(raw,{retry=false}={}) {
    const fields=translateModFields(raw),sources=new Set();let translated=0,pending=0,failed=0;
    const apply=text=>{
      if(!text||!english(text)||translateModText(text)!==text)return translateModText(text);
      sources.add(text);return this.cached(text)||text;
    };
    for(const field of fields){field.label=apply(field.originalLabel);field.hover=apply(field.originalHover);for(const option of field.options)option.description=apply(option.originalDescription);}
    for(const text of sources){
      if(this.cached(text)){translated++;continue;}
      let job=this.jobs.get(text);
      if(retry&&job?.state==='failed'&&this.cooldown<=Date.now()){this.jobs.delete(text);job=null;}
      if(this.enabled&&!this.closed&&!job&&this.cooldown<=Date.now()&&this.jobs.size<4000){
        if(text.length>16384){job={state:'failed',error:'说明过长，保留原文'};this.jobs.set(text,job);}
        else {job={state:'pending'};this.jobs.set(text,job);this.queue.push(text);}
      }
      if(job?.state==='pending')pending++;else failed++;
    }
    if(this.queue.length&&!this.running)void this.work();
    const limited=this.cooldown>Date.now();
    return {fields,translation:{provider:this.provider,enabled:this.enabled,total:sources.size,translated,pending,failed,
      state:pending?'pending':limited&&failed?'limited':!this.enabled&&failed?'disabled':failed?'partial':'complete',
      retryAt:limited?new Date(this.cooldown).toISOString():null,
      message:pending?'正在自动汉化，配置可以照常修改':limited&&failed?'翻译服务暂时限流，未完成内容保留原文':!this.enabled&&failed?'自动翻译未启用，未收录内容保留原文':failed?'部分内容翻译失败，保留原文，可重试':sources.size?'自动汉化已完成，可悬停查看原文':''}};
  }
  async segment(text) {
    if(!text.trim()||!/[A-Za-z]{2}/.test(text))return text;
    const leading=text.match(/^\s*/)[0],trailing=text.match(/\s*$/)[0],source=text.trim();
    let url,options={signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(10000)]),redirect:'error'};
    if(this.provider==='libretranslate'){
      if(!this.config.translationURL)throw Error('未配置翻译服务地址');
      url=new URL('translate',this.config.translationURL.replace(/\/?$/,'/'));
      options={...options,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({q:source,source:'en',target:'zh',format:'text',...(this.config.translationKey?{api_key:this.config.translationKey}:{})})};
    }else{url=new URL('https://api.mymemory.translated.net/get');url.searchParams.set('q',source);url.searchParams.set('langpair','en|zh-CN');}
    const response=await this.fetch(url,options);
    if([403,429].includes(response.status)){const error=Error('翻译服务限流');error.limited=true;throw error;}
    if(!response.ok)throw Error('翻译服务暂不可用');
    const data=await response.json();
    if(data.quotaFinished||Number(data.responseStatus)===429){const error=Error('翻译额度已用完');error.limited=true;throw error;}
    if(this.provider==='mymemory'&&Number(data.responseStatus)!==200)throw Error('翻译服务未返回有效结果');
    const value=this.provider==='libretranslate'?data.translatedText:data.responseData?.translatedText;
    if(typeof value!=='string'||!value.trim()||value.length>source.length*8+500||!same(numbers(source),numbers(value))||!same(placeholders(source),placeholders(value)))throw Error('译文未通过数值或占位符核对');
    if(english(source)&&!/[\u3400-\u9fff]/.test(value))throw Error('服务未返回中文译文');
    return leading+value.trim()+trailing;
  }
  async work(){
    this.running=true;
    try{while(this.queue.length&&!this.closed){
      const text=this.queue.shift(),job=this.jobs.get(text);
      if(this.cooldown>Date.now()){job.state='failed';continue;}
      try{
        const output=[];for(const part of translationSegments(text)){if(this.closed)return;output.push(await this.segment(part));}
        const translated=output.join('');if(!same(numbers(text),numbers(translated))||!same(placeholders(text),placeholders(translated)))throw Error('译文校验失败');
        if(this.closed)return;
        this.db.prepare('INSERT OR REPLACE INTO mod_translations VALUES(?,?,?,?,?)').run(this.engine,sha(text),text,translated,new Date().toISOString());
        this.jobs.delete(text);
      }catch(error){
        if(this.closed)return;
        job.state='failed';job.error=error.message;
        if(error.limited){this.cooldown=Date.now()+3600000;this.db.prepare('INSERT OR REPLACE INTO translation_meta VALUES(?,?)').run(this.engine,this.cooldown);}
      }
      if(this.queue.length&&!this.closed)await new Promise(resolve=>setTimeout(resolve,200));
    }}finally{this.running=false;}
  }
  close(){this.closed=true;this.queue.length=0;this.abort.abort();}
}
