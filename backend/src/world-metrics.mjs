import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Read kernel counters for the managed game processes only. No Lua collection,
// child benchmark or additional monitoring service is needed.
export function processCounters(text) {
  const end = text.lastIndexOf(')'), fields = text.slice(end + 2).trim().split(/\s+/);
  if (end < 0 || fields.length < 22) throw Error('Invalid process counters');
  const ticks = Number(fields[11]) + Number(fields[12]), started = fields[19];
  if (!Number.isFinite(ticks) || !/^\d+$/.test(started)) throw Error('Invalid process counters');
  return {ticks, started};
}
export class WorldMetrics {
  constructor({proc = '/proc', cgroup = '/sys/fs/cgroup', now = Date.now, memoryTotal = () => os.totalmem(), platform = process.platform} = {}) {
    this.proc = proc; this.cgroup = cgroup; this.now = now; this.memoryTotal = memoryTotal; this.platform = platform; this.samples = new Map();
  }
  memoryLimit() {
    const limits = [this.memoryTotal()];
    for (const file of ['memory.max', 'memory/memory.limit_in_bytes']) {
      try { const value = Number(fs.readFileSync(path.join(this.cgroup, file), 'utf8').trim()); if (value > 0 && Number.isFinite(value)) limits.push(value); } catch {}
    }
    return Math.min(...limits);
  }
  sample(id, worlds, game) {
    const now = this.now(), sampledAt = new Date(now).toISOString(), memoryLimitBytes = this.memoryLimit();
    const empty = world => ({available:!world.running, cpuPercent:world.running?null:0, memoryBytes:world.running?null:0, memoryPercent:world.running?null:0, memoryLimitBytes, sampledAt, processCount:0});
    if (this.platform !== 'linux') return worlds.map(world => ({...world, resources:empty(world)}));
    const previous = this.samples.get(String(id));
    // Repeated overview / resource requests share a sampling window.
    const signature = worlds.map(world => world.directory + ':' + world.running).join('|');
    if (previous && previous.signature === signature && now - previous.time < 700) return worlds.map(world => ({...world, resources:previous.resources.get(world.directory)}));
    const processes = new Map(worlds.map(world => [world.directory, []]));
    let total, cores;
    try {
      const stat = fs.readFileSync(path.join(this.proc, 'stat'), 'utf8');
      total = stat.split('\n')[0].trim().split(/\s+/).slice(1, 9).reduce((sum, value) => sum + Number(value), 0);
      cores = stat.split('\n').filter(line => /^cpu\d+\s/.test(line)).length;
      if (!Number.isFinite(total) || !cores) throw Error('CPU counters unavailable');
      const binaries = new Set([path.join(game, 'bin/dontstarve_dedicated_server_nullrenderer'), path.join(game, 'bin64/dontstarve_dedicated_server_nullrenderer_x64')]);
      for (const pid of fs.readdirSync(this.proc).filter(name => /^\d+$/.test(name))) {
        try {
          const directory = path.join(this.proc, pid), argv = fs.readFileSync(path.join(directory, 'cmdline'), 'utf8').split('\0');
          if (!binaries.has(argv[0])) continue;
          const clusterIndex = argv.indexOf('-cluster'), shardIndex = argv.indexOf('-shard');
          if (clusterIndex < 0 || argv[clusterIndex + 1] !== 'Feather_' + id || shardIndex < 0) continue;
          const target = processes.get(argv[shardIndex + 1]); if (!target) continue;
          const counter = processCounters(fs.readFileSync(path.join(directory, 'stat'), 'utf8'));
          const status = fs.readFileSync(path.join(directory, 'status'), 'utf8');
          const rss = status.match(/^VmRSS:\s+(\d+)\s+kB$/m); if (!rss) continue;
          target.push({identity:pid + ':' + counter.started, ticks:counter.ticks, memoryBytes:Number(rss[1]) * 1024});
        } catch { /* Process may exit between directory and counter reads. */ }
      }
    } catch { return worlds.map(world => ({...world, resources:empty(world)})); }
    const resources = new Map(), counters = new Map();
    const elapsed = previous ? (total - previous.total) / cores : 0;
    for (const world of worlds) {
      const rows = world.running ? processes.get(world.directory) : [];
      const old = previous?.counters.get(world.directory);
      const memoryBytes = rows.reduce((sum, row) => sum + row.memoryBytes, 0);
      const sameProcesses = rows.length > 0 && old?.size === rows.length && rows.every(row => old.has(row.identity) && row.ticks >= old.get(row.identity));
      const cpuPercent = sameProcesses && elapsed > 0 ? Math.round(rows.reduce((sum, row) => sum + row.ticks - old.get(row.identity), 0) / elapsed * 1000) / 10 : null;
      counters.set(world.directory, new Map(rows.map(row => [row.identity, row.ticks])));
      resources.set(world.directory, rows.length ? {available:true, cpuPercent, memoryBytes, memoryPercent:Math.round(memoryBytes / memoryLimitBytes * 1000) / 10, memoryLimitBytes, sampledAt, processCount:rows.length} : empty(world));
    }
    this.samples.set(String(id), {time:now, total, counters, resources, signature});
    if (this.samples.size > 100) this.samples.delete(this.samples.keys().next().value);
    return worlds.map(world => ({...world, resources:resources.get(world.directory)}));
  }
}
