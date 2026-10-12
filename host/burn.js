// Who used the seven-day limit: the token use of every assistant message in
// ~/.claude/projects/**/*.jsonl (subagent transcripts count for their parent session),
// weighted into an estimated quota share and summed per hour, project and session. This
// host's only: remote.js merges the hosts, `cchost` serves it (/api/burn).
//
// Weights: API list-price ratios, Opus input = 1: input 1, cache write 1.25 (5m) or 2
// (1h), cache read 0.1, output 5; Sonnet 0.6x, Haiku 0.2x of that. The plan's quota
// formula is not public; this assumes it follows price.
// A message is logged once per content block with the same usage; it counts once (by id).
//
// Checked 2026-10-07 against ~/.claude/ccx-usage.log (integer %, each reading +-1), between
// the times the log first showed each new %:
//   Mon 13:00 -> 20:20   +10%  146M weighted  14.6M per %
//   Mon 20:20 -> 23:21    +6%   83M           13.8M per %
//   Mon 23:21 -> Wed 9:17 +27% 420M           15.6M per %
//   Wed 9:17 -> 15:05     +5%   65M           13.1M per %
// so ~14M weighted tokens per 1% of the week, within +-10% over windows of 5%+. Single-%
// steps scatter 4M-29M: that's the integer rounding, not the tokens. Cache reads are ~85%
// of the weighted total, then output and cache writes (almost all 1h); uncached input is
// ~0. The mix barely changed across these windows, so the fit doesn't tell the weights
// apart: output + cache write alone (cache read 0) tracked the % just as well (2.2-2.5M
// per %). What is solid: the total tracks the %. The split between sessions depends on
// the weights, mostly on how much a cache read counts against output. So a window's
// shares are scaled to the % the log added over it, and PER_PCT is only the fallback.
// (Moved from ~/nadya/tools/burn.js, 2026-10-10.)
//
// STORE keeps settled hours, one JSON line per hour, project and session, and a
// `{"from","done"}` line per scan, so a week still shows after its transcripts go and a
// request reads only the hour in progress. Only `cchost` writes it.

import { HOME } from "./sh.js";
import { usedAt, weekSamples } from "./usage.js";

export const STORE = `${HOME}/.claude/ccx-burn.jsonl`;
export const PER_PCT = 14e6; // weighted tokens per 1% of the 7-day quota (calibration above)
const ROOT = `${HOME}/.claude/projects`;
const HOUR = 3600_000, DAY = 24 * HOUR, WEEK = 7 * DAY;
const SETTLE = 5 * 60_000; // an hour goes into the store this long after it ends
const BACKFILL = 15 * DAY; // what an empty store starts with: last week and this one
const KEEP = 56 * DAY; // pruned to this once the oldest row is 60 days old
const LIVE = 60_000; // the hour in progress is rescanned at most this often
const CHUNK = 1 << 20;
const W = { in: 1, cw5: 1.25, cw1: 2, cr: 0.1, out: 5 };
const TOKENS = ["w", "out", "cw", "cr", "in", "m"];
// a project renamed, by its old name (~/ai/ccx became ~/ai/cc on 2026-10-12)
const ALIAS = { head: "nadya", ccx: "cc" };

function modelWeight(m = "") {
  if (m.includes("haiku")) return 0.2;
  if (m.includes("sonnet")) return 0.6;
  return 1;
}

async function* walk(dir, depth = 0) {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isFile && e.name.endsWith(".jsonl")) yield p;
    else if (e.isDirectory && depth < 3) yield* walk(p, depth + 1);
  }
}

// The session a transcript belongs to and that session's own transcript: itself, or the
// parent's for a subagent
function sessionOf(path) {
  const m = path.match(/^(.*)\/([0-9a-f-]{36})\/subagents\//);
  if (m) return { id: m[2], main: `${m[1]}/${m[2]}.jsonl` };
  return { id: path.split("/").pop().replace(/\.jsonl$/, ""), main: path };
}

// Reads `path` backwards in chunks until a chunk starts before `from`; the lines, in order
async function tailLines(path, size, from) {
  const f = await Deno.open(path);
  try {
    let end = size, carry = "";
    const out = [];
    while (end > 0) {
      const start = Math.max(0, end - CHUNK);
      const buf = new Uint8Array(end - start);
      await f.seek(start, Deno.SeekMode.Start);
      let n = 0;
      while (n < buf.length) {
        const r = await f.read(buf.subarray(n));
        if (r === null) break;
        n += r;
      }
      const lines = (new TextDecoder().decode(buf.subarray(0, n)) + carry)
        .split("\n");
      carry = start > 0 ? lines.shift() : "";
      out.push(lines);
      end = start;
      const ts = lines.find((l) => l.includes('"timestamp":"'))?.match(
        /"timestamp":"([^"]+)"/,
      )?.[1];
      if (ts && Date.parse(ts) < from) break;
    }
    return out.reverse().flat();
  } finally {
    f.close();
  }
}

// The name lines in a transcript, {title, agent}, the last of each winning. Claude Code
// repeats them through the file, so the first 256KB has them when the tail did not
async function namesIn(path) {
  const out = {};
  try {
    const f = await Deno.open(path);
    try {
      const buf = new Uint8Array(256 * 1024);
      const n = await f.read(buf) ?? 0;
      for (
        const line of new TextDecoder().decode(buf.subarray(0, n)).split("\n")
      ) nameLine(line, out);
    } finally {
      f.close();
    }
  } catch {
    // gone
  }
  return out;
}

function nameLine(line, s) {
  try {
    if (line.startsWith('{"type":"custom-title"')) {
      s.title = JSON.parse(line).customTitle;
    } else if (line.startsWith('{"type":"agent-name"')) {
      s.agent = JSON.parse(line).agentName;
    }
  } catch {
    // cut off
  }
}

// Live sessions' names from ~/.claude/sessions/<pid>.json, by session id
function liveNames() {
  const out = new Map();
  try {
    for (const e of Deno.readDirSync(`${HOME}/.claude/sessions`)) {
      if (!e.name.endsWith(".json")) continue;
      try {
        const j = JSON.parse(
          Deno.readTextFileSync(`${HOME}/.claude/sessions/${e.name}`),
        );
        if (j.sessionId && j.name) out.set(j.sessionId, j.name);
      } catch {
        // a record being rewritten
      }
    }
  } catch {
    // no sessions dir
  }
  return out;
}

// A project's name, from a path or from a name this already gave (the store keeps names,
// so rows written by older rules are renamed when read): a /tmp dir is "tmp", anything in
// .dotfiles or .claude "dotfiles" or "claude", "~/" "home", else the last part with no
// leading dot, a dated dir's parent. Then ALIAS. The same name twice is one project, so
// "~/prj/ccx" and "ccx" are both "cc"
export function projectName(p) {
  if (/^(\/private)?\/tmp(\/|$)/.test(p)) return "tmp";
  if (p.includes(".dotfiles")) return "dotfiles";
  if (p.includes(".claude")) return "claude";
  const parts = p.split("/").filter((x) => x && x !== "~");
  if (!parts.length) return "home";
  const last = /^\d/.test(parts.at(-1)) && parts.length > 1 ? parts.at(-2) : parts.at(-1);
  const n = last.replace(/^\./, "");
  return ALIAS[n] ?? n;
}

// ~/web/arcade + arcade-switch-a -> arcade-switch; ~/web/bb + bb-a0 -> bb; ~/ai/cc -> cc;
// ~/nadya -> nadya; ~/prj/bank -> bank. cwd is on whichever host ran the session
export function projectOf(cwd, name) {
  const rel = cwd.replace(/^\/(Users|home)\/[^/]+\/?/, "");
  const parts = rel.split("/");
  const base = projectName(
    ["web", "ai"].includes(parts[0]) && parts[1]
      ? parts[1]
      : rel.startsWith("/")
      ? rel
      : `~/${rel}`,
  );
  if (name.startsWith(`${base}-`)) {
    const rest = name.slice(base.length + 1).split("-");
    if (rest.length >= 2) return `${base}-${rest[0]}`;
  }
  return base;
}

// [from, to) of this host's transcripts as rows {h, p, n, w, out, cw, cr, in, m}: h the
// hour (ms) a message's timestamp falls in, p the project, n the session's name
export async function scan(from, to) {
  const live = liveNames(), seen = new Set(), sessions = new Map();
  for await (const path of walk(ROOT)) {
    let st;
    try {
      st = await Deno.stat(path);
    } catch {
      continue;
    }
    if (!st.mtime || st.mtime.getTime() < from) continue;
    const { id, main } = sessionOf(path), sub = path !== main;
    if (!sessions.has(id)) sessions.set(id, { id, main, cwd: "", msgs: [] });
    const s = sessions.get(id), msgs = new Map();
    for (const line of await tailLines(path, st.size, from)) {
      if (!sub) nameLine(line, s);
      if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) {
        continue;
      }
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      const at = Date.parse(j.timestamp), u = j.message?.usage;
      if (j.type !== "assistant" || !(at >= from && at < to) || !u) continue;
      if (!sub || !s.cwd) s.cwd = j.cwd ?? s.cwd;
      msgs.set(j.message.id ?? j.requestId ?? j.uuid, {
        u,
        model: j.message.model,
        at,
      });
    }
    for (const [key, m] of msgs) {
      if (seen.has(key)) continue;
      seen.add(key);
      s.msgs.push(m);
    }
  }
  const rows = new Map();
  for (const s of sessions.values()) {
    if (!s.msgs.length) continue;
    if (!live.has(s.id) && !s.title && !s.agent) {
      Object.assign(s, await namesIn(s.main));
    }
    const n = live.get(s.id) ?? s.title ?? s.agent ?? s.id.slice(0, 8);
    const p = projectOf(s.cwd, n);
    for (const { u, model, at } of s.msgs) {
      const h = Math.floor(at / HOUR) * HOUR, key = `${h}\t${p}\t${n}`;
      if (!rows.has(key)) {
        rows.set(key, { h, p, n, w: 0, out: 0, cw: 0, cr: 0, in: 0, m: 0 });
      }
      const r = rows.get(key);
      const cw = u.cache_creation_input_tokens ?? 0;
      const cw1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      const t = {
        in: u.input_tokens ?? 0,
        cw,
        cr: u.cache_read_input_tokens ?? 0,
        out: u.output_tokens ?? 0,
      };
      r.w += modelWeight(model) *
        (t.in * W.in + (cw - cw1) * W.cw5 + cw1 * W.cw1 + t.cr * W.cr +
          t.out * W.out);
      for (const k of ["out", "cw", "cr", "in"]) r[k] += t[k];
      r.m++;
    }
  }
  for (const r of rows.values()) r.w = Math.round(r.w);
  return [...rows.values()];
}

// ---------- the store

let store = null, settling = null, live = null;

function load() {
  if (store) return store;
  store = { start: Infinity, done: 0, rows: [] };
  let text = "";
  try {
    text = Deno.readTextFileSync(STORE);
  } catch {
    return store;
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const j = JSON.parse(line);
      if (j.done) {
        [store.start, store.done] = [
          Math.min(store.start, j.from),
          Math.max(store.done, j.done),
        ];
      } else store.rows.push(j);
    } catch {
      // a line cut by a crash
    }
  }
  return store;
}

// Scans what settled since the last scan into the store
async function update(s, now) {
  const to = Math.floor((now - SETTLE) / HOUR) * HOUR;
  const from = s.done || to - BACKFILL;
  if (from >= to) return;
  const rows = await scan(from, to);
  s.rows.push(...rows);
  [s.start, s.done] = [Math.min(s.start, from), to];
  const lines = [...rows, { from, done: to }].map((r) =>
    JSON.stringify(r) + "\n"
  ).join("");
  if (s.rows[0]?.h < now - KEEP - 4 * DAY) {
    const cut = Math.floor((now - KEEP) / HOUR) * HOUR;
    s.rows = s.rows.filter((r) => r.h >= cut);
    s.start = Math.max(s.start, cut);
    const all = [...s.rows, { from: s.start, done: s.done }];
    await Deno.writeTextFile(
      `${STORE}.tmp`,
      all.map((r) => JSON.stringify(r) + "\n").join(""),
    );
    await Deno.rename(`${STORE}.tmp`, STORE);
  } else {
    await Deno.writeTextFile(STORE, lines, { append: true });
  }
}

// Brings the store up to the last settled hour; `cchost` runs it on start and every 10
// minutes, so a request seldom waits on it
export async function settle(now = Date.now()) {
  const s = load();
  settling ??= update(s, now).finally(() => settling = null);
  await settling;
}

// This host's rows in [from, to): settled hours from the store, the rest scanned. `write`
// false (a CLI with no daemon here) reads the store and leaves it as it is
export async function localRows(
  from,
  to,
  { write = true, now = Date.now() } = {},
) {
  const s = load();
  if (write) await settle(now);
  const a = Math.min(Math.ceil(from / HOUR) * HOUR, to);
  const b = Math.max(a, Math.min(to, s.done));
  if (a < s.start) return await scan(from, to);
  const out = s.rows.filter((r) => r.h >= a && r.h < b);
  if (from < a) out.push(...await scan(from, a));
  if (b >= to) return out;
  // the hour in progress, every request at most once a minute
  if (b === s.done && to >= now - LIVE) {
    if (live?.b !== b || now - live.at > LIVE) {
      live = { b, at: now, rows: await scan(b, now) };
    }
    return out.concat(live.rows);
  }
  return out.concat(await scan(b, to));
}

// ---------- grouping

function blank() {
  return { w: 0, out: 0, cw: 0, cr: 0, in: 0, m: 0 };
}

function add(a, b) {
  for (const k of TOKENS) a[k] += b[k];
}

// Rows (each with its host) summed per project and session, biggest first. Each has
// `share`, its % of the weighted tokens, and `q`, that share of `used`, the % the log added
// over them: the % of the limit it took. With no log `q` is null: the estimate w / PER_PCT
// (`est`, the total's only) put week Sep 28 - Oct 5 at 184%, so it is not to be trusted
// across weeks
export function group(rows, used = null) {
  const projects = new Map(), all = blank();
  for (const r of rows) {
    const name = projectName(r.p);
    if (!projects.has(name)) {
      projects.set(name, { p: name, ...blank(), sessions: new Map() });
    }
    const p = projects.get(name);
    if (!p.sessions.has(r.n)) {
      p.sessions.set(r.n, { n: r.n, host: r.host, ...blank() });
    }
    add(p.sessions.get(r.n), r);
    add(p, r);
    add(all, r);
  }
  const share = (w) => all.w ? Math.round(1000 * w / all.w) / 10 : 0;
  const q = (w) =>
    used == null ? null : Math.round(100 * (all.w ? w / all.w * used : 0)) / 100;
  const sorted = (m) => [...m.values()].sort((a, b) => b.w - a.w);
  return {
    ...all,
    used: used == null ? null : Math.round(used * 100) / 100,
    est: Math.round(100 * all.w / PER_PCT) / 100,
    projects: sorted(projects).map((p) => ({
      ...p,
      q: q(p.w),
      share: share(p.w),
      sessions: sorted(p.sessions).map((s) => ({
        ...s,
        q: q(s.w),
        share: share(s.w),
      })),
    })),
  };
}

// What a week and its days used, by project and session: `weeks` last then this, `days`
// each local day of both, cut at the reset. `u` is the merged reading (remote.js)
export function breakdown(rows, u, now = Date.now()) {
  const start = u.resetsAt - WEEK;
  const last = weekSamples(
    { resetsAt: start, history: u.history, used: 0 },
    start,
  );
  const weeks = [[
    "last week",
    start - WEEK,
    start,
    last.some((s) => s.used > 0) ? last : null,
  ], ["this week", start, now, weekSamples(u, now)]];
  const out = { at: now, reset: u.resetsAt, used: u.used, weeks: [], days: [] };
  const win = (label, from, to, samples) => ({
    label,
    from,
    to,
    ...group(
      rows.filter((r) => r.h >= from && r.h < to),
      samples ? usedAt(samples, to) - usedAt(samples, from) : null,
    ),
  });
  for (const [label, from, to, samples] of weeks) {
    out.weeks.push(win(label, from, to, samples));
    for (let a = from; a < to;) {
      const next = new Date(a);
      next.setHours(24, 0, 0, 0);
      const b = Math.min(next.getTime(), to);
      out.days.push(
        win(
          new Date(a).toLocaleDateString("en-US", { weekday: "short" }),
          a,
          b,
          samples,
        ),
      );
      a = b;
    }
  }
  return out;
}
