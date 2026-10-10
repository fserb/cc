// The other machines' claudes, through the `ccx host` daemon each one runs. Names read
// `host:name` and paths `host:~/path`; the local host is discover() as it always was, so
// the CLI works with no daemon here.

import {discover, Instance} from "./claudes.js";

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
export async function call(host, path, body = undefined) {
  const init = {signal: AbortSignal.timeout(TIMEOUT)};
  if (body !== undefined) {
    Object.assign(init, {method: "POST", body: JSON.stringify(body),
      headers: {"content-type": "application/json"}});
  }
  try {
    const r = await fetch(`${base(host)}${path}`, init);
    const j = await r.json().catch(() => ({}));
    return r.ok ? [j, null] : [null, j.error ?? `${r.status}`];
  } catch (e) {
    return [null, e.name === "TimeoutError" ? `${host}: no answer in ${TIMEOUT}ms`
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

