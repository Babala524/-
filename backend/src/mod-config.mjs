// Bounded evaluator for modinfo data construction. No Lua VM, filesystem,
// network, host objects, dynamic loading, metatables or arbitrary JS calls.
import {findLua} from './lua-find.mjs';
export function evaluateModInfo(ast, readLiteral, locale='zh',folderName='workshop') {
  let budget=250000,depth=0;
  const step=()=>{if(--budget<0)throw Error('模组配置计算超过限制');};
  const text=value=>value===null||value===undefined?'nil':String(value);
  const truth=value=>value!==false&&value!==null&&value!==undefined;
  const globals=new Map([['locale',locale],['folder_name',folderName],['version','']]);
  const scope=(parent=null)=>({values:new Map(),parent});
  const root=scope();root.values=globals;
  const lookup=(env,name)=>env.values.has(name)?env.values.get(name):env.parent?lookup(env.parent,name):null;
  const write=(env,name,value,local=false)=>{if(local){env.values.set(name,value);return;}let target=env;while(target.parent&&!target.values.has(name))target=target.parent;target.values.set(name,value);};
  const table=value=>{if(!(value instanceof Map))throw Error('配置需要 Lua 表');return value;};
  const get=(value,key)=>typeof value==='string'?(typeof key==='string'?globals.get('string')?.get(key)??null:null):table(value).get(key)??null;
  const size=value=>{if(typeof value==='string')return value.length;table(value);let n=0;while(value.has(n+1))n++;return n;};
  const limited=value=>{if(typeof value==='string'&&value.length>262144)throw Error('模组配置文本超过限制');if(typeof value==='number'&&!Number.isFinite(value))throw Error('模组配置数值无效');return value;};
  const safe=(fn)=>({safe:fn});
  const multiple=values=>({results:values});
  const first=value=>value?.results?value.results[0]??null:value;
  globals.set('tostring',safe(text));globals.set('tonumber',safe(value=>Number.isFinite(Number(value))?Number(value):null));
  globals.set('type',safe(value=>value===null?'nil':value instanceof Map?'table':value?.safe||value?.body?'function':typeof value));
  globals.set('ChooseTranslationTable',safe(value=>get(value,locale)??get(value,'en')??get(value,1)));
  globals.set('ipairs',safe(value=>({iteration:[...table(value)].filter(([key])=>Number.isInteger(key)&&key>=1&&key<=size(value)).sort((a,b)=>a[0]-b[0])})));
  globals.set('pairs',safe(value=>({iteration:[...table(value)]})));
  globals.set('table',new Map([
    ['insert',safe((value,index,item)=>{table(value);const n=size(value);if(n>=10000)throw Error('配置选项过多');if(item===undefined){item=index;index=n+1;}if(!Number.isInteger(index)||index<1||index>n+1)throw Error('配置索引无效');for(let i=n;i>=index;i--)value.set(i+1,value.get(i));value.set(index,item);return null;})],
    ['concat',safe((value,separator='')=>limited(Array.from({length:size(value)},(_,i)=>text(get(value,i+1))).join(separator)))]
  ]));
  globals.set('math',new Map(['floor','ceil','abs','min','max'].map(name=>[name,safe((...args)=>Math[name](...args))])));
  globals.set('string',new Map([
    ['find',safe((value,pattern,start=1,plain=false)=>multiple(findLua(text(value),text(pattern),start,truth(plain),step)??[]))],
    ['len',safe(value=>text(value).length)],['lower',safe(value=>text(value).toLowerCase())],['upper',safe(value=>text(value).toUpperCase())],
    ['sub',safe((value,start=1,end=-1)=>{const source=text(value),n=source.length;start=Number(start);end=Number(end);return source.slice(Math.max(start<0?n+start:start-1,0),Math.max(0,Math.min(end<0?n+end+1:end,n)));})],
    ['format',safe((pattern,...args)=>{let index=0;return limited(text(pattern).replace(/%([0-9]{0,3})(?:\.([0-9]{1,2}))?([sdfq%])/g,(_,width,precision,kind)=>{if(kind==='%')return '%';const value=args[index++];let result=kind==='d'?String(Math.trunc(Number(value))):kind==='f'?Number(value).toFixed(Math.min(precision===undefined?6:Number(precision),20)):kind==='q'?JSON.stringify(text(value)):text(value);return result.padStart(Math.min(Number(width)||0,100),' ');}));})]
  ]));
  function invoke(fn,args) {
    step();if(++depth>48){depth--;throw Error('模组配置调用过深');}
    try{
      if(fn?.safe)return limited(fn.safe(...args));
      if(!fn?.body)throw Error('模组配置调用了不支持的函数');
      const env=scope(fn.env);fn.parameters.forEach((arg,i)=>{if(arg.type!=='Identifier')throw Error('暂不支持变长配置函数');env.values.set(arg.name,args[i]??null);});
      return block(fn.body,env)?.value??null;
    }finally{depth--;}
  }
  function evaluate(node,env,many=false) {
    step();if(!node)return null;
    if(/^(String|Numeric|Boolean|Nil)Literal$/.test(node.type))return readLiteral(node);
    if(node.type==='Identifier')return lookup(env,node.name);
    if(node.type==='TableConstructorExpression'){
      const value=new Map();let index=0;for(const field of node.fields){const key=field.type==='TableValue'?++index:field.type==='TableKeyString'?field.key.name:evaluate(field.key,env);value.set(key,evaluate(field.value,env));}return value;
    }
    if(node.type==='MemberExpression')return get(evaluate(node.base,env),node.identifier.name);
    if(node.type==='IndexExpression')return get(evaluate(node.base,env),evaluate(node.index,env));
    if(node.type==='UnaryExpression'){
      const value=evaluate(node.argument,env);
      if(node.operator==='not')return !truth(value);
      if(node.operator==='#')return size(value);
      if(node.operator==='-')return limited(-Number(value));
    }
    if(node.type==='LogicalExpression'){const left=evaluate(node.left,env);return node.operator==='and'?(truth(left)?evaluate(node.right,env):left):(truth(left)?left:evaluate(node.right,env));}
    if(node.type==='BinaryExpression'){
      const left=evaluate(node.left,env),right=evaluate(node.right,env);
      switch(node.operator){
        case '..':return limited(text(left)+text(right));
        case '==':return left===right;case '~=':return left!==right;
        case '<':return left<right;case '>':return left>right;case '<=':return left<=right;case '>=':return left>=right;
        case '+':return limited(Number(left)+Number(right));case '-':return limited(Number(left)-Number(right));
        case '*':return limited(Number(left)*Number(right));case '/':return limited(Number(left)/Number(right));
        case '%':return limited(((Number(left)%Number(right))+Number(right))%Number(right));case '^':return limited(Number(left)**Number(right));
      }
    }
    if(node.type==='FunctionDeclaration')return {parameters:node.parameters,body:node.body,env};
    if(['CallExpression','TableCallExpression','StringCallExpression'].includes(node.type)){
      const args=node.type==='CallExpression'?list(node.arguments,env):[evaluate(node.type==='TableCallExpression'?node.arguments:node.argument,env)];
      if(node.base.type==='MemberExpression'&&node.base.indexer===':')args.unshift(evaluate(node.base.base,env));
      const result=invoke(evaluate(node.base,env),args);return many?result:first(result);
    }
    throw Error('暂不支持的模组配置表达式：'+node.type);
  }
  function list(nodes,env){
    return nodes.flatMap((node,index)=>{const value=evaluate(node,env,index===nodes.length-1);return value?.results?value.results:[value];});
  }
  function assign(node,value,env,local=false) {
    if(node.type==='Identifier')return write(env,node.name,value,local);
    if(node.type==='IndexExpression'||node.type==='MemberExpression'){
      const target=table(evaluate(node.base,env)),key=node.type==='IndexExpression'?evaluate(node.index,env):node.identifier.name;
      if(target.size>=20000&&!target.has(key))throw Error('配置表超过限制');target.set(key,value);return;
    }
    throw Error('模组配置赋值无效');
  }
  function block(body,env){
    for(const node of body){
      step();
      if(node.type==='LocalStatement'||node.type==='AssignmentStatement'){const values=list(node.init,env);node.variables.forEach((item,i)=>assign(item,values[i]??null,env,node.type==='LocalStatement'));}
      else if(node.type==='FunctionDeclaration')assign(node.identifier,{parameters:node.parameters,body:node.body,env},env,node.isLocal);
      else if(node.type==='CallStatement')evaluate(node.expression,env);
      else if(node.type==='ReturnStatement')return {kind:'return',value:multiple(list(node.arguments,env))};
      else if(node.type==='BreakStatement')return {kind:'break'};
      else if(node.type==='IfStatement'){for(const clause of node.clauses)if(!clause.condition||truth(evaluate(clause.condition,env))){const result=block(clause.body,scope(env));if(result)return result;break;}}
      else if(node.type==='DoStatement'){const result=block(node.body,scope(env));if(result)return result;}
      else if(node.type==='ForNumericStatement'){
        const start=Number(evaluate(node.start,env)),end=Number(evaluate(node.end,env)),increment=node.step?Number(evaluate(node.step,env)):1;
        if(!Number.isFinite(start)||!Number.isFinite(end)||!Number.isFinite(increment)||increment===0||Math.abs((end-start)/increment)>10000)throw Error('模组配置循环超出限制');
        for(let value=start;increment>0?value<=end:value>=end;value+=increment){step();const loop=scope(env);loop.values.set(node.variable.name,value);const result=block(node.body,loop);if(result?.kind==='return')return result;if(result?.kind==='break')break;}
      }else if(node.type==='ForGenericStatement'){
        const [iterable,state,initial]=list(node.iterators,env);
        if(iterable?.iteration){
          if(iterable.iteration.length>10000)throw Error('模组配置迭代超出限制');
          for(const entry of iterable.iteration){step();const loop=scope(env);node.variables.forEach((item,i)=>loop.values.set(item.name,entry[i]??null));const result=block(node.body,loop);if(result?.kind==='return')return result;if(result?.kind==='break')break;}
        }else if(iterable?.body||iterable?.safe){
          let control=initial;
          for(let count=0;;count++){
            step();if(count>=10000)throw Error('模组配置迭代超出限制');
            const returned=invoke(iterable,[state,control]),entry=returned?.results??[returned];
            control=entry[0];if(control===null||control===undefined)break;
            const loop=scope(env);node.variables.forEach((item,i)=>loop.values.set(item.name,entry[i]??null));
            const result=block(node.body,loop);if(result?.kind==='return')return result;if(result?.kind==='break')break;
          }
        }else throw Error('模组配置迭代不支持');
      }else throw Error('暂不支持的模组配置语句：'+node.type);
    }
  }
  block(ast.body,root);
  function convert(value,parents=new Set()){
    step();if(value instanceof Map){if(parents.has(value)||parents.size>32)throw Error('模组配置包含循环表');const next=new Set(parents);next.add(value);const n=size(value),array=value.size===n;if(array)return Array.from({length:n},(_,i)=>convert(value.get(i+1),next));return Object.fromEntries([...value].map(([key,item])=>[String(key),convert(item,next)]));}
    if(value?.body||value?.safe)return null;return value;
  }
  return convert(globals.get('configuration_options')??[]);
}

