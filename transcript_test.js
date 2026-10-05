// `deno test -A --ext js transcript_test.js`. Fixture logs in a temp dir, never the live
// ones, which are written to while the suite runs.

import {CATCHUP, logPath, readFrom, readPage} from "./transcript.js";

function eq(got, want, what) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`${what}: got ${g}, want ${w}`);
}

const T = "2026-10-04T12:00:00.000Z";
const AT = Date.parse(T) / 1000;

function file(lines) {
  const path = Deno.makeTempFileSync({prefix: "ccx-transcript-", suffix: ".jsonl"});
  Deno.writeTextFileSync(path, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  return path;
}

const user = (content, extra = {}) =>
  ({type: "user", timestamp: T, message: {role: "user", content}, ...extra});
const assistant = (...content) =>
  ({type: "assistant", timestamp: T, message: {role: "assistant", content}});
const queued = (prompt, origin, mode = "prompt") =>
  ({type: "attachment", timestamp: T,
    attachment: {type: "queued_command", prompt, commandMode: mode, origin}});
const peerOrigin = (id, body) =>
  ({kind: "peer", from: "uds:/tmp/cc-socks/1.sock", msg_id: id, name: "ccx-1", body});

const shapes = (events) => events.map(({at, ...e}) => e);

Deno.test("readPage: each record shape becomes the event the page draws", () => {
  const path = file([
    user("hello", {origin: {kind: "human"}}),
    user("<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"),
    user("<command-name>/loop</command-name>\n<command-args>5m check</command-args>",
      {origin: {kind: "human"}}),
    user("<local-command-stdout>Session renamed to: x</local-command-stdout>"),
    user("<local-command-stdout>(no content)</local-command-stdout>"),
    {type: "system", subtype: "local_command", timestamp: T,
      content: "<local-command-stdout>cost: $1</local-command-stdout>"},
    assistant({type: "thinking", thinking: "hm"}, {type: "text", text: "on it"},
      {type: "tool_use", id: "t1", name: "Bash", input: {command: "ls\npwd", description: "d"}}),
    user([{type: "tool_result", tool_use_id: "t1", content: "a\nb"}]),
    user([{type: "tool_result", tool_use_id: "t2", is_error: true,
      content: [{type: "text", text: "no"}, {type: "image", source: {}}]}]),
    user([{type: "text", text: "[Request interrupted by user]"}]),
    user([{type: "text", text: "see"}, {type: "image", source: {}}], {origin: {kind: "human"}}),
    user("ctx", {isMeta: true}),
    user("<task-notification>x</task-notification>", {origin: {kind: "task-notification"}}),
    user("summary", {isCompactSummary: true}),
    user("sub", {isSidechain: true}),
    {type: "system", subtype: "compact_boundary", timestamp: T},
    {type: "system", subtype: "turn_duration", timestamp: T},
    {type: "ai-title", aiTitle: "t"},
    queued("typed mid-turn", {kind: "human"}),
    queued("<task-notification/>", {kind: "task-notification"}, "task-notification"),
    queued("<cross-session-message>hi</cross-session-message>", peerOrigin("m1", "hi")),
    user("<cross-session-message>hi</cross-session-message>",
      {isMeta: true, origin: peerOrigin("m1", "hi")}),
  ]);
  eq(shapes(readPage(path).events), [
    {type: "user", text: "hello", images: 0},
    {type: "command", text: "/clear"},
    {type: "command", text: "/loop 5m check"},
    {type: "output", text: "Session renamed to: x"},
    {type: "output", text: "cost: $1"},
    {type: "text", text: "on it"},
    {type: "tool", id: "t1", name: "Bash", arg: "ls",
      input: JSON.stringify({command: "ls\npwd", description: "d"}, null, 2)},
    {type: "result", id: "t1", error: false, text: "a\nb", images: 0},
    {type: "result", id: "t2", error: true, text: "no", images: 1},
    {type: "note", text: "[Request interrupted by user]"},
    {type: "user", text: "see", images: 1},
    {type: "note", text: "conversation compacted"},
    {type: "user", text: "typed mid-turn", images: 0},
    {type: "peer", id: "m1", from: "ccx-1", text: "hi"},
  ], "every shape, the peer message once");
  eq(readPage(path).events[0].at, AT, "timestamps are epoch seconds");
});

Deno.test("readPage: paging back gives every event once, in order", () => {
  const lines = [];
  for (let n = 0; n < 200; n++) lines.push(user(`prompt ${n} ${"x".repeat(n % 37)}`));
  const path = file(lines);
  const all = [];
  let p = readPage(path, null, 1000, 1), pages = 1;
  for (;;) {
    all.unshift(...p.events);
    if (p.start === 0) break;
    p = readPage(path, p.start, 1000, 1);
    pages++;
  }
  eq(all.map((e) => e.text), lines.map((l) => l.message.content), "nothing lost or repeated");
  eq(pages > 5, true, "it took several pages");
});

Deno.test("readPage: a line longer than the page still arrives whole", () => {
  const big = "y".repeat(5000);
  const path = file([user("first"), assistant({type: "text", text: big}), user("last")]);
  const tail = readPage(path, null, 100, 1);
  eq(tail.events.map((e) => e.text), ["last"], "the tail page");
  const back = readPage(path, tail.start, 100, 1);
  eq(back.events.map((e) => e.text.length), [5000], "the long line, widened to");
  eq(readPage(path, back.start, 100, 1).events.map((e) => e.text), ["first"], "and the top");
});

Deno.test("readPage: windows go on back until there are enough events, or the budget", () => {
  const path = file(Array.from({length: 30}, (_, n) => user(`p${n} ${"x".repeat(50)}`)));
  const p = readPage(path, null, 200, 10);
  eq([p.events.length >= 10, p.events.at(-1).text.startsWith("p29")], [true, true], "ten or so");
  eq(readPage(path, null, 200, 1000).start, 0, "all the way to the top when it wants more");
  eq(readPage(path, null, 200, 1000, 400).events.length < 30, true, "but not past the budget");
});

Deno.test("readPage: a page of nothing to draw goes on back", () => {
  const noise = Array.from({length: 50}, () => ({type: "attachment", timestamp: T,
    attachment: {type: "date", date: "x".repeat(40)}}));
  const path = file([user("under the noise"), ...noise]);
  const p = readPage(path, null, 200, 1);
  eq(p.events.map((e) => e.text), ["under the noise"], "found past the attachments");
  eq(p.start, 0, "and that was the top");
  eq(p.end, Deno.statSync(path).size, "end is still the end of the log");
});

Deno.test("readPage: the unfinished last line is left for readFrom", () => {
  const path = file([user("done")]);
  const whole = Deno.statSync(path).size;
  Deno.writeTextFileSync(path, '{"type":"user","mess', {append: true});
  const p = readPage(path);
  eq(p.events.map((e) => e.text), ["done"], "only the complete line");
  eq(p.end, whole, "end stops at its newline");
  Deno.writeTextFileSync(path, `age":{"content":"later"},"timestamp":"${T}"}\n`, {append: true});
  eq(readFrom(path, p.end).events.map((e) => e.text), ["later"], "and it arrives whole");
});

Deno.test("readFrom: follows appends, and restarts on a replaced or far-behind log", () => {
  const path = file([user("one")]);
  const p = readPage(path);
  eq(readFrom(path, p.end), {events: [], end: p.end}, "nothing new");
  Deno.writeTextFileSync(path, `${JSON.stringify(user("two"))}\n`, {append: true});
  const f = readFrom(path, p.end);
  eq(f.events.map((e) => e.text), ["two"], "the appended line");
  eq(f.end, Deno.statSync(path).size, "and the new offset");
  eq(readFrom(path, f.end + 999).reset, true, "a log shorter than the offset was replaced");
  Deno.writeTextFileSync(path, `${JSON.stringify(user("z".repeat(CATCHUP)))}\n`,
    {append: true});
  const far = readFrom(path, f.end);
  eq([far.reset, far.events.at(-1).text.length > 1000], [true, true],
    "too far behind: the tail, from scratch");
  eq(readFrom("/nonexistent.jsonl", 7), {events: [], end: 7}, "no log is no events");
});

Deno.test("logPath: the slug of the cwd, then the session", () => {
  eq(logPath("/Users/x/ai/c.c", "abc", "/r"), "/r/projects/-Users-x-ai-c-c/abc.jsonl", "path");
});
