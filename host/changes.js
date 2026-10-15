// Session changes as they happen, for trig and anything else that wants them without
// polling api/list: GET api/changes (SSE), `?all=1` every host's. Each is one StateClock
// event read into a `what` (whatOf), or a context size crossing a 100k mark. The last SIZE
// are kept, so a client reconnecting with Last-Event-ID or `?since=` gets what it missed;
// what this buffer cannot cover is said with a `lost` entry instead. See server.md.

import { HOME } from "./sh.js";

const SIZE = 2000;
export const CONTEXT_STEP = 100_000;

// Whether a session ended on purpose: Claude Code puts no line in the transcript for /exit
// (alias /quit), but its prompt history does, `{"display":"/quit",...,"timestamp":<ms>,
// "sessionId":...}` (2.1.300). The slash command runs as a short busy, so without this its
// end read as `crashed`. True when that session's last history line is one, under a minute old
const HISTORY = `${HOME}/.claude/history.jsonl`;
export function quitByHand(sessionId, now = Date.now(), path = HISTORY) {
  if (!sessionId) return false;
  let text;
  try {
    const f = Deno.openSync(path);
    try {
      const size = f.statSync().size;
      const n = Math.min(size, 65536);
      f.seekSync(size - n, Deno.SeekMode.Start);
      const buf = new Uint8Array(n);
      let got = 0;
      while (got < n) {
        const r = f.readSync(buf.subarray(got));
        if (!r) break;
        got += r;
      }
      text = new TextDecoder().decode(buf.subarray(0, got));
    } finally {
      f.close();
    }
  } catch {
    return false;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(sessionId)) continue;
    let h;
    try {
      h = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (h.sessionId !== sessionId) continue;
    return /^\/(exit|quit)(\s|$)/.test((h.display ?? "").trim()) && now - h.timestamp < 60_000;
  }
  return false;
}

const tilde = (p) => p && p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;

// The one word for a StateClock event: `crashed` ended while busy (a turn or delegated
// work in flight) and not by /exit (`quit`), `gone` ended otherwise; `asking` a wait on a dialog or on a question
// its last reply ended with (`question`), `done` a turn
// that finished into a plain wait, `wait` any other plain wait; `new` first sight
export function whatOf(ev) {
  if (ev.to === "gone") return ev.from === "busy" && !ev.quit ? "crashed" : "gone";
  if (!ev.from) return "new";
  if (ev.to === "wait") {
    return ev.asking || ev.question
      ? "asking"
      : ev.from === "busy"
      ? "done"
      : "wait";
  }
  return ev.to;
}

const KEEP = ["name", "cwd", "path", "sessionId", "summary", "goal", "context"];

export class Changes {
  // self: this host's name. now() in ms, for the ids
  // quit(sessionId): whether it ended by /exit, asked only of a busy -> gone
  constructor(self, now = Date.now, size = SIZE, quit = quitByHand) {
    this.self = self;
    this.quit = quit;
    this.now = now;
    this.size = size;
    this.buf = [];
    this.last = 0;
    this.last = this.nextId();
    this.start = this.last; // what came before this is not here: a restart
    this.dropped = 0; // the id of the last entry trimmed off the buffer
    this.marks = new Map(); // pid -> the context mark it is past
    this.known = new Map(); // pid -> its last non-empty name, cwd, path, sessionId, summary, goal, context
    this.listeners = new Set();
  }

  // an id that only goes up, across restarts too as long as the clock does: ms since the epoch,
  // or one past the last when two come in the same ms
  nextId() {
    this.last = Math.max(this.last + 1, this.now());
    return this.last;
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  push(entry) {
    entry = { id: this.nextId(), ...entry };
    this.buf.push(entry);
    if (this.buf.length > this.size) {
      this.dropped = this.buf.splice(0, this.buf.length - this.size).at(-1).id;
    }
    for (const fn of this.listeners) {
      try {
        fn(entry);
      } catch (e) {
        console.error(e);
      }
    }
    return entry;
  }

  // A poll's StateClock events and its instances (for goal and context). The first call
  // only takes each session's context mark; after that one crossing a mark upward is a
  // `context` change, and a drop (a /clear) lowers the mark so the next crossing counts
  update(events, instances) {
    const by = new Map(instances.map((i) => [i.pid, i]));
    // a session's record goes before its process, so the poll before its `gone` can see it
    // with no name: each field keeps the last value it had
    for (const i of instances) {
      const k = this.known.get(i.pid) ?? {};
      for (const f of KEEP) if (i[f]) k[f] = i[f];
      this.known.set(i.pid, k);
    }
    for (const ev of events) {
      const k = this.known.get(ev.pid) ?? {};
      const full = {...ev};
      for (const f of KEEP) full[f] = ev[f] || by.get(ev.pid)?.[f] || k[f] || "";
      if (ev.to === "gone" && ev.from === "busy") full.quit = this.quit(full.sessionId);
      this.push(this.change(full, whatOf(full), full));
    }
    for (const pid of [...this.known.keys()]) {
      if (!by.has(pid)) this.known.delete(pid);
    }
    for (const i of instances) {
      const mark = Math.floor((i.context || 0) / CONTEXT_STEP) * CONTEXT_STEP;
      const had = this.marks.get(i.pid);
      this.marks.set(i.pid, mark);
      if (had === undefined || mark <= had) continue;
      this.push(
        this.change(
          {
            pid: i.pid,
            name: i.name,
            sessionId: i.sessionId,
            cwd: i.cwd,
            path: i.path,
            from: i.state,
            to: i.state,
            asking: i.asking,
            question: i.question,
            waitsOn: i.waitsOn,
            summary: i.summary,
          },
          "context",
          i,
          { over: mark },
        ),
      );
    }
    for (const pid of [...this.marks.keys()]) {
      if (!by.has(pid)) this.marks.delete(pid);
    }
  }

  change(ev, what, i, extra = {}) {
    const h = this.self;
    return {
      host: h,
      pid: `${h}.${ev.pid}`,
      name: ev.name ?? "",
      dir: `${h}:${tilde(ev.cwd || ev.path || "")}`,
      cwd: ev.cwd ?? "",
      sessionId: ev.sessionId ?? "",
      from: ev.from,
      to: ev.to,
      what,
      asking: ev.asking ?? "",
      question: ev.question ?? "",
      waitsOn: ev.waitsOn ?? "",
      summary: ev.summary ?? "",
      goal: i?.goal || "",
      context: i?.context || 0,
      ...extra,
      at: Math.round(this.now() / 1000),
    };
  }

  // another host's change, from its own stream, under an id of ours
  remote(entry) {
    const { id: _, ...rest } = entry;
    return this.push(rest);
  }

  // changes of `host` may be missing from here on
  lost(host) {
    return this.push({ host, what: "lost", at: Math.round(this.now() / 1000) });
  }

  // What a client that has everything up to `since` missed: the hosts whose changes may be
  // gone (since is from before a restart, or older than the buffer), then the entries. Not
  // `all`: this host's alone
  after(since, all, hosts = [this.self]) {
    const lost = since < this.start || since < this.dropped
      ? (all ? hosts : [this.self])
      : [];
    const items = this.buf.filter((e) =>
      e.id > since && (all || e.host === this.self)
    );
    return { lost, items };
  }
}
