// The other machines' claudes, through the `ccx host` daemon each one runs. Names read
// `host:name` and paths `host:~/path`; the local host is discover() as it always was, so
// the CLI works with no daemon here.

import {discover, Instance, kittyOwner, processes} from "./claudes.js";
import {kittyTty, sendKitty} from "./jump.js";
import {MAC, sh} from "./sh.js";
import {readUsage, usedAt, weekSamples} from "./usage.js";
import {breakdown, group} from "./burn.js";

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

// An api/list row as an Instance on `host`. The row's path is in `~` form already, and that
// `~` is the remote's home, not ours
export function fromRow(host, r) {
  return new Instance({pid: r.pid, host, name: r.name, path: r.path ?? "", cwd: r.cwd,
    state: r.state,
    asking: r.asking, waitsOn: r.waitsOn, summary: r.summary, since: r.since,
    statusSince: r.since, pane: r.pane, session: r.session, window: r.window,
    paneIndex: r.paneIndex, tab: r.tab ?? "", sessionId: r.sessionId, sock: r.sock});
}

// Every claude on every host, local first, then the others in HOSTS order. A host that
// does not answer is in `down` with why, and its claudes are left out. `clock`, a
// StateClock, runs over the local ones only: a remote row has its state and since already
export async function discoverAll(clock) {
  const [local, ...rest] = await Promise.all([discover().then((l) => clock.update(l)),
    ...others().map((h) => call(h, "/api/list"))]);
  const down = [];
  const all = [...local];
  others().forEach((h, n) => {
    const [body, err] = rest[n];
    if (err) return down.push([h, err]);
    all.push(...body.rows.map((r) => fromRow(h, r)));
  });
  return {instances: all, down};
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
  return {...best, history: [...lines.values()].sort((a, b) => a.at - b.at)};
}

// Every host's burn rows in [from, to), each with its host, and the hosts that did not
// answer. `local` reads this host's: the daemon's own store, or a read-only scan
export async function allRows(from, to, local) {
  const q = `/api/burn/rows?from=${from}&to=${to}`;
  const [mine, ...rest] = await Promise.all([local(from, to),
    ...others().map((h) => call(h, q, undefined, 60_000))]);
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

// `host:name` for a remote instance, the name alone for a local one
export const label = (i) => `${i.host ? `${i.host}:` : ""}${i.name || i.pid}`;

// Follow `host`'s api/events: onList(rows) on each list, onList(null) when the stream
// drops, then retry every `retry` ms until stop()
export function follow(host, onList, retry = 5000) {
  let alive = true, ctl = null;
  (async () => {
    while (alive) {
      ctl = new AbortController();
      try {
        const r = await fetch(`${base(host)}/api/events`, {signal: ctl.signal});
        if (!r.ok) throw new Error(`${r.status}`);
        let buf = "";
        for await (const chunk of r.body.pipeThrough(new TextDecoderStream())) {
          buf += chunk;
          let cut;
          while ((cut = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            const event = frame.match(/^event: (.*)$/m)?.[1];
            const data = frame.match(/^data: (.*)$/m)?.[1];
            if (event === "list" && data) onList(JSON.parse(data).rows);
          }
        }
      } catch {
        // down, refused or aborted: the same to the caller
      }
      onList(null);
      if (alive) await new Promise((ok) => setTimeout(ok, retry));
    }
  })();
  return () => {
    alive = false;
    ctl?.abort();
  };
}


// The other hosts' rows as their event streams last had them, for a UI that polls: reading
// it never waits on the network, and a host that is down is simply absent
export class Remotes {
  constructor(hosts = others()) {
    this.rows = new Map();
    this.stops = hosts.map((h) => follow(h, (rows) => rows ? this.rows.set(h, rows)
      : this.rows.delete(h)));
  }

  instances() {
    return [...this.rows].flatMap(([h, rows]) => rows.map((r) => fromRow(h, r)));
  }

  stop() {
    for (const s of this.stops) s();
  }
}

// The command a kitty window runs to show a remote tmux session: a plain attach of the
// whole session, since a kitty window is a session and its tabs one piece of work. Closing
// the window hangs the client up, and tmux keeps a session whose client got SIGHUP.
// -u: an ssh session on nadya has no LANG, so tmux fell back to line-drawing and dropped
// every non-ASCII glyph, the powerline ones included
const attachArgs = (host, session) => ["ssh", "-t", host, "tmux", "-u", "attach", "-t", session];

// Focus a remote instance: its host selects the window and pane, then its session's window
// comes up. An error message, or null
export async function jumpRemote(i) {
  if (!i.pane) return `${label(i)} is not inside tmux; nothing to focus`;
  const [r, err] = await call(i.host, `/api/s/${i.pid}/select`, {});
  if (err) return err;
  return await attachSession(i.host, i.session, r?.background);
}

// The kitty window already attached to a remote tmux session comes to the front, or a new
// one opens attached.
//
// The window takes the remote tmux's pane background, so the padding around it and the
// title bar (`macos_titlebar_color background`) match what tmux paints: `color` when it is
// made, `set-colors` on every focus after, so a theme changed since still lands
const PAINTED = ["background", "active_border_color", "inactive_border_color"];

async function attachSession(host, session, background = "") {
  const tty = await kittyTty();
  if (tty === "") return "no terminal of our own and no kitty window in tmux to reach kitty by";
  const bg = /^#[0-9a-f]{6}$/.test(background ?? "") ? background : "";
  const want = attachArgs(host, session).join(" "), procs = await processes();
  for (const [pid, [, cmd]] of procs) {
    if (cmd !== want) continue;
    const [child, kitty] = kittyOwner(pid, procs);
    if (!kitty) continue;
    if (bg) {
      const rgb = parseInt(bg.slice(1), 16);
      sendKitty("set-colors", {match_window: `pid:${child}`,
        colors: Object.fromEntries(PAINTED.map((c) => [c, rgb]))}, tty);
    }
    if (!sendKitty("focus-window", {match: `pid:${child}`}, tty)) return "cannot reach kitty";
    if (MAC) await sh("open", "-a", "kitty");
    return null;
  }
  // launch's `color` reaches the window's profile and not the title bar, which kitty worked
  // out when it made the window, still black; set-colors recomputes it (kitty 0.49.2,
  // launch.py apply_colors against colors.py patch_colors). The user var is how the
  // set-colors finds a window that has no process to look up yet
  const tag = `${host}.${session}`;
  if (!sendKitty("launch", {args: attachArgs(host, session), type: "os-window",
    var: [`ccx_remote=${tag}`], ...(bg ? {color: PAINTED.map((c) => `${c}=${bg}`)} : {})}, tty)) {
    return "cannot reach kitty";
  }
  if (bg) {
    const rgb = parseInt(bg.slice(1), 16);
    sendKitty("set-colors", {match_window: `var:ccx_remote=^${tag.replace(/[.\\^$*+?()[\]{}|]/g, "\\$&")}$`,
      colors: Object.fromEntries(PAINTED.map((c) => [c, rgb]))}, tty);
  }
  if (MAC) await sh("open", "-a", "kitty");
  return null;
}
