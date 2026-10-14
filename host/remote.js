// The other machines' daemons, as cchost reaches them: the host list, a call, the merged
// usage and burn, and the list stream it follows for the relay and api/list?all=1.

import {readUsage, usedAt, usedNow, weekSamples} from "./usage.js";
import {breakdown, group, PER_PCT, series} from "./burn.js";

export const PORT = 7681;
export const SELF = Deno.env.get("CCX_SELF") ?? Deno.hostname().split(".")[0];
const TIMEOUT = 3000;
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
  return {at: now, from, to: now, hours, ...group(rows, used), down};
}

// What /api/burn/series answers: every host's weighted tokens per `step` over the last `n`
// steps, summed, and `ref`, the tokens a step would take at the even pace (the rest of the
// week spread evenly to the reset, PER_PCT per %), which is 1.0x on the header
export async function burnSeries(n, step, now = Date.now()) {
  const q = `/api/burn/series?local=1&n=${n}&step=${step}&at=${now}`;
  const [mine, rest, u] = await Promise.all([series(n, step, now),
    Promise.all(others().map((h) => call(h, q, undefined, 10_000))), mergedUsage()]);
  const down = [];
  others().forEach((h, i) => {
    const [body, err] = rest[i];
    if (err || body.from !== mine.from) return down.push([h, err ?? "buckets differ"]);
    body.w.forEach((w, j) => mine.w[j] += w);
  });
  const left = u && u.resetsAt > now ? u.resetsAt - now : 0;
  const ref = left ? Math.round(Math.max(0, 100 - u.used) * PER_PCT / left * step) : null;
  return {...mine, ref, down};
}

// Follow `host`'s api/events: onList(rows, body) on each list, onList(null, null, why)
// when the stream drops, then retry every `retry` ms until stop()
export function follow(host, onList, retry = 5000) {
  let alive = true, ctl = null, why = "";
  (async () => {
    while (alive) {
      ctl = new AbortController();
      try {
        const r = await fetch(`${base(host)}/api/events`, {signal: ctl.signal});
        if (!r.ok) throw new Error(`answered ${r.status}`);
        let buf = "";
        for await (const chunk of r.body.pipeThrough(new TextDecoderStream())) {
          buf += chunk;
          let cut;
          while ((cut = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            const event = frame.match(/^event: (.*)$/m)?.[1];
            const data = frame.match(/^data: (.*)$/m)?.[1];
            if (event !== "list" || !data) continue;
            const body = JSON.parse(data);
            onList(body.rows, body);
          }
        }
        why = "stream ended";
      } catch (e) {
        // down, refused or aborted: the same to the caller
        why = e.message;
      }
      onList(null, null, why);
      if (alive) await new Promise((ok) => setTimeout(ok, retry));
    }
  })();
  return () => {
    alive = false;
    ctl?.abort();
  };
}
