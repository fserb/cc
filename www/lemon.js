// ccx for the phone, every host at once: a lemon app (boxer, `FROM boxer:lemon`) that
// serves the page from a `ccx host` daemon and merges the hosts' api behind it. It sees
// nothing local, being a container, so everything is an HTTP call to a daemon.
//
// - an instance is `<host>.<pid>` here, a pane `<host>/<pane>`, a session and a path
//   `<host>:...`, so the page needs no idea of hosts: `api/s/nadya.123/type` is nadya's
//   `api/s/123/type`, and a new claude goes where its `after` pane or its `nadya:` dir says
// - the daemons are reached by tailnet address, from boxer's /global/tailscale.json: a
//   container resolves no tailnet name. The daemon on this host sees the container's
//   docker bridge address, which `ccx host` accepts for that reason
// - the page's cross-site checks are the daemons', so the headers they read are passed on
// - box.idle off: the list stream is open whenever the page is, and the upstream streams
//   only while a page listens

import Lemon from "lemon";

const PORT = 7681;
const HOSTS = (Deno.env.get("CCX_HOSTS") ?? "marx,nadya").split(",").map((h) => h.trim());
const TABLE = "/global/tailscale.json";
const TIMEOUT = 4000;
const PASS = ["content-type", "sec-fetch-site", "sec-fetch-mode", "last-event-id"];

// host -> its tailnet v4 address, reread when boxer rewrites the table
let table = {mtime: -1, addr: new Map()};
function addrOf(host) {
  try {
    const mtime = Deno.statSync(TABLE).mtime?.getTime() ?? 0;
    if (mtime !== table.mtime) {
      const addr = new Map();
      for (const [ip, v] of Object.entries(JSON.parse(Deno.readTextFileSync(TABLE)))) {
        const name = v.node?.split(".")[0];
        if (name && ip.includes(".")) addr.set(name, ip);
      }
      table = {mtime, addr};
    }
  } catch {
    // no table: the name, which works outside a container
  }
  return table.addr.get(host) ?? host;
}

const upstream = (host, path) => `http://${addrOf(host)}:${PORT}${path}`;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {status,
    headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"}});
}

// The request as the daemon should get it: same method, body and checked headers
async function pass(req, host, path, signal = AbortSignal.timeout(TIMEOUT)) {
  const headers = new Headers();
  for (const h of PASS) if (req.headers.has(h)) headers.set(h, req.headers.get(h));
  const body = req.method === "POST" ? await req.text() : undefined;
  // HEAD as GET: the daemon serves its pages to GET only, and lemon drops the body
  const method = req.method === "HEAD" ? "GET" : req.method;
  return await fetch(upstream(host, path), {method, headers, body, signal});
}

const tagRow = (host, r) => ({...r, pid: `${host}.${r.pid}`,
  pane: r.pane ? `${host}/${r.pane}` : "", session: r.session ? `${host}:${r.session}` : "",
  path: `${host}:${r.path}`});

// `<host>:rest` with a known host, else [null, text]
function split(text, sep) {
  const at = text.indexOf(sep);
  const host = at > 0 ? text.slice(0, at) : "";
  return HOSTS.includes(host) ? [host, text.slice(at + 1)] : [null, text];
}

// the list: every host's rows, in HOSTS order, and which hosts did not answer
const lists = new Map();      // host -> {rows, offline} from its event stream
const failed = new Set();     // hosts whose stream or list call failed, until one answers
function merged() {
  const rows = [], up = [];
  let offline = "";
  for (const h of HOSTS) {
    const l = lists.get(h);
    if (!l) continue;
    up.push(h);
    rows.push(...l.rows.map((r) => tagRow(h, r)));
    offline ||= l.offline;
  }
  const down = HOSTS.filter((h) => failed.has(h));
  return {rows, offline, host: up.join(" · ") + (down.length ? ` (${down.join(", ")} down)` : "")};
}

// One SSE reader per host while any page listens; a dropped one retries every 5s
const clients = new Set();
const readers = new Map();    // host -> AbortController
function follow(host) {
  const ctl = new AbortController();
  readers.set(host, ctl);
  (async () => {
    while (!ctl.signal.aborted) {
      try {
        const r = await fetch(upstream(host, "/api/events"), {signal: ctl.signal});
        if (!r.ok) throw new Error(`${r.status}`);
        await frames(r.body, (event, data) => {
          if (event !== "list") return;
          lists.set(host, JSON.parse(data));
          failed.delete(host);
          broadcast();
        });
      } catch {
        // down or aborted
      }
      lists.delete(host);
      if (!ctl.signal.aborted) failed.add(host);
      broadcast();
      if (!ctl.signal.aborted) await new Promise((ok) => setTimeout(ok, 5000));
    }
  })();
}

let last = "";
function broadcast() {
  const text = JSON.stringify(merged());
  if (text === last) return;
  last = text;
  for (const c of clients) c.send("list", text);
}

// Every SSE frame of a body as onFrame(event, data, id)
async function frames(body, onFrame) {
  let buf = "";
  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    buf += chunk;
    let cut;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const field = (k) => frame.match(new RegExp(`^${k}: (.*)$`, "m"))?.[1];
      onFrame(field("event"), field("data"), field("id"));
    }
  }
}

const SSE_HEADERS = {"content-type": "text/event-stream", "cache-control": "no-store",
  "x-accel-buffering": "no"};

// An SSE response; send(event, data text, id) writes a frame, onClose runs once
function stream(onClose = () => {}) {
  const enc = new TextEncoder();
  let ctl, alive = true, timer = 0;
  const close = () => {
    if (!alive) return;
    alive = false;
    clearInterval(timer);
    onClose();
  };
  const write = (s) => {
    if (!alive) return;
    try {
      ctl.enqueue(enc.encode(s));
    } catch {
      close();
    }
  };
  const body = new ReadableStream({
    start(c) {
      ctl = c;
      timer = setInterval(() => write(": keepalive\n\n"), 15000);
    },
    cancel: close,
  });
  const send = (event, data, id = undefined) =>
    write(`${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${data}\n\n`);
  return {response: new Response(body, {headers: SSE_HEADERS}), send, close,
    end: () => {
      try {
        ctl.close();
      } catch {
        // closed
      }
      close();
    }};
}

function listEvents() {
  const c = stream(() => {
    clients.delete(c);
    if (clients.size) return;
    for (const ctl of readers.values()) ctl.abort();
    readers.clear();
    lists.clear();
    failed.clear();
    last = "";
  });
  clients.add(c);
  for (const h of HOSTS) if (!readers.has(h)) follow(h);
  c.send("list", JSON.stringify(merged()));
  return c.response;
}

// One session's stream from its host, with the rows in it tagged as the list's are
function sessionEvents(req, host, pid, query) {
  const ctl = new AbortController();
  const c = stream(() => ctl.abort());
  (async () => {
    try {
      const r = await pass(req, host, `/api/s/${pid}/events${query}`, ctl.signal);
      await frames(r.body, (event, data, id) => {
        if (event === "state") data = JSON.stringify(tagRow(host, JSON.parse(data)));
        if (event === "gone") data = JSON.stringify({pid: `${host}.${pid}`});
        c.send(event, data, id);
      });
    } catch {
      // the host went away or the page did
    }
    c.end();
  })();
  return c.response;
}

// GET api/dirs: prefix `host:path` asks that host; a bare prefix asks every host
async function dirs(req, prefix) {
  const [host, rest] = split(prefix, ":");
  const ask = host ? [host] : HOSTS;
  const all = await Promise.all(ask.map(async (h) => {
    try {
      const r = await pass(req, h, `/api/dirs?prefix=${encodeURIComponent(rest)}`);
      const body = await r.json();
      return {dirs: (body.dirs ?? []).map((d) => `${h}:${d}`), exists: Boolean(body.exists)};
    } catch {
      return {dirs: [], exists: false};
    }
  }));
  return json({dirs: all.flatMap((a) => a.dirs), exists: Boolean(host) && all[0].exists});
}

// POST api/spawn: the host its `after` pane is on, else its dir's, else the first
async function spawn(req) {
  let body;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return json({error: "bad json"}, 400);
  }
  let host = null;
  if (body.after) [host, body.after] = split(String(body.after), "/");
  const [dirHost, dir] = split(String(body.dir ?? ""), ":");
  host ??= dirHost ?? HOSTS[0];
  body.dir = dir;
  try {
    const r = await fetch(upstream(host, "/api/spawn"), {method: "POST",
      headers: {"content-type": "application/json",
        "sec-fetch-site": req.headers.get("sec-fetch-site") ?? "same-origin"},
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000)});
    const out = await r.json();
    if (out.pid) out.pid = `${host}.${out.pid}`;
    if (out.pane) out.pane = `${host}/${out.pane}`;
    return json(out, r.status);
  } catch (e) {
    return json({error: `${host}: ${e.message}`}, 502);
  }
}

// Anything else: the first host that answers, as it answered
async function first(req, path) {
  for (const h of HOSTS) {
    try {
      const r = await pass(req, h, path);
      return new Response(r.body, {status: r.status, headers: r.headers});
    } catch {
      // next host
    }
  }
  return json({error: `no host answered: ${HOSTS.join(", ")}`}, 502);
}

async function handle(req) {
  const url = new URL(req.url);
  const path = (req.subpath ?? url.pathname).replace(/\/+$/, "") || "/";
  if (path === "/api/list") return json(clients.size ? merged() : await fanList());
  if (path === "/api/events") return listEvents();
  if (path === "/api/dirs") return await dirs(req, url.searchParams.get("prefix") ?? "");
  if (path === "/api/spawn" && req.method === "POST") return await spawn(req);
  const m = path.match(/^\/api\/s\/([\w-]+)\.(\d+)\/(\w+)$/);
  if (m) {
    const [, host, pid, verb] = m;
    if (!HOSTS.includes(host)) return json({error: `no host ${host}`}, 404);
    if (verb === "events") return sessionEvents(req, host, pid, url.search);
    try {
      const r = await pass(req, host, `/api/s/${pid}/${verb}${url.search}`);
      return new Response(r.body, {status: r.status, headers: r.headers});
    } catch (e) {
      return json({error: `${host}: ${e.message}`}, 502);
    }
  }
  return await first(req, `${path}${url.search}`);
}

// api/list with no stream open: ask every host once
async function fanList() {
  await Promise.all(HOSTS.map(async (h) => {
    try {
      const r = await fetch(upstream(h, "/api/list"), {signal: AbortSignal.timeout(TIMEOUT)});
      if (!r.ok) throw new Error(`${r.status}`);
      lists.set(h, await r.json());
      failed.delete(h);
    } catch {
      failed.add(h);
    }
  }));
  const out = merged();
  if (!clients.size) {
    lists.clear();
    failed.clear();
  }
  return out;
}

// lemon maps a handler to its method by the function's own name
async function get(req) {
  return await handle(req);
}

async function post(req) {
  return await handle(req);
}

await Lemon(get, post);
