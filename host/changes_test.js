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

Deno.test("Changes: gone keeps the name, dir, goal of a session whose record went first", () => {
  const c = new Changes("nadya", clock());
  const i = {pid: 9, name: "t", cwd: `${HOME}/t`, path: `${HOME}/t`, sessionId: "s1", summary: "x",
    goal: "g", context: 5, state: "wait"};
  c.update([], [i]);
  c.update([], [{pid: 9, name: "", cwd: "", path: "", sessionId: "", summary: "", goal: "", context: 0,
    state: "wait"}]);
  c.update([{pid: 9, name: "", cwd: "", sessionId: "", from: "busy", to: "gone"}], []);
  const e = c.buf.at(-1);
  eq([e.what, e.name, e.dir, e.sessionId, e.summary, e.goal, e.context],
    ["crashed", "t", "nadya:~/t", "s1", "x", "g", 5], "the last known");
  eq(c.known.size, 0, "forgotten once gone");
});

Deno.test("readTitle: a turn that ended on a question, not one with a tool after it", async () => {
  const {readTitle} = await import("./claudes.js");
  const say = (content) => JSON.stringify({type: "assistant", message: {content, usage: {input_tokens: 1}}});
  const log = (...lines) => {
    const p = Deno.makeTempFileSync();
    Deno.writeTextFileSync(p, lines.join("\n") + "\n");
    return readTitle(p, Deno.statSync(p).size).question;
  };
  eq(log(say([{type: "text", text: "Done.\n\nWant me to **commit it?**"}])), "Want me to **commit it?**", "text");
  eq(log(say([{type: "thinking", thinking: "Delete them too?"}])), "Delete them too?", "a thinking reply");
  eq(log(say([{type: "text", text: "Is it?"}]), say([{type: "tool_use", name: "Bash"}])), "", "a tool after it");
  eq(log(say([{type: "text", text: "Why? Because.\nDone."}])), "", "a statement");
});

Deno.test("StateClock: a closing session keeps its state, and a question is a change", async () => {
  const {StateClock} = await import("./claudes.js");
  const c = new StateClock("nadya"), got = [];
  c.on((evs) => got.push(...evs.map((e) => [e.from, e.to, whatOf(e)])));
  c.update([{pid: 1, name: "a", state: "busy", peer: {status: "busy"}}]);
  c.update([{pid: 1, name: "a", state: "wait", question: "Go?", peer: {status: "idle"}}]);
  c.update([{pid: 1, name: "", state: "wait", peer: null}]);
  c.update([]);
  eq(got, [["", "busy", "new"], ["busy", "wait", "asking"], ["wait", "gone", "gone"]], "no wait before gone");
});
