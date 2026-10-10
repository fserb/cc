// ccx over HTTP, for a phone on the tailnet: the listing, one instance's conversation and
// screen, typing into it, answering its dialogs, and starting new ones. No auth: it binds
// 127.0.0.1 and caddy puts it on the tailnet name, which is the boundary. See server.md.
//
// - every URL the page uses is relative, since caddy's `handle_path /ccx*` strips the
//   prefix: the server sees `/api/list` for `https://<host>/ccx/api/list`
// - one 1.5s tick drives every SSE stream. It reads `source()`, the instances the caller
//   already polled, so inside the systray there is one discover() per tick and not two
// - **inside the bundle the first `Deno.serve` loses its port** to the runtime's startup
//   window, so the systray has to start this after its own
// - `type` runs whatever it is given, so two checks come before any route. The Host has to
//   be 127.0.0.1 or localhost on our port: a page that rebinds a name of its own onto
//   127.0.0.1 arrives with that name, and caddy is told to send the upstream's
//   (`header_up Host {upstream_hostport}`). And no cross-site request: `Sec-Fetch-Site`
//   where the browser sends it, and a POST must be `application/json`, which a page on
//   another origin cannot send without a CORS preflight this server never answers

import {byCodePoint, HOME} from "./sh.js";
import {logPath, readFrom, readPage} from "./transcript.js";
import {parseDialog, pick, screen} from "./dialog.js";
import {sendKeys, typeInto} from "./jump.js";
import {expandDir, spawn} from "./spawn.js";
import {appIconPng} from "./icon.js";
import {sendPeer} from "./peer.js";
import {readUsage} from "./usage.js";
import PAGE from "./page.html" with {type: "text"};

export const PORT = 7681;
const TICK = 1500;
const KEEPALIVE = 15000;     // an SSE comment this often, so no proxy calls it idle

// kitty's font, which a phone does not have. OFL, so it can be served; on a box without it
// the page falls back to the phone's own monospace.
const FONT = `${HOME}/Library/Fonts/Inconsolata[wdth,wght].ttf`;

const MANIFEST = JSON.stringify({name: "ccx", short_name: "ccx", start_url: "./",
  scope: "./", display: "standalone", background_color: "#0e0b12", theme_color: "#181020",
  icons: [192, 512].map((n) => ({src: `icon-${n}.png`, sizes: `${n}x${n}`,
    type: "image/png", purpose: "any maskable"}))});

// drawn once, on first ask: the 512 is ~100ms of supersampling
const ICONS = new Map();
const iconOf = (px) => ICONS.get(px) ?? ICONS.set(px, appIconPng(px)).get(px);

const HOSTNAME = Deno.hostname().split(".")[0];

const tilde = (p) => p && p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;

// tmux order: session, window, pane, numerically, since tmux gives them as strings. Nothing
// moves on the phone when a state changes; instances outside tmux go last.
export function tmuxOrder(instances) {
  const num = (s) => s === "" ? Infinity : Number(s);
  return [...instances].sort((a, b) =>
    (a.session ? 0 : 1) - (b.session ? 0 : 1) || byCodePoint(a.session, b.session) ||
    num(a.window) - num(b.window) || num(a.paneIndex) - num(b.paneIndex) || a.pid - b.pid);
}

export function rowOf(i) {
  return {pid: i.pid, name: i.name, path: tilde(i.path), cwd: i.cwd, state: i.state,
    asking: i.asking, waitsOn: i.waitsOn, summary: i.summary, since: i.since,
    hasPane: Boolean(i.pane), pane: i.pane, session: i.session, window: i.window,
    paneIndex: i.paneIndex, tab: i.tab, sessionId: i.sessionId, sock: i.sock, ...i.peer};
}

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
  return {response: new Response(body, {headers: SSE_HEADERS}), send, close};
}

// Who may connect, by address: this machine, or the tailnet (100.64.0.0/10 and
// fd7a:115c:a1e0::/48). `ccx host` listens on every interface, so this is the boundary
export function tailnetOrLocal(addr) {
  const a = addr.toLowerCase().replace(/^::ffff:/, "");
  if (a === "::1" || a.startsWith("127.")) return true;
  if (a.startsWith("fd7a:115c:a1e0:")) return true;
  const m = a.match(/^100\.(\d+)\./);
  return Boolean(m && Number(m[1]) >= 64 && Number(m[1]) < 128);
}

// The Host a request may name: an address, or this machine's own name, bare or as a
// tailnet name. A page that rebinds a name of its own onto one of our addresses arrives
// with that name, and that is what this refuses
export function ownHost(host, port, self = HOSTNAME) {
  const m = host.toLowerCase().match(/^(\[[0-9a-f:.]+\]|[^:]+):(\d+)$/);
  if (!m || Number(m[2]) !== port) return false;
  const name = m[1];
  if (name === "localhost" || name === self || name.startsWith("[")) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return true;
  return name.startsWith(`${self}.`) && name.endsWith(".ts.net");
}

export class Server {
  constructor(source, port = PORT, relay = null) {
    this.source = source;                 // () => {instances, net}
    this.port = port;
    this.relay = relay;                   // a Relay, under `ccx host`
    this.lists = new Set();               // api/events clients
    this.sessions = new Set();            // api/s/<pid>/events clients
    this.lastList = "";
    this.timer = 0;
  }

  find(pid) {
    return this.source().instances.find((i) => i.pid === pid);
  }

  listBody() {
    const {instances, net} = this.source();
    return {rows: tmuxOrder(instances).map(rowOf), offline: net?.offline ? net.label : "",
      host: HOSTNAME};
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((e) => console.error(e)), TICK);
  }

  stop() {
    clearInterval(this.timer);
    for (const c of [...this.lists, ...this.sessions]) c.close();
  }

  async tick() {
    if (this.lists.size) {
      const body = this.listBody(), text = JSON.stringify(body);
      if (text !== this.lastList) {
        this.lastList = text;
        for (const c of this.lists) c.send("list", body);
      }
    }
    // one capture per pane per tick, however many clients watch it
    const screens = new Map();
    for (const c of this.sessions) {
      const inst = this.find(c.pid);
      if (!inst) {
        c.send("gone", {pid: c.pid});
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
      c.send("state", rowOf(inst));
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
    const dialog = inst.state === "wait" ? parseDialog(text) : null;
    const d = JSON.stringify(dialog);
    if (d !== c.dialog) {
      c.dialog = d;
      c.send("dialog", dialog);
    }
  }

  listEvents() {
    const c = stream(() => this.lists.delete(c));
    this.lists.add(c);
    c.send("list", this.listBody());
    return c.response;
  }

  // `from` is the byte offset the page already has, from api/s/<pid>/log or Last-Event-ID
  // on a reconnect. Without one the stream starts with the tail, as a reset.
  sessionEvents(pid, from) {
    const c = stream(() => this.sessions.delete(c));
    Object.assign(c, {pid, end: from, path: undefined, row: "", screen: null, dialog: ""});
    this.sessions.add(c);
    const inst = this.find(pid);
    if (inst) this.follow(c, inst, null).catch((e) => console.error(e));
    return c.response;
  }

  async handle(req, info = null) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const get = req.method === "GET", post = req.method === "POST";
    if (info && !tailnetOrLocal(info.remoteAddr.hostname)) return json({error: "not tailnet"}, 403);
    if (!ownHost(req.headers.get("host") ?? "", this.port)) return json({error: "bad host"}, 403);
    // the home-screen shortcut opens the page as a cross-site navigation, which reads nothing
    const open = get && path === "/" && req.headers.get("sec-fetch-mode") === "navigate";
    if (!open && req.headers.get("sec-fetch-site") === "cross-site") {
      return json({error: "cross-site"}, 403);
    }
    if (post && !(req.headers.get("content-type") ?? "").startsWith("application/json")) {
      return json({error: "a POST is application/json"}, 415);
    }
    if (get && path === "/") {
      return new Response(PAGE, {headers: {"content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache"}});
    }
    if (get && path === "/manifest.json") {
      return new Response(MANIFEST, {headers: {"content-type": "application/manifest+json"}});
    }
    const icon = get && path.match(/^\/icon-(192|512)\.png$/);
    if (icon) {
      return new Response(await iconOf(Number(icon[1])), {headers: {"content-type": "image/png",
        "cache-control": "max-age=604800"}});
    }
    if (get && path === "/inconsolata.ttf") {
      try {
        return new Response(await Deno.readFile(FONT), {headers: {"content-type": "font/ttf",
          "cache-control": "max-age=604800"}});
      } catch {
        return json({error: "no font here"}, 404);
      }
    }
    if (get && path === "/api/list") return json(this.listBody());
    if (get && path === "/api/events") return this.listEvents();
    if (get && path === "/api/usage") return json({usage: readUsage()});
    if (post && path === "/api/relay") {
      if (!this.relay) return json({error: "no relay here; it runs under ccx host"}, 409);
      return answer(await this.relay.deliver(await req.json().catch(() => ({}))));
    }
    if (get && path === "/api/dirs") return json(dirsUnder(url.searchParams.get("prefix") ?? ""));
    if (post && path === "/api/spawn") {
      const body = await req.json().catch(() => ({}));
      const r = await spawn({dir: String(body.dir ?? ""), after: String(body.after ?? ""),
        mkdir: body.mkdir === true, name: String(body.name ?? "")});
      return r.error ? json(r, r.pane ? 502 : 409) : json(r);
    }
    const m = path.match(/^\/api\/s\/(\d+)\/(log|events|type|pick|esc|screen|send)$/);
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
    if (get && verb === "events") {
      const id = req.headers.get("last-event-id") ?? url.searchParams.get("from");
      return this.sessionEvents(pid, id === null || id === "" ? null : Number(id));
    }
    if (get && verb === "screen") {
      if (!inst.pane) return json({error: `pid ${pid} is not inside tmux`}, 409);
      const text = await screen(inst.pane);
      return text === null ? json({error: "tmux: capture failed"}, 502)
        : json({text, dialog: inst.state === "wait" ? parseDialog(text) : null});
    }
    if (!post) return json({error: "not found"}, 404);
    const body = await req.json().catch(() => ({}));
    if (verb === "send") {
      if (typeof body.text !== "string" || !body.text.trim()) return json({error: "no text"}, 400);
      return answer(await sendPeer(inst, body.text));
    }
    if (verb === "type") {
      if (typeof body.text !== "string" || !body.text.trim()) return json({error: "no text"}, 400);
      return answer(await typeInto(inst, body.text));
    }
    if (verb === "pick") {
      if (!Array.isArray(body.labels)) return json({error: "no labels"}, 400);
      return answer(await pick(inst, Number(body.i), body.labels));
    }
    if (verb === "esc") return answer(await sendKeys(inst, ["Escape"]));
    return json({error: "not found"}, 404);
  }
}

// Start serving. {server, stop} or {error}: a port already taken is reported, not thrown,
// so the systray carries on without it.
export function runServer({source, port = PORT, hostname = "127.0.0.1", relay = null}) {
  const s = new Server(source, port, relay);
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
