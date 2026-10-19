// remote.js against a fake host: CCX_HOSTS is read at import, so it is set first
const ac = new AbortController();
let up = false;
const srv = Deno.serve({port: 0, signal: ac.signal, onListen() {}}, (req) => {
  if (!up) return new Response("no", {status: 503});
  if (new URL(req.url).pathname === "/api/events") {
    return new Response(new ReadableStream({start(c) {
      c.enqueue(new TextEncoder().encode(`event: list\ndata: {"rows":[]}\n\n`));
    }}), {headers: {"content-type": "text/event-stream"}});
  }
  return Response.json({ok: 1});
});
Deno.env.set("CCX_HOSTS", `me,fake=localhost:${srv.addr.port}`);
Deno.env.set("CCX_SELF", "me");
const remote = await import("./remote.js");
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

Deno.test("remote: a host whose list stream is down answers at once, then again once it is back", async () => {
  const stop = remote.follow("fake", () => {}, 50);
  await wait(100);
  const t = Date.now(), [body, err] = await remote.call("fake", "/api/x");
  if (body || !err.startsWith("fake: down") || Date.now() - t > 20) throw new Error(`not skipped: ${err}`);
  up = true;
  await wait(200);
  const [again] = await remote.call("fake", "/api/x");
  if (again?.ok !== 1) throw new Error("not asked once back");
  stop();
  ac.abort();
  await srv.finished;
});
