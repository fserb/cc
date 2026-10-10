// SendMessage across machines, by Claude Code's own peer protocol. For every claude on
// another host this writes a stand-in record in ~/.claude/sessions and listens on the
// socket it names; a line a local session writes there goes over HTTP to the owning host,
// which writes it to the real socket. Read out of 2.1.296 and tried on it (CLAUDE.md):
//
// - a record whose `pidDomain` is not ours is listed as live, with no kill(pid, 0), and is
//   never deleted, so a stand-in is ours to remove
// - SendMessage writes one JSON line to `messagingSocketPath` as written, no auth frame; a
//   connection with no line before it is a liveness check
// - a reply, or an idle notice, goes to the `uds:<path>` the line names as `from`, top
//   level and in the envelope. So before a line is written to the real socket every
//   `uds:<path>` in it becomes a socket on the receiving host that leads back, and the
//   answer travels the same way. Those sockets have no record and need none
//
// A stand-in socket and a reply socket are the same thing, `ccx-<self>~<host>-<base>.sock`
// for the socket `<base>.sock` on `<host>`, made by the daemon `<self>`; the stand-in is
// that plus a record.

import {BYTES, HOME, UTF8} from "./sh.js";

export const SOCKS = "/tmp/cc-socks";
const SESSIONS = `${HOME}/.claude/sessions`;
const UDS = /uds:(\/[^"\s<>]+?\.sock)/g;
const SOCK_NAME = /^[\w.~-]+\.sock$/;

// Above any pid either OS hands out (macOS 99998, Linux pid_max 4194304), so discover()
// never matches a stand-in to a process, and two hosts land 5M apart
export function standInPid(host, pid) {
  let h = 0;
  for (const c of host) h = (h * 31 + c.charCodeAt(0)) % 20;
  return 90_000_000 + h * 5_000_000 + pid;
}

export const relayName = (self, host, sock) =>
  `${SOCKS}/ccx-${self}~${host}-${sock.slice(sock.lastIndexOf("/") + 1)}`;

// Whether `sock` is a path a relayed line may be written to: a socket directly in one of
// the two directories Claude Code keeps them in, SOCKS or /run/user/<uid>/cc-socks on Linux
export function deliverable(sock) {
  if (typeof sock !== "string") return false;
  const m = sock.match(/^(\/tmp\/cc-socks|\/run\/user\/\d+\/cc-socks)\/([^/]+)$/);
  return Boolean(m && SOCK_NAME.test(m[2]));
}

export class Relay {
  // self: this host's name. post(host, body) sends {from, sock, lines} to host's relay
  constructor(self, post) {
    this.self = self;
    this.post = post;
    this.links = new Map();    // local relay socket -> {host, sock, listener}
    this.standIns = new Map(); // host -> Map of record path -> [text, relay socket]
  }

  // A local socket that forwards whatever is written to it to `sock` on `host`.
  link(host, sock) {
    const path = relayName(this.self, host, sock);
    if (this.links.has(path)) return path;
    Deno.mkdirSync(SOCKS, {recursive: true, mode: 0o700});
    try {
      Deno.removeSync(path);
    } catch {
      // nothing there
    }
    const listener = Deno.listen({transport: "unix", path});
    this.links.set(path, {host, sock, listener});
    (async () => {
      try {
        for await (const conn of listener) this.forward(conn, host, sock);
      } catch {
        // closed
      }
    })();
    return path;
  }

  // Every complete line goes as it arrives: a connection is one message today, but nothing
  // promises it is closed after one
  async forward(conn, host, sock) {
    let buf = "";
    try {
      for await (const chunk of conn.readable) {
        buf += UTF8.decode(chunk, {stream: true});
        const cut = buf.lastIndexOf("\n");
        if (cut < 0) continue;
        const lines = buf.slice(0, cut).split("\n").filter((l) => l.trim());
        buf = buf.slice(cut + 1);
        if (lines.length) await this.send(host, sock, lines);
      }
      if (buf.trim()) await this.send(host, sock, [buf]);
    } catch (e) {
      console.error(`relay ${host}:${sock}: ${e.message ?? e}`);
    }
  }

  async send(host, sock, lines) {
    const err = await this.post(host, {from: this.self, sock, lines});
    if (err) console.error(`relay to ${host}:${sock}: ${err}`);
  }

  // `uds:<path>` on host `from` as it should read here: our own relay socket for it, or,
  // for a path that is itself `from`'s relay to one of ours, the socket of ours it means
  rewrite(text, from) {
    return text.replace(UDS, (_, p) => {
      const base = p.slice(p.lastIndexOf("/") + 1), mine = `ccx-${from}~${this.self}-`;
      if (base.startsWith(mine)) return `uds:${SOCKS}/${base.slice(mine.length)}`;
      return `uds:${this.link(from, p)}`;
    });
  }

  // Lines from host `from` for the local socket `sock`. An error message, or null.
  async deliver({from, sock, lines}) {
    if (typeof from !== "string" || !from || from === this.self) return "bad from";
    if (!deliverable(sock)) return `not a socket in ${SOCKS}: ${sock}`;
    if (!Array.isArray(lines) || lines.some((l) => typeof l !== "string")) return "bad lines";
    let conn;
    try {
      conn = await Deno.connect({transport: "unix", path: sock});
    } catch (e) {
      return `${sock}: ${e.message}`;
    }
    try {
      for (const l of lines) await conn.write(BYTES.encode(`${this.rewrite(l, from)}\n`));
    } catch (e) {
      return `${sock}: ${e.message}`;
    } finally {
      try {
        conn.close();
      } catch {
        // already gone
      }
    }
    return null;
  }

  // The stand-ins for `host` become exactly `rows` (its api/list rows); null removes them all
  sync(host, rows) {
    const want = new Map();     // record path -> [record text, relay socket]
    for (const r of rows ?? []) {
      if (!r.sock || !r.name || !r.status) continue;
      const pid = standInPid(host, r.pid), link = this.link(host, r.sock);
      const rec = {...standIn(host, pid, r, link), ccxBy: this.self};
      want.set(`${SESSIONS}/${pid}.json`, [JSON.stringify(rec), link]);
    }
    const had = this.standIns.get(host) ?? new Map();
    for (const [path, [, link]] of had) {
      if (want.has(path)) continue;
      remove(path);
      if (![...want.values()].some(([, l]) => l === link)) this.unlink(link);
    }
    for (const [path, [text]] of want) if (had.get(path)?.[0] !== text) writeAtomic(path, text);
    this.standIns.set(host, want);
  }

  unlink(path) {
    const l = this.links.get(path);
    if (!l) return;
    this.links.delete(path);
    try {
      l.listener.close();
    } catch {
      // closed
    }
    remove(path);
  }

  close() {
    for (const host of this.standIns.keys()) this.sync(host, null);
    for (const path of [...this.links.keys()]) this.unlink(path);
  }
}

// What a record of a live session holds, enough for ListAgents and SendMessage. `ccxBy`
// marks it as ours, for clearStandIns() after a crash; Claude Code ignores fields it does
// not know (2.1.296)
function standIn(host, pid, r, sock) {
  const rec = {pid, sessionId: r.sessionId, cwd: r.cwd, startedAt: r.startedAt,
    version: r.version, peerProtocol: 1, peerFeatures: r.peerFeatures, kind: "interactive",
    entrypoint: "cli", pidDomain: host, messagingSocketPath: sock, name: r.name,
    nameSource: "user", status: r.status, updatedAt: r.statusUpdatedAt,
    statusUpdatedAt: r.statusUpdatedAt, ccxHost: host};
  if (r.status === "waiting" && r.asking) rec.waitingFor = r.asking;
  return rec;
}

function writeAtomic(path, text) {
  const tmp = `${path}.ccx-tmp`;
  Deno.writeTextFileSync(tmp, text);
  Deno.renameSync(tmp, path);
}

function remove(path) {
  try {
    Deno.removeSync(path);
  } catch {
    // gone already
  }
}

// Stand-ins and relay sockets a previous run as `self` left, which nothing else deletes
export function clearStandIns(self) {
  try {
    for (const e of Deno.readDirSync(SESSIONS)) {
      if (!e.name.endsWith(".json") || !/^9\d{7,}\.json$/.test(e.name)) continue;
      try {
        if (JSON.parse(Deno.readTextFileSync(`${SESSIONS}/${e.name}`)).ccxBy === self) {
          remove(`${SESSIONS}/${e.name}`);
        }
      } catch {
        // unreadable: not ours to judge
      }
    }
  } catch {
    // no sessions dir
  }
  try {
    for (const e of Deno.readDirSync(SOCKS)) {
      if (e.name.startsWith(`ccx-${self}~`)) remove(`${SOCKS}/${e.name}`);
    }
  } catch {
    // no socket dir
  }
}
