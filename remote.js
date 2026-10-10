// The other machines' claudes, through the `ccx host` daemon each one runs. Names read
// `host:name` and paths `host:~/path`; the local host is discover() as it always was, so
// the CLI works with no daemon here.

import {discover, Instance, kittyOwner, processes} from "./claudes.js";
import {sendKitty} from "./jump.js";
import {MAC, sh} from "./sh.js";
import {readUsage} from "./usage.js";

export const PORT = 7681;
export const SELF = Deno.env.get("CCX_SELF") ?? Deno.hostname().split(".")[0];
const TIMEOUT = 3000;

// every machine that runs claudes, this one included. CCX_HOSTS=a,b overrides, and an
// entry `name=addr:port` reaches name somewhere else, which is how two daemons share a box
const ENTRIES = (Deno.env.get("CCX_HOSTS") ?? "marx,nadya").split(",")
  .map((h) => h.trim().split("=")).filter(([h]) => h);
export const HOSTS = ENTRIES.map(([h]) => h);
const ADDR = new Map(ENTRIES.map(([h, a]) => [h, a ?? `${h}:${PORT}`]));
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
// then a higher figure, which only goes up within a week
export async function bestUsage() {
  const all = [readUsage(), ...(await Promise.all(others().map(async (h) =>
    (await call(h, "/api/usage"))[0]?.usage)))].filter((u) => u);
  return all.reduce((a, b) => !a || b.resetsAt > a.resetsAt ||
    (b.resetsAt === a.resetsAt && b.used > a.used) ? b : a, null);
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
// the window hangs the client up, and tmux keeps a session whose client got SIGHUP
const attachArgs = (i) => ["ssh", "-t", i.host, "tmux", "attach", "-t", i.session];

// Focus a remote instance: its host selects the window and pane, then the kitty window
// already attached to that session comes to the front, or a new one opens attached.
// An error message, or null
export async function jumpRemote(i) {
  if (!i.pane) return `${label(i)} is not inside tmux; nothing to focus`;
  const [, err] = await call(i.host, `/api/s/${i.pid}/select`, {});
  if (err) return err;
  const want = attachArgs(i).join(" "), procs = await processes();
  for (const [pid, [, cmd]] of procs) {
    if (cmd !== want) continue;
    const [child, kitty] = kittyOwner(pid, procs);
    if (!kitty) continue;
    sendKitty("focus-window", {match: `pid:${child}`});
    if (MAC) await sh("open", "-a", "kitty");
    return null;
  }
  sendKitty("launch", {args: attachArgs(i), type: "os-window"});
  if (MAC) await sh("open", "-a", "kitty");
  return null;
}
