// Read only direct fields of the saved map table. Hamlet stores indoor rooms
// (with their own width/height/tiles) both before and inside this table.
// This bounded lexical scan avoids building an AST for multi-megabyte saves
// and never evaluates Lua or follows saved function references.
export function savedMapFields(source) {
  const header = /tablefunctions\s*\[\s*["']map_fn["']\s*\]\s*=\s*function\s*\(\s*\)\s*return\s*\{/.exec(source);
  const legacy = header ? null : /^\s*(?:local\s+savedata\s*=\s*|return\s*)\{/.exec(source);
  if (!header && !legacy) return null;
  const opening = header || legacy;
  const fields=directFields(source, opening.index + opening[0].length - 1);
  if(!header&&!fields?.tiles&&fields?.map?.startsWith('{'))return directFields(fields.map,0);
  return fields;
}

function directFields(source, start) {
  const wanted = new Set(['width', 'height', 'tiles', 'world_tile_map', 'roads', 'map']);
  const result = Object.create(null), stack = ['}'];
  let fieldStart = start + 1;
  const record = end => {
    const field = source.slice(fieldStart, end);
    const match = /^\s*(?:([a-zA-Z_]\w*)|\[\s*["']([a-zA-Z_]\w*)["']\s*\])\s*=\s*/.exec(field);
    const key = match?.[1] || match?.[2];
    if (wanted.has(key)) result[key] = field.slice(match[0].length).trim();
  };
  for (let at = start + 1; at < source.length; at++) {
    const ch = source[at];
    if (ch === '"' || ch === "'") {
      let next = at + 1;
      for (; next < source.length; next++) {
        if (source[next] === '\\') next++;
        else if (source[next] === ch) break;
      }
      if (next >= source.length) return null;
      at = next; continue;
    }
    const comment = ch === '-' && source[at + 1] === '-';
    const longStart = comment ? at + 2 : at;
    if (source[longStart] === '[') {
      const match = /^\[(=*)\[/.exec(source.slice(longStart, longStart + 128));
      if (match) {
        const end = source.indexOf(']' + match[1] + ']', longStart + match[0].length);
        if (end === -1) return null;
        at = end + match[0].length - 1;
        if (comment && !source.slice(fieldStart, longStart - 2).trim()) fieldStart = at + 1;
        continue;
      }
    }
    if (comment) {
      const end = source.indexOf('\n', at + 2);
      if (end === -1) return null;
      if (!source.slice(fieldStart, at).trim()) fieldStart = end + 1;
      at = end; continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') { if(stack.length>=512)return null;stack.push(ch === '{' ? '}' : ch === '[' ? ']' : ')'); continue; }
    if (ch === '}' || ch === ']' || ch === ')') {
      if (ch !== stack.pop()) return null;
      if (!stack.length) { record(at); return result; }
    } else if (stack.length === 1 && (ch === ',' || ch === ';')) { record(at); fieldStart = at + 1; }
  }
  return null;
}
