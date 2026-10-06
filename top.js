// What each instance costs: its own process and everything under it, summed. Draws nothing.
import {sh} from "./sh.js";

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/;

// pid -> {pid, ppid, cpu, rss, cmd}. cpu is ps's %cpu, which on macOS is a decaying average
// over roughly the last minute, not an instant; rss is in KB
export async function processTable() {
  const table = new Map();
  for (const line of (await sh("ps", "-axo", "pid=,ppid=,%cpu=,rss=,command=")).split("\n")) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    table.set(pid, {pid, ppid: Number(m[2]), cpu: Number(m[3]), rss: Number(m[4]), cmd: m[5]});
  }
  return table;
}

// root pid -> {cpu, rss, procs}, the root among its procs. A process
// goes to its NEAREST root ancestor, so a claude under another claude's Bash tool is
// counted once, by whichever of the two is listed closer to it. RSS summed over a tree
// counts shared pages once per process, so it reads high against Activity Monitor
export function treeUsage(roots, table) {
  const out = new Map(roots.map((r) => [r, {cpu: 0, rss: 0, procs: []}]));
  for (const p of table.values()) {
    let cur = p.pid;
    for (let n = 0; n < 64 && cur > 1 && !out.has(cur); n++) cur = table.get(cur)?.ppid ?? 0;
    const sum = out.get(cur);
    if (!sum) continue;
    sum.cpu += p.cpu;
    sum.rss += p.rss;
    sum.procs.push(p);
  }
  return out;
}

export function fmtMem(kb) {
  if (kb < 1024) return `${kb}K`;
  if (kb < 1024 * 1024) return `${Math.round(kb / 1024)}M`;
  return `${(kb / 1024 / 1024).toFixed(1)}G`;
}
