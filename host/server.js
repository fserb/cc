// cchost's API over HTTP, for cc (nadya:~/web/cc): the listing, one instance's
// conversation and screen, typing into it, answering its dialogs, and starting new ones.
// With `all=1` the list is every host's, and `api/s/<host>.<pid>/...` reaches any host's
// instance through this one. No auth: every interface, with tailnetOrLocal() as the
// boundary. See server.md.
//
// - caddy's `handle_path /ccapi/*` strips the prefix: the server sees `/api/list` for
//   `https://<host>/ccapi/api/list`, from loopback with the client in X-Forwarded-For.
//   There is no page; everything is under /api
// - one 1.5s tick drives every SSE stream. It reads `source()`, the instances the caller
//   already polled, so there is one discover() per tick and not two
// - `type` runs whatever it is given, so two checks come before any route. The Host has to
//   be an address, localhost or this machine's name: a page that rebinds a name of its own
//   onto one of our addresses arrives with that name. And no cross-site request:
//   `Sec-Fetch-Site` where the browser sends it, and a POST must be `application/json`,
//   which a page on another origin cannot send without a CORS preflight this server never
//   answers

import {byCodePoint, HOME} from "./sh.js";
import {imageAt, logPath, readFrom, readPage} from "./transcript.js";
import {parseDialog, pendingAsk, pick, screen, withAsk} from "./dialog.js";
import {attachSession, select, sendKeys, show, tmuxBackground, typeInto} from "./jump.js";
import {unqueue} from "./queue.js";
import {close, expandDir, homeRel, paneIn, spawn} from "./spawn.js";
import {sendPeer} from "./peer.js";
import {byDay, LONGER, pace, readUsage} from "./usage.js";
import {localRows, series} from "./burn.js";
import {base, burnReport, burnSeries, call, HOSTS, mergedUsage, SELF} from "./remote.js";
import {STATES} from "./subs.js";
import {chatLog, mergeChats, PAIR_WINDOW, sameMessage, watchChat} from "./chat.js";
import {Online} from "./online.js";

export const PORT = 7681;
const TICK = 500;            // the open sessions' panes are read this often, for the screen and its dialog
const KEEPALIVE = 15000;     // an SSE comment this often, so no proxy calls it idle
const PASS = ["content-type", "sec-fetch-site", "last-event-id"];   // what a proxied call keeps

const HOSTNAME = Deno.hostname().split(".")[0];

// Images sent with `type`, [{type, data}] with data base64: written to IMAGES, where
// Claude Code reads them when their path is pasted (typeInto), so they are only needed
// for a moment; a file older than a day goes on the next upload. The paths, or why not.
const IMAGES = "/tmp/cc-img";
const IMAGE_MAX = 10 << 20, IMAGE_COUNT = 4;
const IMAGE_EXT = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"};
async function saveImages(images) {
  if (!images.length) return [];
  if (images.length > IMAGE_COUNT) return `at most ${IMAGE_COUNT} images`;
  await Deno.mkdir(IMAGES, {recursive: true, mode: 0o700});
  const old = Date.now() - 864e5;
  for await (const f of Deno.readDir(IMAGES)) {
    const p = `${IMAGES}/${f.name}`;
    if ((await Deno.stat(p).catch(() => null))?.mtime < old) await Deno.remove(p).catch(() => {});
  }
  const paths = [];
  for (const img of images) {
    const ext = IMAGE_EXT[img?.type];
    if (!ext || typeof img.data !== "string") return `an image is png, jpeg, gif or webp, base64`;
    if (img.data.length * 3 / 4 > IMAGE_MAX) return `an image is at most ${IMAGE_MAX >> 20} MB`;
    let bytes;
    try {
      bytes = Uint8Array.from(atob(img.data), (c) => c.charCodeAt(0));
    } catch {
      return "an image's data is not base64";
    }
    const p = `${IMAGES}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
    await Deno.writeFile(p, bytes, {mode: 0o600});
    paths.push(p);
  }
  return paths;
}

const tilde = (p) => p && p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;

// tmux order: session, window, pane, numerically, since tmux gives them as strings. Nothing
// moves on the phone when a state changes; instances outside tmux go last.
export function tmuxOrder(instances) {
  const num = (s) => s === "" ? Infinity : Number(s);
  return [...instances].sort((a, b) =>
    (a.session ? 0 : 1) - (b.session ? 0 : 1) || byCodePoint(a.session, b.session) ||
    num(a.window) - num(b.window) || num(a.paneIndex) - num(b.paneIndex) || a.pid - b.pid);
}

// A row: every field named here, every row has them all (server.md, "Rows"). The last five
// are the session record's, as Claude Code wrote it: the relay builds its stand-ins from
// them, and `status` tells `shell` from a peer hold where `state` says `hold` for both.
// Empty or 0 when there is no record (a session read off the pane)
export const ROW = ["pid", "name", "path", "cwd", "state", "asking", "waitsOn", "agents",
  "summary", "since", "hasPane", "pane", "session", "window", "paneIndex", "tab", "sessionId", "sock",
  "status", "startedAt", "version", "peerFeatures", "statusUpdatedAt"];

export function rowOf(i) {
  const p = i.peer ?? {};
  return {pid: i.pid, name: i.name, path: tilde(i.path), cwd: i.cwd, state: i.state,
    asking: i.asking, waitsOn: i.waitsOn, agents: i.agents, summary: i.summary, since: i.since,
    hasPane: Boolean(i.pane), pane: i.pane, session: i.session, window: i.window,
    paneIndex: i.paneIndex, tab: i.tab, sessionId: i.sessionId, sock: i.sock,
    status: p.status ?? "", startedAt: p.startedAt ?? 0, version: p.version ?? "",
    peerFeatures: p.peerFeatures ?? [], statusUpdatedAt: p.statusUpdatedAt ?? 0};
}

// A row of `host` as the merged list has it: `<host>.<pid>`, `<host>/<pane>`,
// `<host>:<session>`, `<host>:<path>`, so a client needs no idea of hosts
export const tagRow = (host, r) => ({...r, pid: `${host}.${r.pid}`,
  pane: r.pane ? `${host}/${r.pane}` : "", session: r.session ? `${host}:${r.session}` : "",
  path: `${host}:${r.path}`});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {status,
    headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"}});
}

// The convention typeInto() and friends share: a message, or null. Which status it gets
// is read off the message, since they come from four files that know nothing of HTTP.
function answer(err, body = {ok: true}) {
  if (!err) return json(body);
  return json({error: err}, err.startsWith("tmux:") ? 502 : 409);
}

// Subdirectories of the directory `prefix` is in whose names start with its last part,
// for the new-claude field. Hidden ones only when that part starts with a dot.
export function dirsUnder(prefix, limit = 50) {
  const full = expandDir(prefix || "~/");
  const cut = full.lastIndexOf("/") + 1;
  const [dir, part] = [full.slice(0, cut) || "/", full.slice(cut)];
  const out = [];
  try {
    for (const e of Deno.readDirSync(dir)) {
      if (!e.name.startsWith(part) || (e.name.startsWith(".") && !part.startsWith("."))) continue;
      let isDir = e.isDirectory;
      if (e.isSymlink) {
        try {
          isDir = Deno.statSync(`${dir}${e.name}`).isDirectory;
        } catch {
          isDir = false;
        }
      }
      if (isDir) out.push(tilde(`${dir}${e.name}`));
    }
  } catch {
    // no such directory: nothing under it
  }
  let exists = false;
  try {
    exists = Deno.statSync(full).isDirectory;
  } catch {
    exists = false;
  }
  return {dirs: out.sort(byCodePoint).slice(0, limit), exists};
}

const SSE_HEADERS = {"content-type": "text/event-stream", "cache-control": "no-store",
  "x-accel-buffering": "no"};

// One SSE connection. `send` drops a write to a stream the client has closed.
function stream(onClose) {
  let ctl, alive = true, timer = 0;
  const enc = new TextEncoder();
  const write = (s) => {
    if (!alive) return;
    try {
      ctl.enqueue(enc.encode(s));
    } catch {
      close();
    }
  };
  const close = () => {
    if (!alive) return;
    alive = false;
    clearInterval(timer);
    onClose();
  };
  const body = new ReadableStream({
    start(c) {
      ctl = c;
      timer = setInterval(() => write(": keepalive\n\n"), KEEPALIVE);
    },
    cancel: close,
  });
  const send = (event, data, id = null) =>
    write(`${id === null ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const end = () => {
    try {
      ctl.close();
    } catch {
      // closed already
    }
    close();
  };
  return {response: new Response(body, {headers: SSE_HEADERS}), send, close, end};
}

// Every SSE frame of a body as onFrame(event, data text, id or null)
async function frames(body, onFrame) {
  let buf = "";
  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    buf += chunk;
    let cut;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const field = (k) => frame.match(new RegExp(`^${k}: (.*)$`, "m"))?.[1];
      onFrame(field("event"), field("data"), field("id") ?? null);
    }
  }
}

const loopback = (a) => a === "::1" || /^(::ffff:)?127\./.test(a);

// The address to judge a request by: the connection's, or with one from loopback carrying
// X-Forwarded-For, the address in that header, which is caddy's client. Caddy with no
// trusted_proxies overwrites the header, so its last entry is the one caddy wrote
export function clientAddr(addr, xff) {
  if (!xff || !loopback(addr.toLowerCase())) return addr;
  return xff.split(",").at(-1).trim();
}

// Who may connect, by address: this machine (caddy's /ccapi among it) or the tailnet
// (100.64.0.0/10 and fd7a:115c:a1e0::/48). `cchost` listens on every interface, so this
// is the boundary
export function tailnetOrLocal(addr) {
  const a = addr.toLowerCase().replace(/^::ffff:/, "");
  if (loopback(a)) return true;
  if (a.startsWith("fd7a:115c:a1e0:")) return true;
  const m = a.match(/^100\.(\d+)\./);
  return Boolean(m && Number(m[1]) >= 64 && Number(m[1]) < 128);
}

// The Host a request may name: an address, or this machine's own name, bare or as a
// tailnet name, on our port. The tailnet name also with no port, which is what caddy
// passes on for `https://<host>.<tailnet>.ts.net/ccapi/...`. A page that rebinds a name of
// its own onto one of our addresses arrives with that name, and that is what this refuses
export function ownHost(host, port, self = HOSTNAME) {
  const m = host.toLowerCase().match(/^(\[[0-9a-f:.]+\]|[^:]+)(?::(\d+))?$/);
  if (!m) return false;
  const name = m[1], tsName = name.startsWith(`${self}.`) && name.endsWith(".ts.net");
  if (m[2] === undefined) return tsName;
  if (Number(m[2]) !== port) return false;
  if (name === "localhost" || name === self || name.startsWith("[")) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return true;
  return tsName;
}

export class Server {
  constructor(source, port = PORT, relay = null, subs = null) {
    this.source = source;                 // () => {instances, net}
    this.port = port;
    this.relay = relay;                   // a Relay, under `cchost`
    this.subs = subs;                     // a Subs, under `cchost`
    this.lists = new Set();               // api/events clients
    this.allLists = new Set();            // api/events?all=1 clients
    this.sessions = new Set();            // api/s/<pid>/events clients
    this.proxied = new Set();             // api/s/<host>.<pid>/events of another host
    this.chats = new Set();               // api/chat/events clients
    this.chatRoot = undefined;            // ~/.claude for chat.js, unless a test sets one
    this.lastList = "";
    this.lastAll = "";
    this.self = SELF;                     // this host, as the merged list names it
    this.hosts = HOSTS;                   // every host, in the merged list's order
    this.base = base;                     // host -> its daemon's url
    this.peers = new Map();               // host -> {body} or {error}, from its event stream
    this.timer = 0;
    this.cache = new Map();               // api/usage and api/burn answers, a minute each
  }

  // `f()`, or what it gave under `key` in the minute since it was ready. A call while
  // one is in flight waits on that one
  async cached(key, f, now = Date.now) {
    const hit = this.cache.get(key);
    if (hit && (hit.at === null || now() - hit.at < 60_000)) return await hit.body;
    const entry = {at: null, body: f()};
    this.cache.set(key, entry);
    entry.body.then(() => entry.at = now(), () => {
      if (this.cache.get(key) === entry) this.cache.delete(key);
    });
    return await entry.body;
  }

  // api/usage: this host's reading with `local=1`, which the others ask for; otherwise every
  // host's merged, with the pace and the days worked out here, so the page and `ccx usage`
  // say the same thing
  async usage(url) {
    if (url.searchParams.get("local")) return readUsage();
    return await this.cached("usage", async () => {
      const u = await mergedUsage();
      return u && {...u, pace: pace(u), pace6: pace(u, Date.now(), LONGER), days: byDay(u)};
    });
  }

  // api/burn: who used the limit, every host merged (remote.js burnReport)
  async burn(hours) {
    return await this.cached(`burn ${hours}`, () => burnReport(hours, localRows));
  }

  find(pid) {
    return this.source().instances.find((i) => i.pid === pid);
  }

  listBody() {
    const {instances, net} = this.source();
    return {rows: tmuxOrder(instances).map(rowOf), offline: net?.offline ? net.label : "",
      host: HOSTNAME};
  }

  // Another host's list, from the event stream `cchost` follows for the relay: its body
  // (`{rows, offline, host}`), or null and why the stream dropped
  peer(host, body, error = "") {
    this.peers.set(host, body ? {body} : {error: error || "stream closed"});
    this.pushList();
  }

  // every host, this one first when the host list leaves it out
  allHosts() {
    return this.hosts.includes(this.self) ? this.hosts : [this.self, ...this.hosts];
  }

  // Every host's rows, tagged (tagRow), in host-list order. `up` the hosts whose rows are
  // in, `down` [host, why] for the rest; `host` says the same as text, for a client that
  // reads it
  mergedBody() {
    const rows = [], up = [], down = [];
    let offline = "";
    for (const h of this.allHosts()) {
      const p = this.peers.get(h);
      const body = h === this.self ? this.listBody() : p?.body;
      if (!body) {
        down.push([h, p?.error ?? "no list yet"]);
        continue;
      }
      up.push(h);
      rows.push(...body.rows.map((r) => tagRow(h, r)));
      offline ||= body.offline ?? "";
    }
    return {rows, offline, up, down, self: this.self, hosts: this.allHosts(),
      host: up.join(" · ") + (down.length ? ` (${down.map(([h]) => h).join(", ")} down)` : "")};
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((e) => console.error(e)), TICK);
  }

  stop() {
    clearInterval(this.timer);
    for (const c of [...this.lists, ...this.allLists, ...this.sessions, ...this.proxied,
      ...this.chats]) c.close();
  }

  // the list to its streams if it changed; `cchost` also calls it after each poll, and
  // peer() when another host's list arrives
  pushList() {
    if (this.lists.size) {
      const body = this.listBody(), text = JSON.stringify(body);
      if (text !== this.lastList) {
        this.lastList = text;
        for (const c of this.lists) c.send("list", body);
      }
    }
    if (this.allLists.size) {
      const body = this.mergedBody(), text = JSON.stringify(body);
      if (text !== this.lastAll) {
        this.lastAll = text;
        for (const c of this.allLists) c.send("list", body);
      }
    }
  }

  // one at a time: `cchost` also calls it when a record changes, so a dialog shows once the
  // record says wait, and a call during one runs once more after it
  async tick() {
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.again = false;
        await this.tickOnce();
      } while (this.again);
    } finally {
      this.ticking = false;
    }
  }

  async tickOnce() {
    this.pushList();
    // one capture per pane per tick, however many clients watch it
    const screens = new Map();
    for (const c of this.sessions) {
      const inst = this.find(c.pid);
      if (!inst) {
        c.send("gone", {pid: c.tag ? `${c.tag}.${c.pid}` : c.pid});
        c.close();
        continue;
      }
      if (inst.pane && !screens.has(inst.pane)) screens.set(inst.pane, screen(inst.pane));
    }
    for (const c of [...this.sessions]) {
      const inst = this.find(c.pid);
      if (inst) await this.follow(c, inst, inst.pane ? await screens.get(inst.pane) : null);
    }
  }

  // What changed for one session client since its last tick: the row, the log, the screen
  // and the dialog read off it.
  async follow(c, inst, text) {
    const row = JSON.stringify(rowOf(inst));
    if (row !== c.row) {
      c.row = row;
      c.send("state", c.tag ? tagRow(c.tag, rowOf(inst)) : rowOf(inst));
    }
    // a /clear starts a new log under a new sessionId, so the path is checked every tick
    const path = inst.sessionId ? logPath(inst.cwd, inst.sessionId) : "";
    if (path !== c.path) {
      const first = c.path === undefined && c.end !== null;
      c.path = path;
      if (first) {
        const r = readFrom(path, c.end);
        c.end = r.end;
        c.send("log", r, r.end);
      } else {
        const p = path ? readPage(path) : {events: [], start: 0, end: 0};
        c.end = p.end;
        c.send("log", {...p, reset: true}, p.end);
      }
    } else if (path) {
      const r = readFrom(path, c.end);
      if (r.events.length || r.reset) c.send("log", r, r.end);
      c.end = r.end;
    }
    if (text === null) return;
    if (text !== c.screen) {
      c.screen = text;
      c.send("screen", {text});
    }
    // parsed every tick, not on a new screen: the dialog draws before the record says wait
    // the question tool's text comes from askhook.sh's file, the pane says which question and how to answer
    const parsed = inst.state === "wait" ? parseDialog(text) : null;
    const dialog = parsed && withAsk(parsed, pendingAsk(inst.sessionId, path));
    const d = JSON.stringify(dialog);
    if (d !== c.dialog) {
      c.dialog = d;
      c.send("dialog", dialog);
    }
  }

  listEvents(all = false) {
    const set = all ? this.allLists : this.lists;
    const c = stream(() => set.delete(c));
    set.add(c);
    c.send("list", all ? this.mergedBody() : this.listBody());
    return c.response;
  }

  // `from` is the byte offset the page already has, from api/s/<pid>/log or Last-Event-ID
  // on a reconnect. Without one the stream starts with the tail, as a reset. `tag`, a host:
  // the rows in it are tagged as the merged list's are
  sessionEvents(pid, from, tag = "") {
    const c = stream(() => this.sessions.delete(c));
    Object.assign(c, {pid, tag, end: from, path: undefined, row: "", screen: null, dialog: ""});
    this.sessions.add(c);
    const inst = this.find(pid);
    if (!inst) return c.response;
    // the row and the log at once, then the screen and its dialog as soon as tmux gives it,
    // not on the next tick
    this.follow(c, inst, null).catch((e) => console.error(e));
    if (inst.pane) {
      screen(inst.pane).then((text) => {
        if (text !== null && this.sessions.has(c)) return this.follow(c, inst, text);
      }).catch((e) => console.error(e));
    }
    return c.response;
  }

  // api/chat/events: what chat.js reads out of the transcripts of `cwd`, this host's only:
  // `log` {msgs} at once, then `msg` with each new one
  chatEvents(cwd) {
    let stop = () => {};
    const c = stream(() => {
      this.chats.delete(c);
      stop();
    });
    this.chats.add(c);
    stop = watchChat(cwd, (m) => c.send("msg", m), {root: this.chatRoot});
    stop.ready.then((msgs) => c.send("log", {msgs}));
    return c.response;
  }

  // api/chat?all=1: every host's log of one directory, merged (chat.js mergeChats). A path
  // under HOME is the same path under each host's own, so ~/ai/cc is /home/fserb/ai/cc on
  // nadya and /Users/fserb/ai/cc on marx; any other path is asked for as it is. `down`
  // [host, why] for each host that did not answer
  async allChat(cwd, since = 0) {
    const tilde = cwd === HOME || cwd.startsWith(`${HOME}/`) ? `~${cwd.slice(HOME.length)}` : cwd;
    const q = `/api/chat?cwd=${encodeURIComponent(tilde)}&since=${since}`;
    const lists = [], down = [];
    await Promise.all(this.allHosts().map(async (h) => {
      if (h === this.self) return lists.push([h, await chatLog(cwd, {since, root: this.chatRoot})]);
      try {
        const r = await fetch(`${this.base(h)}${q}`, {signal: AbortSignal.timeout(30_000)});
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error ?? `answered ${r.status}`);
        lists.push([h, body.msgs]);
      } catch (e) {
        down.push([h, e.message]);
      }
    }));
    return {msgs: mergeChats(lists), down};
  }

  // api/chat/events?all=1: allChat's log, then every 2s what is new. A poll, since the
  // other hosts' logs are only reachable by asking; each asks for what was written since
  // the stream started less PAIR_WINDOW, so a copy that arrives late still finds its twin
  allChatEvents(cwd) {
    let timer = 0, stopped = false;
    const c = stream(() => {
      this.chats.delete(c);
      stopped = true;
      clearTimeout(timer);
    });
    this.chats.add(c);
    const since = Date.now() / 1000 - PAIR_WINDOW, sent = [];
    const seen = (m) => sent.some((s) => sameMessage(s, m) || (s.host === m.host &&
      s.sessionId === m.sessionId && s.at === m.at && s.body === m.body));
    const tick = async (first) => {
      const {msgs, down} = await this.allChat(cwd, first ? 0 : since);
      if (stopped) return;
      if (first) {
        c.send("log", {msgs, down});
        sent.push(...msgs.filter((m) => m.at >= since));
      } else {
        for (const m of msgs) {
          if (seen(m)) continue;
          sent.push(m);
          c.send("msg", m);
        }
      }
      timer = setTimeout(() => tick(false).catch((e) => console.error(e)), 2000);
    };
    tick(true).catch((e) => console.error(e));
    return c.response;
  }

  // api/subs and api/unsub of another host, `host` in the query or the body: passed to
  // its daemon as it would have been called there
  async subsElsewhere(method, host, path, body) {
    if (!this.allHosts().includes(host)) return json({error: `no host ${host}`}, 404);
    try {
      const r = await fetch(`${this.base(host)}${path}`, {method,
        headers: {"content-type": "application/json"},
        body: method === "POST" ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000)});
      return new Response(r.body, {status: r.status, headers: r.headers});
    } catch (e) {
      return json({error: `${host}: ${e.message}`}, 502);
    }
  }

  // `<host>:rest` or `<host>/rest` with a known host, else [null, text]
  split(text, sep) {
    const at = text.indexOf(sep), host = at > 0 ? text.slice(0, at) : "";
    return this.allHosts().includes(host) ? [host, text.slice(at + 1)] : [null, text];
  }

  // `req` to another host's daemon: same method, body and the headers its checks read
  async pass(req, host, path, signal = AbortSignal.timeout(15_000)) {
    const headers = new Headers();
    for (const h of PASS) if (req.headers.has(h)) headers.set(h, req.headers.get(h));
    const body = req.method === "POST" ? await req.text() : undefined;
    return await fetch(`${this.base(host)}${path}`, {method: req.method, headers, body, signal});
  }

  // api/focus {id: "<host>.<pid>", on: host}: the instance shown in a kitty window on `on`,
  // the machine you sit at, so it runs there. One of its own by show(); another host's by
  // selecting its pane there and a kitty window attached over ssh, as `ccx focus` does
  async focusRoute(req) {
    const body = await req.json().catch(() => ({}));
    const on = String(body.on ?? this.self), m = String(body.id ?? "").match(/^([a-z][\w-]*)\.(\d+)$/i);
    if (!m) return json({error: "id is <host>.<pid>"}, 400);
    if (!this.allHosts().includes(on)) return json({error: `no host ${on}`}, 404);
    if (on !== this.self) return await this.subsElsewhere("POST", on, "/api/focus", body);
    const [, host, pid] = m;
    console.log(`focus ${host}.${pid}`);
    if (host === this.self) {
      const inst = this.find(Number(pid));
      if (!inst) return json({error: `no claude instance with pid ${pid}`}, 404);
      return answer(await show(inst));
    }
    if (!this.allHosts().includes(host)) return json({error: `no host ${host}`}, 404);
    try {
      const r = await fetch(`${this.base(host)}/api/s/${pid}/select`, {method: "POST",
        headers: {"content-type": "application/json"}, body: "{}",
        signal: AbortSignal.timeout(15_000)});
      const got = await r.json().catch(() => ({}));
      if (!r.ok) return json({error: got.error ?? `${host}: HTTP ${r.status}`}, r.status);
      if (!got.session) return json({error: `${host}'s cchost has no session in select; restart it on newer code`}, 502);
      return answer(await attachSession(host, got.session, got.background));
    } catch (e) {
      return json({error: `${host}: ${e.message}`}, 502);
    }
  }

  // api/s/<host>.<pid>/<verb> of another host, as it answered
  async proxy(req, host, pid, verb, search) {
    if (verb === "events") return this.proxyEvents(req, host, pid, search);
    try {
      const r = await this.pass(req, host, `/api/s/${pid}/${verb}${search}`);
      return new Response(r.body, {status: r.status, headers: r.headers});
    } catch (e) {
      return json({error: `${host}: ${e.message}`}, 502);
    }
  }

  // Another host's session stream, its rows tagged as the merged list's are
  proxyEvents(req, host, pid, search) {
    const ctl = new AbortController();
    const c = stream(() => {
      this.proxied.delete(c);
      ctl.abort();
    });
    this.proxied.add(c);
    (async () => {
      try {
        const r = await this.pass(req, host, `/api/s/${pid}/events${search}`, ctl.signal);
        if (!r.ok) {
          c.send("gone", {pid: `${host}.${pid}`});
        } else {
          await frames(r.body, (event, data, id) => {
            let d = JSON.parse(data);
            if (event === "state") d = tagRow(host, d);
            if (event === "gone") d = {pid: `${host}.${pid}`};
            c.send(event, d, id);
          });
        }
      } catch {
        // the host went away or the client did
      }
      c.end();
    })();
    return c.response;
  }

  // api/dirs: `host:prefix` asks that host, and its dirs come back `host:`-tagged. A bare
  // prefix is this host's, or with `all` every host's
  async dirs(prefix, all) {
    const [host, rest] = this.split(prefix, ":");
    if (!host && !all) return dirsUnder(prefix);
    const got = await Promise.all((host ? [host] : this.allHosts()).map(async (h) => {
      const body = h === this.self ? dirsUnder(rest)
        : (await call(h, `/api/dirs?prefix=${encodeURIComponent(homeRel(rest))}`))[0];
      return {dirs: (body?.dirs ?? []).map((d) => `${h}:${d}`), exists: Boolean(body?.exists)};
    }));
    return {dirs: got.flatMap((g) => g.dirs), exists: Boolean(host) && got[0].exists};
  }

  // api/spawn: on the host its `after` pane (`host/<pane>`) or its dir (`host:dir`) names,
  // with its pid and pane tagged as the list's; with neither, here as before
  async spawnRoute(req) {
    const body = await req.json().catch(() => ({}));
    let host = null;
    if (body.after) [host, body.after] = this.split(String(body.after), "/");
    const [dirHost, dir] = this.split(String(body.dir ?? ""), ":");
    host ??= dirHost;
    body.dir = dir && homeRel(dir);
    let status, out;
    if (!host || host === this.self) {
      out = await this.spawnHere(body);
      status = out.error ? (out.pane ? 502 : 409) : 200;
      if (!host) return json(out, status);
    } else {
      try {
        const r = await fetch(`${this.base(host)}/api/spawn`, {method: "POST",
          headers: {"content-type": "application/json",
            "sec-fetch-site": req.headers.get("sec-fetch-site") ?? "same-origin"},
          body: JSON.stringify(body), signal: AbortSignal.timeout(30_000)});
        [status, out] = [r.status, await r.json()];
      } catch (e) {
        return json({error: `${host}: ${e.message}`}, 502);
      }
    }
    if (out.pid) out.pid = `${host}.${out.pid}`;
    if (out.pane) out.pane = `${host}/${out.pane}`;
    return json(out, status);
  }

  // a detached tmux session unless `focus`; then `after` a pane, or with `beside` after
  // the last claude already in dir, else a new kitty window
  async spawnHere(body) {
    const focus = body.focus === true;
    let after = focus ? String(body.after ?? "") : "";
    if (!after && focus && body.beside === true) {
      try {
        after = await paneIn(Deno.realPathSync(expandDir(String(body.dir ?? ""))));
      } catch {
        // no such dir: spawn() says so
      }
    }
    const r = await spawn({dir: String(body.dir ?? ""), after,
      mkdir: body.mkdir === true, name: String(body.name ?? ""), focus});
    return r.error ? r : {...r, after};
  }

  async handle(req, info = null) {
    const url = new URL(req.url);
    let path = url.pathname.replace(/\/+$/, "") || "/";
    const get = req.method === "GET", post = req.method === "POST";
    if (info && !tailnetOrLocal(clientAddr(info.remoteAddr.hostname,
      req.headers.get("x-forwarded-for")))) {
      return json({error: "not tailnet"}, 403);
    }
    if (!ownHost(req.headers.get("host") ?? "", this.port)) return json({error: "bad host"}, 403);
    if (req.headers.get("sec-fetch-site") === "cross-site") {
      return json({error: "cross-site"}, 403);
    }
    if (post && !(req.headers.get("content-type") ?? "").startsWith("application/json")) {
      return json({error: "a POST is application/json"}, 415);
    }
    if (Number(req.headers.get("content-length")) > IMAGE_COUNT * IMAGE_MAX * 1.4) {
      return json({error: "too large"}, 413);
    }
    const all = url.searchParams.get("all") === "1";
    if (get && path === "/api/list") return json(all ? this.mergedBody() : this.listBody());
    if (get && path === "/api/events") return this.listEvents(all);
    if (get && path === "/api/usage") return json({usage: await this.usage(url)});
    if (get && path === "/api/burn/rows") {
      const n = (k) => Number(url.searchParams.get(k));
      if (!(n("from") < n("to"))) return json({error: "from < to, in ms"}, 400);
      return json({rows: await localRows(n("from"), n("to"))});
    }
    if (get && path === "/api/burn/series") {
      // n steps of `step` ms, 24 x 5 min by default; `local=1` this host's alone
      const n = Math.min(288, Number(url.searchParams.get("n")) || 24);
      const step = Math.max(60_000, Number(url.searchParams.get("step")) || 300_000);
      if (url.searchParams.get("local")) return json(await series(n, step, Number(url.searchParams.get("at")) || Date.now()));
      return json(await this.cached(`series ${n} ${step}`, () => burnSeries(n, step)));
    }
    if (get && path === "/api/burn") return json(await this.burn(Number(url.searchParams.get("hours")) || 0));
    if (post && path === "/api/relay") {
      if (!this.relay) return json({error: "no relay here; it runs under cchost"}, 409);
      return answer(await this.relay.deliver(await req.json().catch(() => ({}))));
    }
    if (get && path === "/api/doctor") {
      const net = new Online(), probe = await net.probe();
      return json({self: this.self, api: {url: net.url, from: net.from, ...probe}});
    }
    if (get && (path === "/api/chat" || path === "/api/chat/events")) {
      let cwd = url.searchParams.get("cwd") ?? "";
      if (cwd === "~" || cwd.startsWith("~/")) cwd = HOME + cwd.slice(1);
      if (!cwd.startsWith("/")) return json({error: "cwd is an absolute path or ~/..."}, 400);
      const all = url.searchParams.get("all") === "1";
      const since = Number(url.searchParams.get("since")) || 0;
      if (path === "/api/chat/events") return all ? this.allChatEvents(cwd) : this.chatEvents(cwd);
      if (all) return json({cwd, ...await this.allChat(cwd, since)});
      return json({cwd, msgs: await chatLog(cwd, {since, root: this.chatRoot})});
    }
    if (path === "/api/subs" || path === "/api/unsub") {
      if (!get && !post) return json({error: "not found"}, 404);
      const body = post ? await req.json().catch(() => ({})) : {};
      const host = (get ? url.searchParams.get("host") : body.host) || this.self;
      if (host !== this.self) {
        delete body.host;
        return await this.subsElsewhere(req.method, host, path, body);
      }
      if (!this.subs) return json({error: "no subscriptions here; they run under cchost"}, 409);
      if (get && path === "/api/subs") return json({subs: this.subs.list()});
      if (!post) return json({error: "not found"}, 404);
      if (path === "/api/unsub") {
        return this.subs.remove(Number(body.id)) ? json({ok: true})
          : json({error: `no subscription ${body.id}`}, 404);
      }
      const {who, state = "", secs = 0} = body, pid = Number(body.pid);
      if (!who?.host || !Number.isInteger(who.pid) || typeof secs !== "number" || secs < 0 ||
        !(body.any === true ? state === "new" : STATES.includes(state || "wait"))) {
        return json({error: "malformed subscription"}, 400);
      }
      if (body.any === true) {
        const id = this.subs.add({who: {host: String(who.host), pid: who.pid,
          name: String(who.name ?? "")}, target: {any: true}, state, secs});
        return json({id, state: "new"});
      }
      const inst = this.find(pid);
      if (!inst) return json({error: `no claude instance with pid ${pid}`}, 404);
      const id = this.subs.add({who: {host: String(who.host), pid: who.pid,
        name: String(who.name ?? "")}, target: {pid, name: inst.name}, state, secs});
      return json({id, state: inst.state});
    }
    if (get && path === "/api/dirs") {
      return json(await this.dirs(url.searchParams.get("prefix") ?? "", all));
    }
    if (post && path === "/api/spawn") return await this.spawnRoute(req);
    if (post && path === "/api/focus") return await this.focusRoute(req);
    // `<host>.<pid>`, the merged list's id: another host's goes there, this host's is `<pid>`
    let tag = "";
    const hm = path.match(/^\/api\/s\/([a-z][\w-]*)\.(\d+)\/(\w+)$/i);
    if (hm) {
      const [, host, pid, verb] = hm;
      if (host !== this.self) {
        if (!this.hosts.includes(host)) return json({error: `no host ${host}`}, 404);
        return await this.proxy(req, host, pid, verb, url.search);
      }
      tag = host;
      path = `/api/s/${pid}/${verb}`;
    }
    const m = path.match(/^\/api\/s\/(\d+)\/(log|img|events|type|pick|now|unqueue|screen|send|select|close)$/);
    if (!m) return json({error: "not found"}, 404);
    const [, pidText, verb] = m, pid = Number(pidText);
    // the pid has to be a claude in the current poll: a pane whose claude exited types
    // into whatever shell took it over, which would run the text
    const inst = this.find(pid);
    if (!inst) return json({error: `no claude instance with pid ${pid}`}, 404);
    if (get && verb === "log") {
      if (!inst.sessionId) return json({events: [], start: 0, end: 0});
      const before = url.searchParams.get("before");
      return json(readPage(logPath(inst.cwd, inst.sessionId), before === null ? null : Number(before)));
    }
    // the i-th image of the prompt whose line starts at byte `at`, the `img` of its event
    if (get && verb === "img") {
      const at = Number(url.searchParams.get("at")), i = Number(url.searchParams.get("i") ?? 0);
      const got = inst.sessionId ? imageAt(logPath(inst.cwd, inst.sessionId), at, i) : null;
      if (!got) return json({error: "no image there"}, 404);
      return new Response(got.bytes, {headers: {"content-type": got.type,
        "cache-control": "private, max-age=86400"}});
    }
    if (get && verb === "events") {
      const id = req.headers.get("last-event-id") ?? url.searchParams.get("from");
      return this.sessionEvents(pid, id === null || id === "" ? null : Number(id), tag);
    }
    if (get && verb === "screen") {
      if (!inst.pane) return json({error: `pid ${pid} is not inside tmux`}, 409);
      const text = await screen(inst.pane);
      return text === null ? json({error: "tmux: capture failed"}, 502)
        : json({text, dialog: inst.state === "wait" ? withAsk(parseDialog(text),
          pendingAsk(inst.sessionId, inst.sessionId && logPath(inst.cwd, inst.sessionId))) : null});
    }
    if (!post) return json({error: "not found"}, 404);
    const body = await req.json().catch(() => ({}));
    if (verb === "send") {
      if (typeof body.text !== "string" || !body.text.trim()) return json({error: "no text"}, 400);
      return answer(await sendPeer(inst, body.text, body.from ?? undefined));
    }
    if (verb === "type") {
      const images = Array.isArray(body.images) ? body.images : [];
      if (typeof body.text !== "string" || (!body.text.trim() && !images.length)) {
        return json({error: "no text"}, 400);
      }
      const paths = await saveImages(images);
      if (typeof paths === "string") return json({error: paths}, 400);
      return answer(await typeInto(inst, body.text, {force: body.force === true, images: paths}));
    }
    if (verb === "pick") {
      if (!Array.isArray(body.labels)) return json({error: "no labels"}, 400);
      return answer(await pick(inst, Number(body.i), body.labels, body.text ?? undefined));
    }
    // Claude Code's chat:sendNow: with an empty input it stops the turn and sends the queued messages
    if (verb === "now") return answer(await sendKeys(inst, ["C-x", "C-s"]));
    // with `text`, that queued message alone comes out (queue.js); without, every one
    if (verb === "unqueue") {
      const {text} = body;
      if (text !== undefined && (typeof text !== "string" || !text.trim())) {
        return json({error: "no text"}, 400);
      }
      const r = await unqueue(inst, text);
      return answer(r.error ?? null, text === undefined ? {ok: true} : {ok: true, kept: r.kept});
    }
    if (verb === "select") {
      return answer(await select(inst), {ok: true, background: await tmuxBackground(),
        session: inst.session});
    }
    if (verb === "close") return answer(await close(inst));
    return json({error: "not found"}, 404);
  }
}

// Start serving. {server, stop} or {error}: a port already taken is reported, not thrown,
// so a caller can say why.
export function runServer({source, port = PORT, hostname = "127.0.0.1", relay = null,
  subs = null}) {
  const s = new Server(source, port, relay, subs);
  let http;
  try {
    http = Deno.serve({port, hostname, onListen() {}}, (req, info) => s.handle(req, info).catch((e) =>
      json({error: String(e?.message ?? e)}, 500)));
  } catch (e) {
    return {error: `${hostname}:${port}: ${e.message}`};
  }
  s.start();
  return {server: s, stop: async () => {
    s.stop();
    await http.shutdown();
  }};
}
