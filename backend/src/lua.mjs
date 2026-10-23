import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { root, demand } from './core.mjs';
import { evaluateModInfo } from './mod-config.mjs';

// The vendored MIT parser parses Lua as data; user-supplied Lua is never executed.
const context = vm.createContext({ window: {} });
const source = fs.readFileSync(path.join(root, 'vendor/dmp-browser.js'), 'utf8').replace('window.FeatherDmp={', 'window.FeatherDmp={luaparse,');
vm.runInContext(source, context, { timeout: 5000 });
export const presets = context.window.FeatherDmp.presets;
const parser = context.window.FeatherDmp.luaparse;
export function parseLua(source, maxLength = 262144, luaVersion = '5.1') {
  demand(typeof source === 'string' && source.length <= maxLength, 'Lua 配置太大或不是文本');
  try { return parser.parse(source, { ranges: true, luaVersion }); } catch { throw Error('Lua 配置语法不合法'); }
}
function literal(node, source) {
  demand(node, '缺少 Lua 值');
  if (node.type === 'StringLiteral') {
    const raw = node.raw;
    if (/^\[=*[\[]/.test(raw)) { const opening = raw.match(/^\[(=*)\[/)[0]; return raw.slice(opening.length, -opening.length).replace(/^\r?\n/, ''); }
    return raw.slice(1, -1).replace(/\\(\d{1,3}|z\s*|[\s\S])/g, (_, code) => {
      if (/^\d/.test(code)) return String.fromCharCode(Number(code));
      if (code.startsWith('z')) return '';
      return ({ n: '\n', r: '\r', t: '\t', a: '\x07', b: '\b', f: '\f', v: '\v' })[code] ?? code;
    });
  }
  if (['NumericLiteral', 'BooleanLiteral'].includes(node.type)) return node.value;
  if (node.type === 'NilLiteral') return null;
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'NumericLiteral') return -node.argument.value;
  if (node.type === 'TableConstructorExpression') {
    const array = node.fields.every(field => field.type === 'TableValue');
    if (array) return node.fields.map(field => literal(field.value, source));
    const result = Object.create(null);
    node.fields.forEach((field, index) => {
      const key = field.type === 'TableKeyString' ? field.key.name : field.type === 'TableKey' ? literal(field.key, source) : index + 1;
      result[String(key)] = literal(field.value, source);
    });
    return result;
  }
  throw Error('配置包含动态 Lua 表达式，请改用可视化支持的静态值');
}
export function staticLuaTable(source) {
  const ast = parseLua(source);
  demand(ast.body.length === 1 && ast.body[0].type === 'ReturnStatement' && ast.body[0].arguments.length === 1, 'Lua 配置必须只返回一个静态表');
  return literal(ast.body[0].arguments[0], source);
}
// Save entity data can contain references to other save tables. Read only the
// entity's own coordinates and small static state; never evaluate references.
export function savedEntitySummary(source) {
  const ast=parseLua(source,2097152),statement=ast.body[0];
  demand(ast.body.length===1&&statement?.type==='ReturnStatement','实体存档格式无效');
  const table=statement.arguments[0];demand(table?.type==='TableConstructorExpression','实体存档不是列表');
  const result=[];
  for(const field of table.fields){
    if(field.value?.type!=='TableConstructorExpression')continue;
    const values=Object.create(null);
    for(const item of field.value.fields){
      const key=item.type==='TableKeyString'?item.key.name:null;
      if(!['x','z','data'].includes(key))continue;
      try{values[key]=literal(item.value,source);}catch{}
    }
    if(Number.isFinite(values.x)&&Number.isFinite(values.z)){
      const d=values.data||{};result.push({x:values.x,z:values.z,stage:d.growable?.stage,burnt:d.burnt===true,stump:d.stump===true});
    }
    if(result.length>=20000)break;
  }
  return {count:table.fields.filter(field=>field.value?.type==='TableConstructorExpression').length,positions:result};
}
export function savedEntityPositions(source) { return savedEntitySummary(source).positions; }
export function levelData(source) {
  const ast = parseLua(source);
  demand(ast.body.length === 1 && ast.body[0].type === 'ReturnStatement' && ast.body[0].arguments.length === 1, '世界配置必须只返回静态表');
  const data = literal(ast.body[0].arguments[0], source);
  demand(data && typeof data === 'object' && data.overrides && typeof data.overrides === 'object', '世界配置缺少 overrides');
  return data;
}
// Klei's uncompressed persistent-string format has this exact text header.
// Strip only that header; the remaining Lua still passes static-data validation.
export function savedLevelSource(source) {
  demand(typeof source === 'string', '世界配置不是文本');
  const text = source.replace(/^\uFEFF/, '').replace(/^KLEI {5}1 /, '');
  levelData(text);
  return text;
}
export function lua(value) {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') { demand(Number.isFinite(value), '模组配置数字不合法'); return String(value); }
  if (typeof value === 'string') return '"' + value.replace(/[\\"\x00-\x1f\x7f]/g, character => character === '\\' || character === '"' ? '\\' + character : '\\' + character.charCodeAt(0).toString().padStart(3, '0')) + '"';
  demand(value && typeof value === 'object', '不支持的 Lua 值');
  return '{' + (Array.isArray(value) ? value.map(lua) : Object.entries(value).map(([key, item]) => `[${lua(key)}]=${lua(item)}`)).join(',') + '}';
}
export function modFields(source,folderName='workshop') {
  const ast = parseLua(source);
  const assignsOptions=node=>node&&typeof node==='object'&&(
    node.type==='AssignmentStatement'&&node.variables.some(item=>item.type==='Identifier'&&item.name==='configuration_options')||
    Object.values(node).some(value=>Array.isArray(value)?value.some(assignsOptions):value&&typeof value==='object'&&assignsOptions(value))
  );
  if(!assignsOptions(ast))return [];
  const options = evaluateModInfo(ast,node=>literal(node,source),'zh',folderName);
  demand(Array.isArray(options), '模组的配置表不是选项数组');
  return options.filter(option => option && typeof option.name === 'string' && (Array.isArray(option.options) || option.options === null || option.options?.body || option.options?.safe)).map(option => ({
    name: option.name, label: String(option.label || option.name), hover: String(option.hover || ''), default: option.default,
    dynamicOptions: !Array.isArray(option.options),
    options: (Array.isArray(option.options) ? option.options : []).map(choice => ({ description: String(choice.description ?? choice.data ?? ''), data: choice.data }))
  }));
}
