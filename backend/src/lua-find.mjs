// A bounded subset of Lua 5.1 patterns, deliberately separate from JS RegExp.
// Every matching operation shares the modinfo evaluator's computation budget.
export function findLua(source,pattern,start=1,plain=false,step=()=>{}) {
  source=String(source);pattern=String(pattern);start=Math.trunc(Number(start));
  if(!Number.isFinite(start))throw Error('字符串查找起点无效');
  start=Math.max(0,start<0?source.length+start:start-1);
  if(start>source.length)return null;
  if(plain||!/[\^$().%\[\]*+?\-]/.test(pattern)){
    const at=source.indexOf(pattern,start);return at<0?null:[at+1,at+pattern.length];
  }
  if(pattern.length>256)throw Error('模组配置查找模式过长');
  const classes={a:c=>/[a-z]/i.test(c),c:c=>/[\x00-\x1f\x7f]/.test(c),d:c=>/[0-9]/.test(c),l:c=>/[a-z]/.test(c),p:c=>/[!-/:-@\[-`{-~]/.test(c),s:c=>/[\t-\r ]/.test(c),u:c=>/[A-Z]/.test(c),w:c=>/[a-z0-9]/i.test(c),x:c=>/[a-f0-9]/i.test(c),z:c=>c==='\0'};
  let at=0;const anchored=pattern[at]==='^';if(anchored)at++;
  const tokens=[];
  function atom(){
    const value=pattern[at++];
    if(value===undefined)throw Error('模组配置查找模式不完整');
    if(value==='%'){
      const code=pattern[at++];if(code===undefined)throw Error('模组配置查找模式不完整');
      const test=classes[code.toLowerCase()];
      if(test)return c=>code===code.toLowerCase()?test(c):!test(c);
      if(/[a-z0-9]/i.test(code))throw Error('暂不支持此 Lua 查找模式：%'+code);
      return c=>c===code;
    }
    if(value==='['){
      const negate=pattern[at]==='^';if(negate)at++;
      const tests=[];
      if(pattern[at]===']'){at++;tests.push(c=>c===']');}
      while(at<pattern.length&&pattern[at]!==']'){
        if(pattern[at]==='%'){tests.push(atom());continue;}
        const first=pattern[at++];
        if(pattern[at]==='-'&&at+1<pattern.length&&pattern[at+1]!==']'){
          at++;const last=pattern[at++];tests.push(c=>c>=first&&c<=last);
        }else tests.push(c=>c===first);
      }
      if(pattern[at++]!==']')throw Error('模组配置查找字符集未闭合');
      return c=>negate?!tests.some(test=>test(c)):tests.some(test=>test(c));
    }
    if(value==='('||value===')')throw Error('暂不支持 Lua 查找捕获组');
    return value==='.'?()=>true:c=>c===value;
  }
  while(at<pattern.length){
    if(pattern[at]==='$'&&at===pattern.length-1){tokens.push({end:true});at++;break;}
    const test=atom(),quantifier=/^[*+?\-]$/.test(pattern[at]||'')?pattern[at++]:'';
    tokens.push({test,quantifier});
  }
  const memo=new Map();
  function match(index,pos){
    step();const key=index+':'+pos;if(memo.has(key))return memo.get(key);
    let result=null;
    if(index===tokens.length)result=pos;
    else{
      const token=tokens[index];
      if(token.end)result=pos===source.length?pos:null;
      else if(!token.quantifier){if(pos<source.length&&token.test(source[pos]))result=match(index+1,pos+1);}
      else{
        let end=pos;
        while(end<source.length&&token.test(source[end])&&(token.quantifier!=='?'||end===pos)){step();end++;}
        const minimum=pos+(token.quantifier==='+'?1:0);
        if(token.quantifier==='-'){for(let next=minimum;next<=end;next++){result=match(index+1,next);if(result!==null)break;}}
        else for(let next=end;next>=minimum;next--){result=match(index+1,next);if(result!==null)break;}
      }
    }
    memo.set(key,result);return result;
  }
  for(let pos=start;pos<=source.length;pos++){
    const end=match(0,pos);if(end!==null)return [pos+1,end];if(anchored)break;
  }
  return null;
}
