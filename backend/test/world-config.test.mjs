import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { levelData } from '../src/lua.mjs';

const bundle = fs.readFileSync(new URL('../../vendor/dmp-browser.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const context = vm.createContext({window:{}});
vm.runInContext(bundle, context);
const dmp = context.window.FeatherDmp;

test('inline and vendored world validators are identical and all DMP presets pass both validators', () => {
  const marker = '// FeatherPanel: validate static world data';
  const section = source => source.slice(source.indexOf(marker), source.indexOf('\n})();', source.indexOf(marker)));
  assert.equal(section(html), section(bundle));
  for (const mode of Object.values(dmp.presets)) for (const source of Object.values(mode)) {
    if (typeof source !== 'string') continue;
    assert.ok(dmp.validateLevelData(source).entries.length);
    assert.ok(levelData(source).overrides);
  }
});

test('world code keeps custom keys, nested data, comments and empty default overrides', () => {
  const source = '-- 玩家世界\nreturn {location="forest", custom={note="保留", offsets={-1, 2}}, overrides={ -- 资源\n season_start="default", custom_mod={enabled=true, amount=3}}}';
  assert.equal(dmp.validateLevelData(source).entries.length, 2);
  const changed = dmp.replaceLevelDataOverride(source, 'season_start', 'string', 'winter');
  assert.equal(changed, source.replace('season_start="default"', 'season_start="winter"'));
  assert.equal(levelData(changed).overrides.season_start, 'winter');
  assert.equal(levelData(changed).custom.note, '保留');
  assert.equal(dmp.validateLevelData('return {overrides={}}').entries.length, 0);
  assert.ok(levelData('return {overrides={}}').overrides);
});

test('world diagnostics reject syntax errors and executable Lua with useful source locations', () => {
  assert.throws(() => dmp.validateLevelData('return {\n overrides = { day = "default" \n'), error => error.line >= 2 && error.column >= 1);
  const cases = [
    'return {}',
    'return {overrides=false}',
    'local a = 1; return {overrides={}}',
    'return {overrides={x=os.execute("bad")}}',
    'return {overrides={x=function() return true end}}',
    'return {overrides={x=1+2}}',
    'return {overrides={x=1e9999}}',
    'return {overrides={}, overrides={x=true}}',
    'return {overrides={x=true, ["x"]=false}}',
  ];
  for (const source of cases) assert.throws(() => dmp.validateLevelData(source), error => !!error.line && !!error.column);
  assert.throws(() => dmp.validateLevelData(' '.repeat(262145)), /262144/);
  const nested = 'return {overrides={x=' + '{'.repeat(105) + '}' .repeat(105) + '}}';
  assert.throws(() => dmp.validateLevelData(nested), /嵌套过深/);
});
