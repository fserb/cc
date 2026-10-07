// What each instance costs: its own process and everything under it, summed. Draws nothing.

// root pid -> {cpu, rss, procs}, the root among its procs, out of processes()'s table of
// pid -> [ppid, cmd, cpu, rss]. A process goes to its NEAREST root ancestor, so a claude
// under another claude's Bash tool is counted once, by whichever of the two is listed
// closer to it. cpu is ps's %cpu, on macOS a decaying average over roughly the last
// minute, not an instant. rss is KB, and summed over a tree it counts shared pages once
// per process, so it reads high against Activity Monitor
export function treeUsage(roots, table) {
  const out = new Map(roots.map((r) => [r, {cpu: 0, rss: 0, procs: 0}]));
  for (const [pid, [, , cpu, rss]] of table) {
    let cur = pid;
    for (let n = 0; n < 64 && cur > 1 && !out.has(cur); n++) cur = table.get(cur)?.[0] ?? 0;
    const sum = out.get(cur);
    if (!sum) continue;
    sum.cpu += cpu;
    sum.rss += rss;
    sum.procs++;
  }
  return out;
}

export function fmtMem(kb) {
  if (kb < 1024) return `${kb}K`;
  if (kb < 1024 * 1024) return `${Math.round(kb / 1024)}M`;
  return `${(kb / 1024 / 1024).toFixed(1)}G`;
}
