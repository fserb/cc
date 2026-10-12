// `deno test -A --ext js queue_test.js`. fixtures/queue are `tmux capture-pane -p -e` of a
// scratch session on 2.1.296 kept busy by a foreground sleep: queued.txt three typed
// messages queued, draft.txt "my draft" typed into the box over them, popped.txt the box
// after Up, cleared.txt after ctrl+u, idle.txt a finished turn. log.jsonl is that
// session's queue-operation records: three typed and one peer message enqueued behind two
// already queued, an Up popping the four typed ones (one a large paste), the peer message
// removed as it was sent.

import {inputBox, poppedFrom, remaining, unwrap} from "./queue.js";

function eq(got, want, what) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`${what}: got ${g}, want ${w}`);
}

const fixture = (name) => Deno.readTextFileSync(new URL(`fixtures/queue/${name}`, import.meta.url));

Deno.test("inputBox: the dim hint is empty, typed text is not", () => {
  eq(inputBox(fixture("queued.txt"))?.state, "empty", "Press up to edit queued messages");
  eq(inputBox(fixture("cleared.txt"))?.state, "empty", "cleared");
  eq(inputBox(fixture("idle.txt"))?.state, "empty", "idle");
  eq(inputBox(fixture("draft.txt")), {state: "text", lines: ["my draft"]}, "a draft");
  eq(inputBox(fixture("popped.txt")), {state: "text", lines: ["first queued A",
    "  second queued B", "  with a second line", "  third queued C"]}, "after Up");
  eq(inputBox("no box here\n"), null, "no box");
});

Deno.test("inputBox: a dim suggestion is empty, a dim word after typed text is not", () => {
  const rule = "\x1b[38;5;244m" + "─".repeat(40) + "\x1b[39m";
  const box = (line) => `${rule}\n${line}\n${rule}\n\n  footer\n`;
  eq(inputBox(box("\x1b[39m❯ \x1b[2mfix the tests\x1b[0m")).state, "empty", "suggestion");
  eq(inputBox(box("\x1b[39m❯ hi \x1b[2mthere\x1b[0m")).state, "text", "typed then dim");
});

Deno.test("poppedFrom: the popAll records in order, unwrap a large paste", () => {
  const popped = poppedFrom(fixture("log.jsonl"));
  eq(popped.length, 4, "four popped");
  eq([popped[0], popped[1], popped[3]], ["first queued A", "third queued C", "typed T"], "order");
  const long = unwrap(popped[2]);
  eq([long.startsWith("long line 0 "), long.endsWith("x"), long.split("\n").length], [true, true, 12],
    "paste tags gone");
  eq(poppedFrom('{"type":"queue-operation","operation":"popAll"}\nnot json "queue-operation"\n'), [],
    "no content, a bad line");
});

Deno.test("remaining: the first equal message comes out, the rest stay in order", () => {
  const popped = poppedFrom(fixture("log.jsonl"));
  const r = remaining(popped, "third queued C");
  eq([r.found, r.rest.length, r.rest[0], r.rest[2]], [true, 3, "first queued A", "typed T"], "middle");
  eq(remaining(popped, "nope"), {found: false, rest: popped.map(unwrap)}, "not there: all back");
  eq(remaining(["a", "b\nc", "a"], "a"), {found: true, rest: ["b\nc", "a"]}, "a repeat: the first");
  eq(remaining(["a", "b\nc"], " b  c "), {found: true, rest: ["a"]}, "whitespace runs");
  eq(remaining([popped[2]], unwrap(popped[2])).found, true, "a paste matches its text");
});

Deno.test("remaining: an image is [Image #N] in the queue and the mark in the text", () => {
  const got = remaining(["queued [Image #7] colours?", "b"], "queued \u{1F5BC} colours?");
  if (!got.found || JSON.stringify(got.rest) !== '["b"]') throw new Error(JSON.stringify(got));
});
