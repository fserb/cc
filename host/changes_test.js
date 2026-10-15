// `deno test -A --ext js changes_test.js`. The change words, the context marks, the replay
// after an id, and api/changes as a client sees it.

import { Changes, whatOf } from "./changes.js";
import { Server } from "./server.js";
import { HOME } from "./sh.js";

function eq(got, want, what) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`${what}: got ${g}, want ${w}`);
}

Deno.test("whatOf: one word per clock event", () => {
  const w = (from, to, asking = "") => whatOf({ from, to, asking });
  eq([
    w("", "wait"),
    w("", "busy"),
    w("busy", "wait"),
    w("hold", "wait"),
    w("wait", "wait", "Bash"),
    w("busy", "wait", "Bash"),
    w("wait", "busy"),
    w("busy", "hold"),
    w("wait", "free"),
    w("busy", "gone"),
    w("wait", "gone"),
    w("hold", "gone"),
  ], [
    "new",
    "new",
    "done",
    "wait",
    "asking",
    "asking",
    "busy",
    "hold",
    "free",
    "crashed",
    "gone",
    "gone",
  ], "words");
});

const clock = () => {
  let t = 1_000_000;
  return () => t;
};

Deno.test("Changes: events and context marks, with goal and tagged pid", () => {
  const c = new Changes("nadya", clock());
  const i = {
    pid: 7,
    name: "a",
    cwd: `${HOME}/x`,
    path: `${HOME}/x`,
    state: "busy",
    context: 150_000,
    goal: "g",
    summary: "s",
    asking: "",
    waitsOn: "",
  };
  c.update([], [i]);
  eq(c.buf.length, 0, "the first call only takes the marks");
  c.update([{
    pid: 7,
    name: "a",
    cwd: `${HOME}/x`,
    from: "busy",
    to: "wait",
    asking: "",
  }], [{ ...i, state: "wait", context: 210_000 }]);
  eq(
    c.buf.map((e) => [e.pid, e.what, e.dir, e.goal, e.over ?? 0]),
    [["nadya.7", "done", "nadya:~/x", "g", 0], [
      "nadya.7",
      "context",
      "nadya:~/x",
      "g",
      200_000,
    ]],
    "done, then the 200k mark",
  );
  c.update([], [{ ...i, context: 250_000 }]);
  eq(c.buf.length, 2, "no new mark");
  c.update([], [{ ...i, context: 10_000 }]);
  c.update([], [{ ...i, context: 120_000 }]);
  eq(c.buf.at(-1).over, 100_000, "after a drop the next crossing counts");
  eq(
    c.buf.map((e) => e.id),
    [1_000_001, 1_000_002, 1_000_003],
    "ids go up within one ms",
  );
});

Deno.test("Changes.after: replay, and lost before a start or the buffer", () => {
  const c = new Changes("nadya", clock(), 3);
  const start = c.start;
  for (let n = 0; n < 2; n++) c.push({ host: "nadya", what: "busy" });
  c.remote({ id: 5, host: "marx", what: "wait" });
  eq(
    c.after(start, false),
    { lost: [], items: c.buf.slice(0, 2) },
    "this host's only",
  );
  eq(c.after(start, true).items.length, 3, "all of them");
  eq(
    c.after(start - 1, true, ["nadya", "marx"]).lost,
    ["nadya", "marx"],
    "before the start",
  );
  c.push({ host: "nadya", what: "free" });
  eq(c.after(start, false).lost, ["nadya"], "the first one was trimmed");
  eq(
    c.after(start + 1, false),
    { lost: [], items: [c.buf[0], c.buf.at(-1)] },
    "just past the trimmed one",
  );
});

// the frames of an SSE response until `n` have come, as [event, data]
async function read(res, n) {
  const out = [],
    reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  while (out.length < n) {
    buf += (await reader.read()).value;
    let cut;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const f = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      out.push([
        f.match(/^event: (.*)$/m)[1],
        JSON.parse(f.match(/^data: (.*)$/m)[1]),
      ]);
    }
  }
  await reader.cancel();
  return out;
}

Deno.test("Server: api/changes replays after Last-Event-ID, then streams", async () => {
  const s = new Server(() => ({ instances: [], net: {} }));
  s.self = "nadya";
  s.hosts = ["nadya", "marx"];
  const c = new Changes("nadya", clock());
  s.useChanges(c);
  const call = (path, h = {}) =>
    s.handle(
      new Request(`http://x${path}`, {
        headers: { host: "127.0.0.1:7681", ...h },
      }),
    );
  const a = c.push({ host: "nadya", what: "busy" });
  c.remote({ host: "marx", what: "crashed" });
  const local = await read(
    await call("/api/changes", { "last-event-id": String(c.start) }),
    2,
  );
  eq(local.map(([e, d]) => [e, d.what ?? d.host]), [["change", "busy"], [
    "ready",
    "nadya",
  ]], "this host's");
  const res = await call(`/api/changes?all=1&since=${a.id}`);
  c.push({ host: "nadya", what: "free" });
  const all = await read(res, 3);
  eq(all.map(([e, d]) => [e, d.what ?? d.host]), [["change", "crashed"], [
    "ready",
    "nadya",
  ], ["change", "free"]], "every host, then live");
  const old = await read(await call("/api/changes?all=1&since=1"), 4);
  eq(old.slice(0, 2), [["lost", { host: "nadya", since: 1 }], ["lost", {
    host: "marx",
    since: 1,
  }]], "from before the start");
  s.stop();
});
