// The seven-day plan limit, as Claude Code last handed it to its status line. No UI and no
// network: `~/.claude/settings.json` points `statusLine` at `statusline.sh`, which copies
// the JSON it is given to USAGE whenever that JSON holds a `seven_day` and appends the
// numbers to HISTORY when they change. Both UIs read them from the poll they already run.
//
// Claude Code fills `rate_limits` from the `anthropic-ratelimit-unified-*` headers of its
// own API responses (2.1.289): `used_percentage` is utilization * 100 to one decimal and
// `resets_at` is epoch seconds. Every instance writes the same file, last one wins, and the
// numbers carry no time of their own, so an instance idle since an older response can put
// older numbers back for a moment.

import {HOME} from "./sh.js";
import {PALETTE} from "./view.js";

export const USAGE = `${HOME}/.claude/ccx-usage.json`;
export const HISTORY = `${HOME}/.claude/ccx-usage.log`;
const WEEK = 7 * 24 * 3600_000;
const SETTLE = 3600_000;    // under an hour into a week the average rate is noise
const RECENT = 1 * 3600_000; // the rate is what the last 1h added
export const LONGER = 3 * 3600_000; // the second rate, over 3h (usageLine, api/usage paceLong)
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// {used, resetsAt, at, history} with every time in ms, `at` being when the file was
// written, or null. Anything missing, unreadable or unparseable reads as no data.
export function readUsage(path = USAGE, log = HISTORY) {
  try {
    const at = Deno.statSync(path).mtime?.getTime() ?? 0;
    const week = JSON.parse(Deno.readTextFileSync(path))?.rate_limits?.seven_day;
    const used = Number(week?.used_percentage), resets = Number(week?.resets_at);
    if (!Number.isFinite(used) || !Number.isFinite(resets) || !resets) return null;
    return {used, resetsAt: resets * 1000, at, history: readHistory(log)};
  } catch {
    return null;
  }
}

// HISTORY as [{at, used, resetsAt}], oldest first, five_hour left out. A missing file is
// no history and a line that does not parse is skipped.
export function readHistory(path = HISTORY) {
  let text = "";
  try {
    text = Deno.readTextFileSync(path);
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    const [at, used, resets] = line.split(" ").map(Number);
    if (!at || !Number.isFinite(used) || !resets) continue;
    out.push({at: at * 1000, used, resetsAt: resets * 1000});
  }
  return out;
}

// What was used at `t`, between the samples either side of it.
export function usedAt(samples, t) {
  let prev = samples[0];
  for (const s of samples) {
    if (s.at >= t) {
      return s.at === prev.at ? s.used
        : prev.used + (s.used - prev.used) * (t - prev.at) / (s.at - prev.at);
    }
    prev = s;
  }
  return prev.used;
}

// This week's samples to `now`: 0 at its start, the history's lines in it, then `u` itself
// at `now`, sorted, with a running max applied, since an instance holding older numbers can
// write them after newer ones and within a week the figure only goes up. Except when the
// counter is reset mid-week (seen 2026-10-13: 10% to 0% under the same resets_at): a drop
// counts once two readings in a row sit below the max, and starts back at the first low
// reading after the last high one, a lone high between lows being an instance with older
// numbers. Each drop is kept in `samples.drops` as {at, by} and the samples run on as if it
// had not happened, `by` higher, so what a span added is still a difference; usedNow()
// takes them back off. `u` is left out when it is at or above the last drop's max: that is
// an older reading, and anything real since is in the history.
export function weekSamples(u, now) {
  const start = u.resetsAt - WEEK, raw = [];
  for (const h of u.history ?? []) {
    if (h.resetsAt !== u.resetsAt || h.at <= start || h.at >= now) continue;
    raw.push({at: h.at, used: h.used});
  }
  raw.sort((a, b) => a.at - b.at);
  const drops = new Map(), skip = new Set();
  let top = 0;
  for (let i = 0; i < raw.length; i++) {
    if (!(raw[i].used < top && raw[i + 1]?.used < top)) {
      top = Math.max(top, raw[i].used);
      continue;
    }
    let j = i;
    while (j >= 2 && raw[j - 1].used >= top && raw[j - 2].used < top) {
      skip.add(j - 1);
      j -= 2;
    }
    drops.set(j, top);
    top = Math.max(...raw.slice(j, i + 1).filter((_, k) => !skip.has(j + k)).map((s) => s.used));
  }
  const last = [...drops.values()].at(-1);
  if (last === undefined || u.used < last) raw.push({at: now, used: u.used});
  const samples = [{at: start, used: 0}];
  samples.drops = [];
  let base = 0;
  top = 0;
  raw.forEach((s, i) => {
    if (skip.has(i)) return;
    if (drops.has(i)) {
      base += drops.get(i);
      samples.drops.push({at: s.at, by: drops.get(i)});
      top = 0;
    }
    top = Math.max(top, s.used);
    samples.push({at: s.at, used: base + top});
  });
  return samples;
}

// What the counter itself read at `t` (default the last sample), drops taken off
export function usedNow(samples, t = samples.at(-1).at) {
  return usedAt(samples, t) - samples.drops.filter((d) => d.at <= t)
    .reduce((n, d) => n + d.by, 0);
}

// The week so far by local day, [{day, used, added, samples}]: `day` the ms its midnight
// falls on (the first one is the week's start), `used` at its end or at `now`, `added`
// over it and `samples` how many history lines it holds. A day with none has `used`
// interpolated across it.
export function byDay(u, now = Date.now()) {
  if (!u || now >= u.resetsAt) return [];
  const samples = weekSamples(u, now), out = [];
  const start = u.resetsAt - WEEK;
  let from = start, before = 0;
  while (from < now) {
    const next = new Date(from);
    next.setHours(24, 0, 0, 0);
    const to = Math.min(next.getTime(), now), used = usedNow(samples, to);
    const n = samples.filter((s) => s.at > start && s.at >= from && s.at < to).length;
    const total = usedAt(samples, to);
    out.push({day: from, used, added: total - before, samples: n});
    [from, before] = [next.getTime(), total];
  }
  return out;
}

// Where the week stands at `now`: `even` is where an even spread over the 7 days would be,
// `rate` what the last `window` (1h) added, in % per day, `ratio` that over what is left per day to
// the reset, `end` where that rate lands at the reset, and `out` the time it reaches 100% if that is before the reset. The week is taken to
// start at 0, 7 days before `resets_at`. Past the reset the numbers belong to a week that
// is over, so null.
//
// `u` itself is taken at `now`, not at when the file was written: no instance writing
// means no instance calling, so the usage has not moved since. Use from claude.ai or another machine counts against the same limit and
// is not seen until something here makes a call. With no history, or under 1h of it, the
// 1h falls between the week's start and the first sample, so the rate is the average.
export function pace(u, now = Date.now(), window = RECENT) {
  if (!u || now >= u.resetsAt) return null;
  const start = u.resetsAt - WEEK, elapsed = Math.max(0, now - start);
  const even = 100 * elapsed / WEEK;
  const samples = weekSamples(u, now), used = usedNow(samples), total = samples.at(-1).used;
  if (elapsed < SETTLE || used <= 0) {
    return {used, even, rate: null, ratio: null, end: null, out: null};
  }
  const span = Math.min(window, elapsed);
  const perMs = (total - usedAt(samples, now - span)) / span;
  const end = used + perMs * (u.resetsAt - now);
  const out = end > 100 ? now + (100 - used) / perMs : null;
  const ratio = used < 100 ? perMs * (u.resetsAt - now) / (100 - used) : null;
  return {used, even, rate: perMs * 24 * 3600_000, ratio, end, out};
}

// `Thu 4pm` for 16:53: the hour it falls in
function when(ms) {
  const d = new Date(ms);
  const h = d.getHours();
  return `${DAYS[d.getDay()]} ${h % 12 || 12}${h < 12 ? "am" : "pm"}`;
}

// What a UI writes, `usage <used> (<1h ratio>x 1h, <3h ratio>x 3h pace - out <when>)`, the
// `- out` part only when the 1h rate runs out before the reset, as {text, color}; 1.0x spends exactly what is left by the reset, or null with nothing to say. Orange when the rate runs
// out before the reset; gold is kept for `wait`.
export function usageLine(u, now = Date.now()) {
  const p = pace(u, now);
  if (!p) return null;
  const pl = pace(u, now, LONGER);
  const pct = (n) => `${Math.round(n)}%`;
  const parts = [p.ratio === null ? "" : `${p.ratio.toFixed(1)}x 1h, ${pl.ratio.toFixed(1)}x 3h pace`,
    p.out ? `out ${when(p.out)}` : ""].filter(Boolean);
  const rest = parts.length ? ` (${parts.join(" - ")})` : "";
  return {text: `usage ${pct(p.used)}${rest}`,
    color: p.out ? PALETTE.warn : PALETTE.mauve};
}
