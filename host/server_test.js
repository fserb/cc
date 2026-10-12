// `deno test -A --ext js server_test.js`. The server against a fixed list of instances and
// no tmux: the routing, the pid check, the ordering and the list stream. The actions that
// do reach tmux were run by hand against a scratch session (see server.md).

import {clientAddr, dirsUnder, ownHost, ROW, rowOf, runServer, Server, tagRow,
  tailnetOrLocal, tmuxOrder} from "./server.js";
import {Instance} from "./claudes.js";
import {HOME} from "./sh.js";

function eq(got, want, what) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`${what}: got ${g}, want ${w}`);
}

const inst = (pid, session, window, paneIndex, extra = {}) =>
  new Instance({pid, session, window, paneIndex, pane: session ? `%${pid}` : "",
    state: "wait", path: `${HOME}/p${pid}`, ...extra});

Deno.test("tmuxOrder: session, then window and pane as numbers, no pane last", () => {
  const rows = [inst(1, "", "", ""), inst(2, "kitty-9", "10", "0"), inst(3, "kitty-9", "2", "1"),
    inst(4, "kitty-9", "2", "0"), inst(5, "kitty-10", "0", "0")];
  eq(tmuxOrder(rows).map((i) => i.pid), [5, 4, 3, 2, 1], "order");
});

Deno.test("dirsUnder: the subdirectories that start with the last part", () => {
  const dir = Deno.makeTempDirSync();
  for (const d of ["alpha", "alps", "beta", ".hidden"]) Deno.mkdirSync(`${dir}/${d}`);
  Deno.writeTextFileSync(`${dir}/alfile`, "");
  Deno.symlinkSync(`${dir}/beta`, `${dir}/alink`);
  eq(dirsUnder(`${dir}/al`), {dirs: [`${dir}/alink`, `${dir}/alpha`, `${dir}/alps`],
    exists: false}, "a prefix: dirs and a symlink to one, not the file");
  eq(dirsUnder(`${dir}/`).dirs.length, 4, "a trailing slash lists the directory");
  eq(dirsUnder(`${dir}/.`).dirs, [`${dir}/.hidden`], "hidden only when asked for");
  eq(dirsUnder(`${dir}/alpha`).exists, true, "an exact match exists");
  eq(dirsUnder(`${dir}/nope/x`), {dirs: [], exists: false}, "nothing under a missing dir");
});

const server = (instances) => new Server(() => ({instances, net: {offline: false}}));
const HOST = {host: "127.0.0.1:7681"};
const JSON_POST = {method: "POST", headers: {...HOST, "content-type": "application/json"}};
const call = (s, path, init = {}) =>
  s.handle(new Request(`http://x${path}`, {headers: HOST, ...init}));
const post = (s, path, body = "{}") => call(s, path, {...JSON_POST, body});

Deno.test("Server: the list, and a pid not in the poll is 404 before any action", async () => {
  const s = server([inst(5, "kitty-1", "1", "0"), inst(6, "", "", "")]);
  const list = await (await call(s, "/api/list")).json();
  eq(list.rows.map((r) => [r.pid, r.hasPane, r.path]), [[5, true, "~/p5"], [6, false, "~/p6"]],
    "rows, tmux first, path in ~ form");
  eq((await call(s, "/api/s/7/log")).status, 404, "log on an unknown pid");
  eq((await post(s, "/api/s/7/type", '{"text":"rm -rf"}')).status, 404, "type on one");
  eq((await post(s, "/api/s/7/now")).status, 404, "now on one");
  eq((await call(s, "/api/nope")).status, 404, "an unknown route");
  eq((await call(s, "/")).status, 404, "no page at /");
});

Deno.test("Server: an instance outside tmux is read-only", async () => {
  const s = server([inst(6, "", "", "")]);
  const r = await post(s, "/api/s/6/type", '{"text":"hi"}');
  eq([r.status, (await r.json()).error], [409, "pid 6 is not inside tmux; nothing to type into"],
    "type");
  eq((await post(s, "/api/s/6/now")).status, 409, "now");
  eq((await post(s, "/api/s/6/unqueue")).status, 409, "unqueue");
  eq((await post(s, "/api/s/6/unqueue", '{"text":"hi"}')).status, 409, "unqueue one");
  eq((await post(s, "/api/s/6/unqueue", '{"text":7}')).status, 400, "unqueue a non-string");
  eq((await post(s, "/api/s/6/type")).status, 400, "no text");
  const img = (t, d) => JSON.stringify({text: "", images: [{type: t, data: d}]});
  eq((await post(s, "/api/s/6/type", img("image/svg+xml", "AAAA"))).status, 400, "not a raster image");
  eq((await post(s, "/api/s/6/type", img("image/png", "**"))).status, 400, "not base64");
  eq(await (await call(s, "/api/s/6/log")).json(), {events: [], start: 0, end: 0},
    "no sessionId, no history");
});

Deno.test("Server: a foreign Host, a cross-site request and a form POST are refused", async () => {
  const s = server([inst(5, "kitty-1", "1", "0")]);
  const status = async (path, init) => (await s.handle(new Request(`http://x${path}`, init))).status;
  eq(await status("/api/list", {headers: {host: "evil.example:7681"}}), 403, "rebound name");
  eq(await status("/api/list", {}), 403, "no Host at all");
  eq(await status("/api/list", {headers: {host: "localhost:7681"}}), 200, "localhost");
  eq(await status("/api/s/5/now", {method: "POST", body: "{}", headers: {...HOST,
    "content-type": "application/json", "sec-fetch-site": "cross-site"}}), 403, "cross-site");
  const xs = {...HOST, "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate"};
  eq(await status("/api/list", {headers: xs}), 403, "a cross-site navigation to the API");
  eq(await status("/api/s/5/type", {method: "POST", body: '{"text":"x"}',
    headers: {...HOST, "content-type": "text/plain"}}), 415, "a POST that needs no preflight");
});

Deno.test("runServer: the list stream, and a taken port is an error, not a throw", async () => {
  const source = () => ({instances: [inst(5, "kitty-1", "1", "0")], net: null});
  const a = runServer({source, port: 7699});
  eq(a.error, undefined, "started");
  const b = runServer({source, port: 7699});
  eq(b.error?.includes("7699"), true, `second bind: ${b.error}`);
  const r = await fetch("http://127.0.0.1:7699/api/events");
  const reader = r.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  eq(first.startsWith("event: list\ndata: "), true, "the list, at once");
  eq(JSON.parse(first.split("data: ")[1]).rows[0].pid, 5, "with the rows");
  await reader.cancel();
  await a.stop();
});

// a Server as host `a` of a, b, c, with b reached at `bBase`
function hosts(instances, bBase = "http://127.0.0.1:1") {
  const s = server(instances);
  Object.assign(s, {self: "a", hosts: ["a", "b", "c"], base: (h) => h === "b" ? bBase : "http://127.0.0.1:1"});
  return s;
}

// The first SSE frame of a response as [event, data]
async function firstFrame(r) {
  const reader = r.body.getReader();
  let text = "";
  while (!text.includes("\n\n")) text += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  const frame = text.slice(0, text.indexOf("\n\n"));
  return [frame.match(/^event: (.*)$/m)[1], JSON.parse(frame.match(/^data: (.*)$/m)[1])];
}

Deno.test("Server: all=1 merges every host's rows, tagged, with up and down", async () => {
  const s = hosts([inst(5, "kitty-1", "1", "0")]);
  const plain = await (await call(s, "/api/list")).json();
  eq([plain.rows[0].pid, plain.up], [5, undefined], "without all=1, this host as before");
  s.peer("b", {rows: [{pid: 7, pane: "%3", session: "kitty-2", path: "~/x"}], offline: "offline",
    host: "b"});
  s.peer("c", null, "connection refused");
  const all = await (await call(s, "/api/list?all=1")).json();
  eq(all.rows.map((r) => [r.pid, r.pane, r.session, r.path]),
    [["a.5", "a/%5", "a:kitty-1", "a:~/p5"], ["b.7", "b/%3", "b:kitty-2", "b:~/x"]], "rows");
  eq([all.up, all.down, all.host, all.offline], [["a", "b"], [["c", "connection refused"]],
    "a · b (c down)", "offline"], "up, down, host, offline");
  s.peers.delete("c");
  eq((await (await call(s, "/api/list?all=1")).json()).down, [["c", "no list yet"]],
    "a host not heard from yet");
  eq(tagRow("b", {pid: 1, pane: "", session: "", path: "~"}),
    {pid: "b.1", pane: "", session: "", path: "b:~"}, "no pane, no session");
  const [event, body] = await firstFrame(await call(s, "/api/events?all=1"));
  eq([event, body.rows.length, body.up], ["list", 2, ["a", "b"]], "the merged stream");
  s.stop();
});

Deno.test("Server: api/s/<host>.<pid> is local for this host, proxied for another", async () => {
  const b = runServer({source: () => ({instances: [inst(7, "", "", "")], net: null}), port: 7698});
  const s = hosts([inst(5, "", "", "")], "http://127.0.0.1:7698");
  eq(await (await call(s, "/api/s/a.5/log")).json(), {events: [], start: 0, end: 0}, "local");
  eq((await call(s, "/api/s/a.7/log")).status, 404, "local, not in the poll");
  eq(await (await call(s, "/api/s/b.7/log")).json(), {events: [], start: 0, end: 0}, "proxied");
  const r = await post(s, "/api/s/b.7/type", '{"text":"hi"}');
  eq([r.status, (await r.json()).error], [409, "pid 7 is not inside tmux; nothing to type into"],
    "a proxied POST keeps body and status");
  eq((await call(s, "/api/s/b.5/log")).status, 404, "the other host's 404");
  eq((await call(s, "/api/s/zz.5/log")).status, 404, "an unknown host");
  eq((await call(s, "/api/s/c.5/log")).status, 502, "a host that is down");
  eq(await firstFrame(await call(s, "/api/s/a.5/events")), ["state",
    tagRow("a", JSON.parse(JSON.stringify(s.listBody().rows[0])))], "local stream, rows tagged");
  const [event, row] = await firstFrame(await call(s, "/api/s/b.7/events"));
  eq([event, row.pid, row.path], ["state", "b.7", "b:~/p7"], "proxied stream, rows tagged");
  eq((await firstFrame(await call(s, "/api/s/5/events")))[1].pid, 5, "a bare pid, untagged");
  s.stop();
  await b.stop();
});

Deno.test("Server: dirs and spawn route by their host: prefix", async () => {
  const s = hosts([]);
  eq(s.split("b/%3", "/"), ["b", "%3"], "a pane on b");
  eq(s.split("a:~/x", ":"), ["a", "~/x"], "a dir here");
  eq(s.split("~/x:y", ":"), [null, "~/x:y"], "no host");
  const dir = Deno.makeTempDirSync();
  Deno.mkdirSync(`${dir}/one`);
  eq(await (await call(s, `/api/dirs?prefix=a:${dir}/o`)).json(),
    {dirs: [`a:${dir}/one`], exists: false}, "this host's, tagged");
  eq(await (await call(s, `/api/dirs?prefix=${dir}/o`)).json(),
    {dirs: [`${dir}/one`], exists: false}, "a bare prefix, as before");
  eq((await (await call(s, `/api/dirs?prefix=${dir}/o&all=1`)).json()).dirs, [`a:${dir}/one`],
    "all=1: every host, the down ones empty");
  const r = await post(s, "/api/spawn", '{"dir":"c:~/x"}');
  eq([r.status, (await r.json()).error.startsWith("c: ")], [502, true], "spawn on a down host");
});

Deno.test("access: X-Forwarded-For from loopback, a tailnet name with no port", async () => {
  eq(clientAddr("127.0.0.1", "100.101.1.2"), "100.101.1.2", "caddy's client");
  eq(clientAddr("100.64.0.9", "8.8.8.8"), "100.64.0.9", "only from loopback");
  eq(clientAddr("::1", "1.1.1.1, 100.64.0.1"), "100.64.0.1", "the last entry");
  eq(clientAddr("127.0.0.1", null), "127.0.0.1", "no header");
  eq(tailnetOrLocal(clientAddr("127.0.0.1", "8.8.8.8")), false, "outside, through caddy");
  eq(ownHost("nadya.giraffe-yo.ts.net", 7681, "nadya"), true, "tailnet name, no port");
  eq(ownHost("nadya.giraffe-yo.ts.net:7681", 7681, "nadya"), true, "tailnet name, our port");
  eq(ownHost("nadya.giraffe-yo.ts.net:8080", 7681, "nadya"), false, "another port");
  eq(ownHost("evil.example", 7681, "nadya"), false, "another name, no port");
  eq(ownHost("127.0.0.1", 7681, "nadya"), false, "an address, no port");
  const s = server([]);
  const via = (xff) => s.handle(new Request("http://x/api/list", {headers: {
    host: "127.0.0.1:7681", ...(xff ? {"x-forwarded-for": xff} : {})}}),
  {remoteAddr: {hostname: "127.0.0.1"}});
  eq((await via("100.100.1.1")).status, 200, "a tailnet client");
  eq((await via("203.0.113.5")).status, 403, "a client off the tailnet");
  eq((await via(null)).status, 200, "loopback itself");
});

Deno.test("cached: shares the call in flight, and the minute starts when it is ready", async () => {
  const s = server([]);
  let t = 0, runs = 0, done;
  const now = () => t;
  const slow = () => {
    runs++;
    return new Promise((ok) => done = ok);
  };
  const a = s.cached("k", slow, now), b = s.cached("k", slow, now);
  t = 100_000;                            // built for 100s
  done("x");
  eq([await a, await b, runs], ["x", "x", 1], "one call for both");
  t = 130_000;
  eq([await s.cached("k", slow, now), runs], ["x", 1], "30s after it was ready: cached");
  t = 161_000;
  const c = s.cached("k", slow, now);
  done("y");
  eq([await c, runs], ["y", 2], "61s after: built again");
  let fails = 0;
  await s.cached("e", () => (fails++, Promise.reject(new Error("no"))), now).catch(() => {});
  await s.cached("e", () => (fails++, Promise.resolve(1)), now);
  eq(fails, 2, "a failure is not cached");
});

Deno.test("Server: subs and unsub with a host go to that host's daemon", async () => {
  const {Subs} = await import("./subs.js");
  const source = () => ({instances: [inst(7, "", "", "")], net: null});
  const b = runServer({source, port: 7697, subs: new Subs("b", () => null)});
  const s = hosts([inst(5, "", "", "")], "http://127.0.0.1:7697");
  s.subs = new Subs("a", () => null);
  const who = {host: "a", pid: 5, name: "x"};
  const r = await post(s, "/api/subs", JSON.stringify({host: "b", pid: 7, who}));
  eq([r.status, (await r.json()).state], [200, "wait"], "registered on b");
  eq((await (await call(s, "/api/subs?host=b")).json()).subs.map((x) => x.target.pid), [7],
    "b's list");
  eq((await (await call(s, "/api/subs")).json()).subs, [], "this host's, without host");
  eq((await post(s, "/api/subs", JSON.stringify({host: "b", pid: 9, who}))).status, 404,
    "b's 404 for a pid it does not have");
  const id = (await (await call(s, "/api/subs?host=b")).json()).subs[0].id;
  eq((await post(s, "/api/unsub", JSON.stringify({host: "b", id}))).status, 200, "unsub on b");
  eq((await (await call(s, "/api/subs?host=b")).json()).subs, [], "gone from b");
  eq((await call(s, "/api/subs?host=c")).status, 502, "a host that is down");
  eq((await call(s, "/api/subs?host=zz")).status, 404, "an unknown host");
  eq((await (await call(s, "/api/list?all=1")).json()).hosts, ["a", "b", "c"], "hosts");
  eq((await (await call(s, "/api/list?all=1")).json()).self, "a", "self");
  s.stop();
  await b.stop();
});

Deno.test("Server: api/chat is what chat.js reads for a cwd, and its stream", async () => {
  const root = Deno.makeTempDirSync();
  Deno.mkdirSync(`${root}/projects/-tmp-demo`, {recursive: true});
  Deno.mkdirSync(`${root}/sessions`);
  const line = (at, id) => JSON.stringify({type: "assistant", timestamp: at, sessionId: "s1",
    message: {role: "assistant", content: [{type: "tool_use", id, name: "SendMessage",
      input: {to: "peer", summary: "s", message: `body ${id}`}}]}});
  const log = `${root}/projects/-tmp-demo/s1.jsonl`;
  Deno.writeTextFileSync(log, `${line("2026-10-12T10:00:00Z", "u1")}\n`);
  const s = server([]);
  s.chatRoot = root;
  const got = await (await call(s, "/api/chat?cwd=/tmp/demo")).json();
  eq([got.cwd, got.msgs.map((m) => [m.to, m.body])], ["/tmp/demo", [["peer", "body u1"]]],
    "one message");
  eq((await call(s, "/api/chat?cwd=demo")).status, 400, "a relative cwd");
  const r = await call(s, "/api/chat/events?cwd=/tmp/demo");
  const reader = r.body.getReader();
  let text = "";
  while (!text.includes("event: log")) text += new TextDecoder().decode((await reader.read()).value);
  Deno.writeTextFileSync(log, `${line("2026-10-12T10:01:00Z", "u2")}\n`, {append: true});
  while (!text.includes("event: msg")) text += new TextDecoder().decode((await reader.read()).value);
  eq(JSON.parse(text.split("event: msg\ndata: ")[1].split("\n")[0]).body, "body u2", "a new one");
  await reader.cancel();
  eq(s.chats.size, 0, "a closed stream stops its watch");
  s.stop();
});

Deno.test("rowOf: the named fields and no others, with or without a record", () => {
  const bare = Object.assign(new Instance(), {pid: 1, path: "/tmp", cwd: "/tmp"});
  const rec = Object.assign(new Instance(), {pid: 2, path: "/tmp", cwd: "/tmp",
    peer: {status: "shell", startedAt: 5, version: "2.1.296", peerFeatures: ["x"],
      statusUpdatedAt: 7, extra: "not passed on"}});
  eq(Object.keys(rowOf(bare)), ROW, "a row read off the pane");
  eq(Object.keys(rowOf(rec)), ROW, "a row with a record");
  const r = rowOf(rec);
  eq([r.status, r.startedAt, r.version, r.peerFeatures, r.statusUpdatedAt],
    ["shell", 5, "2.1.296", ["x"], 7], "the record's fields");
  eq([rowOf(bare).status, rowOf(bare).statusUpdatedAt], ["", 0], "empty without one");
});

Deno.test("Server: api/chat?all=1 merges every host's log of the same ~ path", async () => {
  const dir = (name) => {
    const root = Deno.makeTempDirSync();
    const proj = `${root}/projects/${`${HOME}/demo`.replace(/[^a-zA-Z0-9]/g, "-")}`;
    Deno.mkdirSync(proj, {recursive: true});
    Deno.mkdirSync(`${root}/sessions`);
    return [root, `${proj}/${name}.jsonl`];
  };
  const [rootA, logA] = dir("s1"), [rootB, logB] = dir("s2");
  const sent = (at) => JSON.stringify({type: "assistant", timestamp: at, sessionId: "s1",
    message: {role: "assistant", content: [{type: "tool_use", id: "u1", name: "SendMessage",
      input: {to: "b1", message: "hi"}}]}});
  const got = (at, id, body) => JSON.stringify({type: "user", timestamp: at, sessionId: "s2",
    origin: {kind: "peer", name: "a1", msg_id: id, body}});
  Deno.writeTextFileSync(logA, `${sent("2026-10-12T10:00:00Z")}\n`);
  Deno.writeTextFileSync(logB, `${got("2026-10-12T10:00:02Z", "", "hi")}\n`);
  const b = runServer({source: () => ({instances: [], net: null}), port: 7696});
  b.server.chatRoot = rootB;
  const s = hosts([], "http://127.0.0.1:7696");
  s.chatRoot = rootA;
  const r = await (await call(s, "/api/chat?all=1&cwd=~/demo")).json();
  eq(r.msgs.map((m) => [m.host, m.from, m.to, m.body]), [["a", "a1", "b1", "hi"]],
    "one row for the two copies, named as b recorded it");
  eq(r.down.map(([h]) => h), ["c"], "c is down");
  const ev = await call(s, "/api/chat/events?all=1&cwd=~/demo");
  const reader = ev.body.getReader();
  let text = "";
  while (!text.includes("event: log")) text += new TextDecoder().decode((await reader.read()).value);
  const now = new Date().toISOString();
  Deno.writeTextFileSync(logB, `${got(now, "m2", "back")}\n`, {append: true});
  while (!text.includes("event: msg")) text += new TextDecoder().decode((await reader.read()).value);
  const m = JSON.parse(text.split("event: msg\ndata: ")[1].split("\n")[0]);
  eq([m.host, m.body], ["b", "back"], "b's new one, by the poll");
  await reader.cancel();
  s.stop();
  await b.stop();
});
