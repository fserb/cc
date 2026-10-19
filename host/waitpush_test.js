import {due, text, WAIT} from "./waitpush.js";

const eq = (a, b, m) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
};
const now = 1_000_000_000;
const row = (pid, ago, more) => ({pid, name: pid, state: "wait", since: (now - ago) / 1000, asking: "", question: "", ...more});

Deno.test("waitpush: a question or dialog past WAIT is pushed once; kept while it waits", () => {
  const rows = [row("nadya.1", WAIT, {question: "which?"}), row("nadya.2", WAIT - 1, {asking: "input needed"}),
    row("nadya.3", WAIT * 9), row("marx.4", WAIT, {asking: "dialog open", state: "busy"})];
  const a = due({rows, up: ["nadya", "marx"]}, new Set(), now);
  eq(a.push.map((r) => r.pid), ["nadya.1", "marx.4"], "due");
  eq([...a.live], [], "nothing pushed yet");
  const pushed = new Set(a.push.map((r) => `${r.pid} ${r.since}`));
  const b = due({rows, up: ["nadya", "marx"]}, pushed, now + WAIT);
  eq(b.push.map((r) => r.pid), ["nadya.2"], "the rest, once due");
  eq(b.live.size, 2, "the pushed ones still waiting");
  eq([...due({rows: [], up: ["nadya"]}, pushed, now).live], [`marx.4 ${rows[3].since}`], "a host out of the list keeps its keys");
  eq(text(row("nadya.1", 0, {question: "pick\n  one?"})), "nadya.1 waits on you: pick one?", "text");
});
