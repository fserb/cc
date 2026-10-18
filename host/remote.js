// The other machines' daemons, as cchost reaches them: the host list, a call, the merged
// usage and burn, and the list stream it follows for the relay and api/list?all=1.

import {calibrate, CALIB_SPANS, lastDrop, readUsage, tokenPace as tokenPaceOf, usedAt, usedNow, weekSamples}
  from "./usage.js";
import {breakdown, group, localRows, PER_PCT, series} from "./burn.js";

export const PORT = 7681;
export const SELF = Deno.env.get("CCX_SELF") ?? Deno.hostname().split(".")[0];
const TIMEOUT = 3000;
// a followed stream silent this long is dropped: cchost writes a keepalive every 15s, and a
// host that slept leaves the connection open with nothing on it, its last list kept as live
const STALL = 45_000;
const WEEK = 7 * 24 * 3600_000;

// every machine that runs claudes, this one included. CCX_HOSTS=a,b overrides, and an
// entry `name=addr:port` reaches name somewhere else, which is how two daemons share a box
const ENTRIES = (Deno.env.get("CCX_HOSTS") ?? "marx,nadya").split(",")
  .map((h) => h.trim().split("=")).filter(([h]) => h);
export const HOSTS = ENTRIES.map(([h]) => h);
// this host by its own name can leave from a link-local address, which tailnetOrLocal
// refuses (nadya resolves itself to four fe80:: as well), so it is localhost
const ADDR = new Map(ENTRIES.map(([h, a]) => [h, a ?? (h === SELF ? "localhost" : h) + `:${PORT}`]));
export const others = () => HOSTS.filter((h) => h !== SELF);

export const base = (host) => `http://${ADDR.get(host) ?? `${host}:${PORT}`}`;

// GET or POST json. [body, null] or [null, error message]
export async function call(host, path, body = undefined, timeout = TIMEOUT) {
  const init = {signal: AbortSignal.timeout(timeout)};
  if (body !== undefined) {
    Object.assign(init, {method: "POST", body: JSON.stringify(body),
      headers: {"content-type": "application/json"}});
  }
  try {
    const r = await fetch(`${base(host)}${path}`, init);
    const j = await r.json().catch(() => ({}));
    return r.ok ? [j, null] : [null, j.error ?? `${r.status}`];
  } catch (e) {
    return [null, e.name === "TimeoutError" ? `${host}: no answer in ${timeout}ms`
      : `${host}: ${e.message}`];
  }
}

// The seven-day reading, from whichever host saw the latest: the limit is the account's, so
// every host's status line writes the same numbers, at different times. A later reset wins,
// then a higher figure, which only goes up within a week. Its history is every host's log
// lines: each log has only what its own sessions saw, so one host's alone has gaps (nadya's
// started on Fri 2026-10-09, and `ccx usage` there drew Mon-Thu as interpolated)
export async function mergedUsage() {
  const all = [readUsage(), ...(await Promise.all(others().map(async (h) =>
    (await call(h, "/api/usage?local=1"))[0]?.usage)))].filter((u) => u);
  const best = all.reduce((a, b) => !a || b.resetsAt > a.resetsAt ||
    (b.resetsAt === a.resetsAt && b.used > a.used) ? b : a, null);
  if (!best) return null;
  const lines = new Map();
  for (const h of all.flatMap((u) => u.history ?? [])) lines.set(`${h.at} ${h.used} ${h.resetsAt}`, h);
  const u = {...best, history: [...lines.values()].sort((a, b) => a.at - b.at)};
  // a host's file can hold an older figure than the log, past a mid-week reset
  if (Date.now() < u.resetsAt) u.used = usedNow(weekSamples(u, Date.now()));
  return u;
}

// Every host's burn rows in [from, to), each with its host, and the hosts that did not
// answer. `local` reads this host's: the daemon's own store, or a read-only scan
export async function allRows(from, to, local) {
  const q = `/api/burn/rows?from=${from}&to=${to}`;
  const [mine, ...rest] = await Promise.all([local(from, to),
    ...others().map((h) => call(h, q, undefined, 10_000))]);
  const rows = mine.map((r) => ({...r, host: SELF})), down = [];
  others().forEach((h, n) => {
    const [body, err] = rest[n];
    if (err) return down.push([h, err]);
    rows.push(...body.rows.map((r) => ({...r, host: h})));
  });
  return {rows, down};
}

// What /api/burn answers. No `hours`: last week, this week and their days, by project and
// session (burn.js breakdown). `hours`: the last N, the same way, with the % the log added
// over them when they fall in this week
export async function burnReport(hours, local, now = Date.now()) {
  const u = await mergedUsage();
  if (!u) return {error: "no seven-day reading on any host"};
  for (; u.resetsAt <= now; u.used = 0) u.resetsAt += WEEK;
  const start = u.resetsAt - WEEK;
  if (!hours) {
    const {rows, down} = await allRows(start - WEEK, now, local);
    return {...breakdown(rows, u, now), down};
  }
  const from = now - hours * 3600_000, {rows, down} = await allRows(from, now, local);
  const s = weekSamples(u, now);
  const used = from >= start ? usedAt(s, now) - usedAt(s, from) : null;
  const per = used == null ? (await measured(u, now)).perPct : PER_PCT;
  return {at: now, from, to: now, hours, ...group(rows, used, per), perPct: per, down};
}

// What /api/burn/series answers: every host's weighted tokens per `step` over the last `n`
// steps, summed, and `ref`, the tokens a step would take at the even pace (the rest of the
// week spread evenly to the reset, at the measured tokens per %), which is 1.0x on the header
export async function burnSeries(n, step, now = Date.now()) {
  const [{down, ...mine}, u] = await Promise.all([allSeries(n, step, now), mergedUsage()]);
  const left = u && u.resetsAt > now ? u.resetsAt - now : 0;
  const per = left ? (await measured(u, now)).perPct : 0;
  const ref = left ? Math.round(Math.max(0, 100 - u.used) * per / left * step) : null;
  return {...mine, ref, down};
}

// Every host's burn.js series() summed, with the hosts that did not answer as `down`
async function allSeries(n, step, now) {
  const q = `/api/burn/series?local=1&n=${n}&step=${step}&at=${now}`;
  const [mine, rest] = await Promise.all([series(n, step, now),
    Promise.all(others().map((h) => call(h, q, undefined, 10_000)))]);
  const down = [];
  others().forEach((h, i) => {
    const [body, err] = rest[i];
    if (err || body.from !== mine.from) return down.push([h, err ?? "buckets differ"]);
    body.w.forEach((w, j) => mine.w[j] += w);
  });
  return {...mine, down};
}

// Weighted tokens per 1% of the week, every host's burn rows against the merged log
// (usage.js calibrate: the last 1, 3 or 7 days, the first where the log added 3%+), so it
// follows the plan's quota as it changes: 3.0M-4.2M on 2026-10-16 over 1 to 7 days, at the
// prices of burn.js since that day. PER_PCT when no span has 3% (`calib` null).
// Re-measured at most every 10 min, and at once when the reading drops. In the 6h after
// a drop, while the hours since it hold under 3%, by the minute from the drop on
const MEASURE_EVERY = 10 * 60_000, FINE = 6 * 3600_000;
let lastMeasure = null;
export async function measured(u, now = Date.now()) {
  if (lastMeasure && now - lastMeasure.at < MEASURE_EVERY && lastMeasure.resetsAt === u.resetsAt &&
    u.used >= lastMeasure.used - 1) {
    return lastMeasure;
  }
  const oldest = Math.ceil((now - CALIB_SPANS.at(-1)) / 3600_000) * 3600_000;
  const {rows, down} = await allRows(oldest, now, localRows);
  let c = calibrate(u, rows, now);
  const drop = lastDrop(u, now), M = 60_000;
  if ((!c || c.to < now) && drop && now - drop.at < FINE) {
    // still measuring from before the drop: by the minute since it, if that has CALIB_MIN%
    const s = await allSeries(Math.ceil((now - drop.at) / M) + 1, M, now);
    if (!s.down.length) {
      const fine = calibrate(u, s.w.map((w, i) => ({h: s.from + i * M, w})), now, M);
      if (fine?.to === now) c = fine;
    }
  }
  const m = {at: now, resetsAt: u.resetsAt, used: u.used, perPct: c?.perPct ?? PER_PCT,
    calib: c && {from: c.from, to: c.to, added: c.added, w: c.w}};
  if (!down.length) lastMeasure = m;
  return m;
}

// The pace over the last 5 min (`short`) and 15 min (`long`) from every host's weighted tokens
// (usage.js tokenPace), which cc's header shows (user, 2026-10-14; 15m and 1h until 2026-10-17), at measured()'s tokens
// per %. Each window is whole minutes back from the one in progress, so a window is up to
// 1 min long.
export async function tokenPace(u, now = Date.now()) {
  if (!u || now >= u.resetsAt) return null;
  const [{perPct, calib}, s] = await Promise.all([measured(u, now), allSeries(15, 60_000, now)]);
  const win = (mins) => {
    const k = s.w.length - mins;
    return tokenPaceOf(u, s.w.slice(k).reduce((a, b) => a + b, 0), now - (s.from + k * s.step), perPct, now);
  };
  return {perPct, calib, short: win(5), long: win(15), down: s.down};
}

// Reads one SSE stream at `url`, onFrame(event, data text) for each frame, until it ends
// ("stream ended"), fails (thrown) or is silent STALL ms from the connect on (thrown).
// The stall rejects the pending read itself instead of waiting on the abort to: on
// 2026-10-16 marx dropped both of nadya's streams at 18:24 with no FIN or RST, and
// nadya's reads were still pending at 19:30 with the 45s abort in place, sockets
// ESTABLISHED, nothing reconnecting, and marx's rows from 18:24 shown as live
async function sse(url, onFrame) {
  const ctl = new AbortController();
  let timer, stalled;
  const stall = new Promise((_, no) => stalled = no);
  stall.catch(() => {});
  const pet = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const e = new Error(`nothing in ${STALL / 1000}s`);
      stalled(e);
      ctl.abort(e);
    }, STALL);
  };
  pet();
  try {
    const r = await Promise.race([fetch(url, {signal: ctl.signal}), stall]);
    if (!r.ok) throw new Error(`answered ${r.status}`);
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const {value, done} = await Promise.race([reader.read(), stall]);
      if (done) return "stream ended";
      pet();
      buf += value;
      let cut;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        onFrame(frame.match(/^event: (.*)$/m)?.[1], frame.match(/^data: (.*)$/m)?.[1]);
      }
    }
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
}

// Follow `host`'s api/events: onList(rows, body) on each list, onList(null, null, why)
// when the stream drops, then retry every `retry` ms until stop()
export function follow(host, onList, retry = 5000) {
  let alive = true;
  (async () => {
    while (alive) {
      let why;
      try {
        why = await sse(`${base(host)}/api/events`, (event, data) => {
          if (event !== "list" || !data) return;
          const body = JSON.parse(data);
          onList(body.rows, body);
        });
      } catch (e) {
        // down, refused or stalled: the same to the caller
        why = e.message;
      }
      onList(null, null, why);
      if (alive) await new Promise((ok) => setTimeout(ok, retry));
    }
  })();
  return () => {
    alive = false;
  };
}

// Follow `host`'s api/changes into `changes` (changes.js), each under an id of ours. A
// reconnect asks for what came after the last one it saw, so a dropped stream loses
// nothing that host still holds; what it cannot replay comes as `lost`, which is passed on.
// The first reconnect with no position yet (no `ready` came) is one `lost` here
export function followChanges(host, changes, retry = 5000) {
  let alive = true, pos = null, tries = 0;
  (async () => {
    while (alive) {
      try {
        if (pos === null && tries++ === 1) changes.lost(host);
        await sse(`${base(host)}/api/changes${pos === null ? "" : `?since=${pos}`}`, (event, data) => {
          if (!data) return;
          const body = JSON.parse(data);
          if (event === "ready") pos = body.id;
          else if (event === "lost") changes.lost(host);
          else if (event === "change") {
            pos = body.id;
            changes.remote(body);
          }
        });
      } catch {
        // down, refused or stalled: try again
      }
      if (alive) await new Promise((ok) => setTimeout(ok, retry));
    }
  })();
  return () => {
    alive = false;
  };
}
