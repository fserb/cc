// The seven-day plan limit, as Claude Code last handed it to its status line. No UI and no
// network: `~/.claude/settings.json` points `statusLine` at a shell line that copies the
// JSON it is given to USAGE whenever that JSON holds a `seven_day`, through a temp file and
// a `mv`, so a reader never sees half of one. Both UIs read it from the poll they already
// run.
//
// Claude Code fills `rate_limits` from the `anthropic-ratelimit-unified-*` headers of its
// own API responses (2.1.289): `used_percentage` is utilization * 100 to one decimal and
// `resets_at` is epoch seconds. Every instance writes the same file, last one wins, and the
// numbers carry no time of their own, so an instance idle since an older response can put
// older numbers back for a moment.

import {HOME} from "./sh.js";
import {PALETTE} from "./view.js";

export const USAGE = `${HOME}/.claude/ccx-usage.json`;
const WEEK = 7 * 24 * 3600_000;
const SETTLE = 3600_000;    // under an hour into a week the average rate is noise
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// {used, resetsAt, at} with both times in ms, `at` being when the file was written, or
// null. Anything missing, unreadable or unparseable reads as no data.
export function readUsage(path = USAGE) {
  try {
    const at = Deno.statSync(path).mtime?.getTime() ?? 0;
    const week = JSON.parse(Deno.readTextFileSync(path))?.rate_limits?.seven_day;
    const used = Number(week?.used_percentage), resets = Number(week?.resets_at);
    if (!Number.isFinite(used) || !Number.isFinite(resets) || !resets) return null;
    return {used, resetsAt: resets * 1000, at};
  } catch {
    return null;
  }
}

// Where the week stands at `now`: `even` is where an even spread over the 7 days would be,
// `end` where it lands at reset at the average rate so far, and `out` the time it reaches
// 100% at that rate if that is before the reset. The week is taken to start 7 days before
// `resets_at`. Past the reset the numbers belong to a week that is over, so null.
//
// The rate is measured to `now`, not to when the file was written: no instance writing
// means no instance calling, so the usage has not moved since. Use from claude.ai or
// another machine counts against the same limit and is not seen until something here
// makes a call.
export function pace(u, now = Date.now()) {
  if (!u || now >= u.resetsAt) return null;
  const elapsed = Math.max(0, now - (u.resetsAt - WEEK));
  const even = 100 * elapsed / WEEK;
  if (elapsed < SETTLE || u.used <= 0) return {used: u.used, even, end: null, out: null};
  const end = u.used * WEEK / elapsed;
  const out = end > 100 ? u.resetsAt - WEEK + elapsed * 100 / u.used : null;
  return {used: u.used, even, end, out};
}

function when(ms) {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${DAYS[d.getDay()]} ${hm}`;
}

// What a UI writes, as {text, color}, or null with nothing to say. Red when the rate runs
// out before the reset; gold is kept for `wait`.
export function usageLine(u, now = Date.now()) {
  const p = pace(u, now);
  if (!p) return null;
  const pct = (n) => `${Math.round(n)}%`;
  const parts = [`7d ${pct(p.used)}`, `even ${pct(p.even)}`];
  if (p.out) parts.push(`out ${when(p.out)}, resets ${when(u.resetsAt)}`);
  else if (p.end !== null) parts.push(`${pct(p.end)} at reset ${when(u.resetsAt)}`);
  else parts.push(`resets ${when(u.resetsAt)}`);
  return {text: parts.join("  ·  "), color: p.out ? PALETTE.error : PALETTE.mauve};
}
