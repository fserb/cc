// Subscriptions: "tell <who> when <agent> changes state", or "... when it goes to <state>",
// or "... when any session is new" (`any is new`), which each host's daemon holds a copy of.
// They live in the daemon of the host the watched agent runs on, matched against the
// state-change events of that host's StateClock, and are answered with a chat message to
// the subscriber, on any host. Kept in a file (`~/.claude/ccx-subs.json`, each host its
// own) and read back after a restart's first poll, so a restart no longer drops them.

export const STATES = ["wait", "busy", "hold", "free", "gone"];
const UNITS = { s: 1, m: 60, h: 3600, d: 86400 };

// "90s", "30m", "2h", "1d" in seconds, or 0 when it is none of those
export function parseDuration(text) {
  const m = /^(\d+)([smhd])$/.exec(text ?? "");
  return m ? Number(m[1]) * UNITS[m[2]] : 0;
}

// `<who> when <target> [is <state>] [for <duration>]` as {who, target, state, secs}, or
// {error}. `any` and `new` come together: `<who> when [host:]any is new`
export function parseNotify(words) {
  const [who, when, target, ...rest] = words;
  if (!who || when !== "when" || !target) {
    return { error: "notify <who> when <agent> [is <state>] [for <duration>]" };
  }
  let state = "", secs = 0;
  for (let n = 0; n < rest.length; n += 2) {
    const [key, value] = [rest[n], rest[n + 1]];
    if (key === "is" && (STATES.includes(value) || value === "new")) state = value;
    else if (key === "for" && parseDuration(value)) secs = parseDuration(value);
    else if (key === "is") {
      return { error: `a state is one of ${STATES.join(", ")}` };
    } else if (key === "for") {
      return { error: "a duration is a number and s, m, h or d: 30m, 2h" };
    } else return { error: `unexpected ${JSON.stringify(key)}` };
  }
  if ((state === "new") !== /^([^:]+:)?any$/.test(target)) {
    return { error: "a new session is `when any is new`, or `when <host>:any is new`" };
  }
  return { who, target, state, secs };
}

// Whether an event (claudes.js StateClock's shape: {pid, from, to, ...}) answers a
// subscription. First sight is not a change; `gone` always answers, since nothing after it
// ever will. A `new` subscription is first sight and nothing else
export function matches(sub, ev) {
  if (sub.state === "new") return !ev.from && ev.to !== "gone";
  if (ev.pid !== sub.target.pid || !ev.from || ev.from === ev.to) return false;
  return ev.to === "gone" || !sub.state || ev.to === sub.state;
}

// The one line the subscriber gets
export function noticeText(host, sub, ev) {
  if (sub.state === "new") {
    const parts = [`new ${host}:${ev.pid}`];
    if (ev.name) parts.push(`name=${ev.name}`);
    if (ev.cwd || ev.path) parts.push(`dir=${ev.cwd || ev.path}`);
    if (ev.pane) parts.push(`pane=${ev.pane}`);
    parts.push(ev.to);
    if (ev.summary) parts.push(`title=${JSON.stringify(ev.summary)}`);
    return `[ccx notify ${host}:${sub.id}] ${parts.join(" ")}`;
  }
  const why = ev.to === "wait" && ev.asking
    ? ` (${ev.asking})`
    : ev.to === "hold" && ev.waitsOn
    ? ` (on ${ev.waitsOn})`
    : "";
  const name = ev.name || sub.target.name || ev.pid;
  return `[ccx notify ${host}:${sub.id}] ${host}:${name} ${ev.from} -> ${ev.to}${why}`;
}

export class Subs {
  // host: this host's name. deliver(subscriber, text): an error message, or null
  // file: where they are kept, or null for memory only
  constructor(host, deliver, now = () => Date.now() / 1000, file = null) {
    this.host = host;
    this.deliver = deliver;
    this.now = now;
    this.file = file;
    this.subs = new Map();
    this.next = 1;
  }

  // What the file held, less what can no longer fire: expired, or a local subscriber or
  // target that is not among `alive` (this host's pids now), since a pid that went while
  // the daemon was down sends no `gone`. Called after the first poll, so the sessions that
  // were already running are not first sight for an `any is new`
  load(alive) {
    if (!this.file) return;
    let saved;
    try {
      saved = JSON.parse(Deno.readTextFileSync(this.file));
    } catch {
      return;
    }
    const now = this.now(), live = new Set(alive);
    for (const sub of saved.subs ?? []) {
      if (sub.until && sub.until <= now) continue;
      if (sub.who.host === this.host && !live.has(sub.who.pid)) continue;
      if (!sub.target.any && !live.has(sub.target.pid)) continue;
      this.subs.set(sub.id, sub);
    }
    this.next = Math.max(this.next, saved.next ?? 1, ...[...this.subs.keys()].map((id) => id + 1));
    this.save();
  }

  // through a temp file and a rename, so a crash mid-write leaves the old file
  save() {
    if (!this.file) return;
    try {
      const tmp = `${this.file}.tmp`;
      Deno.writeTextFileSync(tmp, JSON.stringify({next: this.next, subs: [...this.subs.values()]}));
      Deno.renameSync(tmp, this.file);
    } catch (e) {
      console.error(`subs: ${this.file}: ${e.message}`);
    }
  }

  // who: {host, pid, name}; target: {pid, name}, or {any: true} for `new`; secs 0 is one shot, else repeat until then
  add({ who, target, state = "", secs = 0 }) {
    const id = this.next++;
    const at = this.now();
    this.subs.set(id, {
      id,
      who,
      target,
      state,
      at,
      until: secs ? at + secs : 0,
    });
    this.save();
    return id;
  }

  remove(id) {
    const had = this.subs.delete(id);
    if (had) this.save();
    return had;
  }

  list() {
    this.expire();
    return [...this.subs.values()];
  }

  expire() {
    const now = this.now(), size = this.subs.size;
    for (const [id, s] of this.subs) {
      if (s.until && s.until <= now) this.subs.delete(id);
    }
    if (this.subs.size !== size) this.save();
  }

  // A batch of events from the clock. Deliveries run together and are not awaited by the
  // poll; a subscriber that is no longer a claude loses its subscription, one on a host
  // that did not answer keeps it
  onEvents(events) {
    this.expire();
    const sends = [], size = this.subs.size;
    for (const ev of events) {
      for (const s of [...this.subs.values()]) {
        // a local subscriber that exited takes its subscriptions with it
        if (
          ev.to === "gone" && s.who.host === this.host && s.who.pid === ev.pid
        ) {
          this.subs.delete(s.id);
          continue;
        }
        if (!matches(s, ev)) continue;
        if (!s.until || ev.to === "gone") this.subs.delete(s.id);
        sends.push(
          Promise.resolve(this.deliver(s.who, noticeText(this.host, s, ev)))
            .then((err) => {
              if (!err) return;
              if (this.subs.delete(s.id)) this.save();
              console.error(`notify ${s.id}: ${err}`);
            }),
        );
      }
    }
    if (this.subs.size !== size) this.save();
    return Promise.all(sends);
  }
}
