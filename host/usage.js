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

import { HOME } from "./sh.js";
import { PALETTE } from "./view.js";

export const USAGE = `${HOME}/.claude/ccx-usage.json`;
export const HISTORY = `${HOME}/.claude/ccx-usage.log`;
const WEEK = 7 * 24 * 3600_000;
const SETTLE = 3600_000; // under an hour into a week the average rate is noise
const RECENT = 1 * 3600_000; // the rate is what the last 1h added
export const LONGER = 3 * 3600_000; // the second rate, over 3h (usageLine, api/usage paceLong)
const DIP = 1;
const MIN_SPAN = 15 * 60_000; // pace() after a drop: the rate over at least the last 15 min
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// {used, resetsAt, at, history} with every time in ms, `at` being when the file was
// written, or null. Anything missing, unreadable or unparseable reads as no data.
export function readUsage(path = USAGE, log = HISTORY) {
  try {
    const at = Deno.statSync(path).mtime?.getTime() ?? 0;
    const week = JSON.parse(Deno.readTextFileSync(path))?.rate_limits
      ?.seven_day;
    const used = Number(week?.used_percentage),
      resets = Number(week?.resets_at);
    if (!Number.isFinite(used) || !Number.isFinite(resets) || !resets) {
      return null;
    }
    return { used, resetsAt: resets * 1000, at, history: readHistory(log) };
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
    out.push({ at: at * 1000, used, resetsAt: resets * 1000 });
  }
  return out;
}

// What was used at `t`, between the samples either side of it.
export function usedAt(samples, t) {
  let prev = samples[0];
  for (const s of samples) {
    if (s.at >= t) {
      return s.at === prev.at
        ? s.used
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
// takes them back off. A reading DIP points or less under the max is not a drop: the log is
// whole percents and two instances can write one second apart in either order. `u` is left out when it is at or above the last drop's max: that is
// an older reading, and anything real since is in the history.
export function weekSamples(u, now) {
  const start = u.resetsAt - WEEK, raw = [];
  for (const h of u.history ?? []) {
    if (h.resetsAt !== u.resetsAt || h.at <= start || h.at >= now) continue;
    raw.push({ at: h.at, used: h.used });
  }
  raw.sort((a, b) => a.at - b.at);
  const drops = new Map(), skip = new Set();
  let top = 0;
  for (let i = 0; i < raw.length; i++) {
    if (!(raw[i].used < top - DIP && raw[i + 1]?.used < top - DIP)) {
      top = Math.max(top, raw[i].used);
      continue;
    }
    let j = i;
    while (j >= 2 && raw[j - 1].used >= top && raw[j - 2].used <= raw[i + 1].used) {
      skip.add(j - 1);
      j -= 2;
    }
    drops.set(j, top);
    top = Math.max(
      ...raw.slice(j, i + 1).filter((_, k) => !skip.has(j + k)).map((s) =>
        s.used
      ),
    );
  }
  const last = [...drops.values()].at(-1);
  if (last === undefined || u.used < last) raw.push({ at: now, used: u.used });
  const samples = [{ at: start, used: 0 }];
  samples.drops = [];
  let base = 0;
  top = 0;
  raw.forEach((s, i) => {
    if (skip.has(i)) return;
    if (drops.has(i)) {
      base += drops.get(i);
      samples.drops.push({ at: s.at, by: drops.get(i) });
      top = 0;
    }
    top = Math.max(top, s.used);
    samples.push({ at: s.at, used: base + top });
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
    const n = samples.filter((s) =>
      s.at > start && s.at >= from && s.at < to
    ).length;
    const total = usedAt(samples, to);
    out.push({ day: from, used, added: total - before, samples: n });
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
// The window starts no earlier than the last mid-week drop (but spans at least MIN_SPAN):
// a plan change (5x to 20x, 2026-10-17) changes what 1% is, so the %s before it are in
// other units.
export function pace(u, now = Date.now(), window = RECENT) {
  if (!u || now >= u.resetsAt) return null;
  const start = u.resetsAt - WEEK, elapsed = Math.max(0, now - start);
  const even = 100 * elapsed / WEEK;
  const samples = weekSamples(u, now),
    used = usedNow(samples),
    total = samples.at(-1).used;
  if (elapsed < SETTLE || used <= 0) {
    return {
      used,
      even,
      rate: null,
      ratio: null,
      end: null,
      out: null,
      added: null,
    };
  }
  const drop = samples.drops.at(-1)?.at ?? -Infinity;
  const span = Math.min(window, elapsed, Math.max(MIN_SPAN, now - drop));
  const added = total - usedAt(samples, now - span), perMs = added / span;
  const end = used + perMs * (u.resetsAt - now);
  const out = end > 100 ? now + (100 - used) / perMs : null;
  const ratio = used < 100 ? perMs * (u.resetsAt - now) / (100 - used) : null;
  return { used, even, rate: perMs * 24 * 3600_000, ratio, end, out, added };
}

// `Thu 4pm` for 16:53: the hour it falls in
function when(ms) {
  const d = new Date(ms);
  const h = d.getHours();
  return `${DAYS[d.getDay()]} ${h % 12 || 12}${h < 12 ? "am" : "pm"}`;
}

// `ccx usage`'s table under the line: the pace over each of the last 1h to 6h, what it
// added, the ratio, and when it runs out at that rate (`-` when it lasts to the reset).
// Lines of text, or [] with no rate to project
export function paceTable(u, now = Date.now()) {
  const rows = [1, 2, 3, 4, 5, 6].map((h) => [h, pace(u, now, h * 3600_000)]);
  if (rows[0][1]?.ratio == null) return [];
  return [
    "last  added  pace  out",
    ...rows.map(([h, p]) =>
      `${`${h}h`.padStart(4)}  ${`+${p.added.toFixed(1)}%`.padStart(5)}  ` +
      `${`${p.ratio.toFixed(1)}x`.padStart(4)}  ${p.out ? when(p.out) : "-"}`
    ),
  ];
}

// What a UI writes, `usage <used> (<1h ratio>x 1h, <3h ratio>x 3h pace - out <when>)`, the
// `- out` part only when the 1h rate runs out before the reset, as {text, color}; 1.0x spends exactly what is left by the reset, or null with nothing to say. Orange when the rate runs
// out before the reset; gold is kept for `wait`.
export function usageLine(u, now = Date.now()) {
  const p = pace(u, now);
  if (!p) return null;
  const pl = pace(u, now, LONGER);
  const pct = (n) => `${Math.round(n)}%`;
  const parts = [
    p.ratio === null
      ? ""
      : `${p.ratio.toFixed(1)}x 1h, ${pl.ratio.toFixed(1)}x 3h pace`,
    p.out ? `out ${when(p.out)}` : "",
  ].filter(Boolean);
  const rest = parts.length ? ` (${parts.join(" - ")})` : "";
  return {
    text: `usage ${pct(p.used)}${rest}`,
    color: p.out ? PALETTE.warn : PALETTE.mauve,
  };
}

// The % the log added from `from` to `now`, across one reset, last week read as burn.js
// breakdown reads it; null when the span reaches into a last week with no log
export function addedSince(u, from, now = Date.now()) {
  const start = u.resetsAt - WEEK, s = weekSamples(u, now);
  if (from >= start) return usedAt(s, now) - usedAt(s, from);
  const last = weekSamples(
    { resetsAt: start, history: u.history, used: 0 },
    start,
  );
  if (!last.some((x) => x.used > 0)) return null;
  return usedAt(last, start) - usedAt(last, Math.max(from, start - WEEK)) +
    usedAt(s, now);
}

// Weighted tokens per 1% of the week, measured: `rows` (burn rows, {h, w}) against what the
// log added, over the last 1, 3 or 7 days, the first in which the log added CALIB_MIN% or
// more (the log is whole percents, +-1 each). {perPct, from, to, added, w}, or null when none did.
// Never from before the last mid-week drop (this week's or last week's): a plan change
// changes what 1% is (5x to 20x, 2026-10-17), and after an Anthropic reset it costs only
// the days before it. Until CALIB_MIN% is added after one, the measurement up to it: right
// after a reset, wrong by the plan's ratio after a plan change, as PER_PCT would be
export const CALIB_SPANS = [1, 3, 7].map((d) => d * 24 * 3600_000),
  CALIB_MIN = 3;
const H = 3600_000;
export function calibrate(u, rows, now = Date.now()) {
  const drop = lastDrop(u, now), floor = drop ? Math.ceil(drop.at / H) * H : 0;
  for (const span of CALIB_SPANS) {
    const from = Math.max(floor, Math.ceil((now - span) / H) * H),
      added = addedSince(u, from, now);
    const w = rows.reduce((n, r) => r.h >= from && r.h < now ? n + r.w : n, 0);
    if (added >= CALIB_MIN && w > 0) {
      return { perPct: w / added, from, to: now, added, w };
    }
    if (from === floor) break;
  }
  if (!drop) return null;
  const to = Math.floor(drop.at / H) * H;
  return calibrate({ resetsAt: drop.resetsAt, used: 0, history: u.history }, rows, to);
}

// The last mid-week drop before `now` (weekSamples), this week's or last week's, as
// {at, resetsAt}, or null
function lastDrop(u, now) {
  for (const resetsAt of [u.resetsAt, u.resetsAt - WEEK]) {
    const at = weekSamples({ ...u, resetsAt, used: 0 }, Math.min(now, resetsAt))
      .drops.filter((d) => d.at < now).at(-1)?.at;
    if (at) return { at, resetsAt };
  }
  return null;
}

// The pace from weighted tokens (burn.js), which move continuously where the log moves in
// whole percents, so a window under 1h still says something: `w` tokens over the last
// `span` ms, at `perPct` tokens per 1%. Same shape as pace(), `added` in %. The weights
// are a price model, so `perPct` is measured against the log (remote.js tokenPace).
export function tokenPace(u, w, span, perPct, now = Date.now()) {
  const p = pace(u, now);
  if (!p || p.ratio === null || !(span > 0) || !(perPct > 0)) return null;
  const added = w / perPct, perMs = added / span;
  const end = p.used + perMs * (u.resetsAt - now);
  const out = end > 100 ? now + (100 - p.used) / perMs : null;
  const ratio = p.used < 100
    ? perMs * (u.resetsAt - now) / (100 - p.used)
    : null;
  return {
    used: p.used,
    even: p.even,
    rate: perMs * 24 * 3600_000,
    ratio,
    end,
    out,
    added,
  };
}
