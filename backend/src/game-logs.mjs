import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';

function entry(buffer, type, partial = false) {
  // Do not manufacture a replacement character when the game is halfway
  // through writing a UTF-8 character at the end of the file.
  const text = partial ? new StringDecoder('utf8').write(buffer) : buffer.toString('utf8');
  const line = stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  if (!line.trim()) return null;
  const stamp = line.match(/^\[(\d{2,}:\d{2}:\d{2}(?:\.\d+)?)\]:?[ \t]?/);
  const message = stamp ? line.slice(stamp[0].length) : line;
  if (type === 'game') {
    // Filter only the panel's own console queries and replies. Lua errors,
    // stack traces, player chat and ordinary console commands stay visible.
    if (/^\s*FP_[a-f0-9]{20}(?:\s|$)/.test(message)) return null;
    if (/^RemoteCommandInput:/.test(message) &&
        (/FEATHER_TELEMETRY|FP_[a-f0-9]{20}/.test(message) ||
         /local mapassets;|local p=\{\} for _,v in ipairs\(GetPlayerClientTable\(\)/.test(message))) return null;
  }
  return { time: stamp?.[1] || '', message };
}

export function readGameLog(file, type = 'game', { limit = 500, maxBytes = 8 * 1048576, chunkBytes = 65536 } = {}) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return [];
    let position = stat.size, remaining = maxBytes, pending = Buffer.alloc(0), atEnd = true;
    const rows = [];
    // Scan backwards until we have enough *useful* rows. Keep incomplete
    // leading bytes as a Buffer across reads, never as a decoded fragment.
    while (position > 0 && remaining > 0 && rows.length < limit) {
      const count = Math.min(position, remaining, chunkBytes), buffer = Buffer.allocUnsafe(count);
      position -= count; remaining -= count;
      const read = fs.readSync(fd, buffer, 0, count, position);
      const block = Buffer.concat([buffer.subarray(0, read), pending]);
      let end = block.length;
      for (let i = block.length - 1; i >= 0 && rows.length < limit; i--) {
        if (block[i] !== 10) continue;
        const row = entry(block.subarray(i + 1, end), type, atEnd);
        if (row) rows.push(row);
        atEnd = false; end = i;
      }
      pending = block.subarray(0, end);
    }
    // At the scan limit the leading line is incomplete and must be dropped.
    if (position === 0 && rows.length < limit) {
      const row = entry(pending, type, atEnd);
      if (row) rows.push(row);
    }
    return rows.reverse();
  } finally { fs.closeSync(fd); }
}
