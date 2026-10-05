// `deno test -A --ext js server_test.js`. The server against a fixed list of instances and
// no tmux: the routing, the pid check, the ordering and the list stream. The actions that
// do reach tmux were run by hand against a scratch session (see server.md).

import {dirsUnder, runServer, Server, tmuxOrder} from "./server.js";
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
  eq((await post(s, "/api/s/7/esc")).status, 404, "esc on one");
  eq((await call(s, "/api/nope")).status, 404, "an unknown route");
});

Deno.test("Server: an instance outside tmux is read-only", async () => {
  const s = server([inst(6, "", "", "")]);
  const r = await post(s, "/api/s/6/type", '{"text":"hi"}');
  eq([r.status, (await r.json()).error], [409, "pid 6 is not inside tmux; nothing to type into"],
    "type");
  eq((await post(s, "/api/s/6/esc")).status, 409, "esc");
  eq((await post(s, "/api/s/6/type")).status, 400, "no text");
  eq(await (await call(s, "/api/s/6/log")).json(), {events: [], start: 0, end: 0},
    "no sessionId, no history");
});

Deno.test("Server: a foreign Host, a cross-site request and a form POST are refused", async () => {
  const s = server([inst(5, "kitty-1", "1", "0")]);
  const status = async (path, init) => (await s.handle(new Request(`http://x${path}`, init))).status;
  eq(await status("/api/list", {headers: {host: "evil.example:7681"}}), 403, "rebound name");
  eq(await status("/api/list", {}), 403, "no Host at all");
  eq(await status("/api/list", {headers: {host: "localhost:7681"}}), 200, "localhost");
  eq(await status("/api/s/5/esc", {method: "POST", body: "{}", headers: {...HOST,
    "content-type": "application/json", "sec-fetch-site": "cross-site"}}), 403, "cross-site");
  const xs = {...HOST, "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate"};
  eq(await status("/", {headers: xs}), 200, "the home-screen shortcut opening the page");
  eq(await status("/api/list", {headers: xs}), 403, "a cross-site navigation to the API");
  eq(await status("/", {headers: {...HOST, "sec-fetch-site": "cross-site"}}), 403,
    "a cross-site fetch of the page");
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
