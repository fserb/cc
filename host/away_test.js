// `deno test -A --ext js away_test.js`: which dialogs away mode answers, and how, on the
// captures in fixtures/dialog.

import {Away, plan} from "./away.js";
import {parseDialog} from "./dialog.js";

function eq(got, want, what) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`${what}: got ${g}, want ${w}`);
}

const dialog = (name) =>
  parseDialog(Deno.readTextFileSync(new URL(`fixtures/dialog/${name}.txt`, import.meta.url)));

Deno.test("plan: only the question tool, free text where it takes a sentence", () => {
  for (const name of ["bash", "bash-code", "write", "write-narrow", "trust", "plan", "exit-background"]) {
    eq(plan(dialog(name)), null, name);
  }
  eq(plan(dialog("question")), {how: "free", i: 3}, "question");
  eq(plan(dialog("question-multi")), {how: "chat", i: 5}, "question-multi");
  eq(plan(dialog("question-tabs")), {how: "chat", i: 3}, "question-tabs (preview)");
  eq(plan(dialog("question-submit")), {how: "submit", i: 0}, "question-submit");
  eq(plan(dialog("question-tabs-review")), {how: "submit", i: 0}, "question-tabs-review");
  eq(plan(null), null, "no dialog");
});

Deno.test("Away: the setting and the log survive a restart", () => {
  const dir = Deno.makeTempDirSync();
  const opts = {file: `${dir}/away.json`, log: `${dir}/away.jsonl`};
  const a = new Away(opts);
  eq(a.state().on, false, "off by default");
  a.set(true);
  Deno.writeTextFileSync(opts.log, `${JSON.stringify({at: Date.now(), pid: 1, question: "q?", how: "free", sessionId: "", end: -1})}\n`);
  const b = new Away(opts);
  eq(b.state().on, true, "on after a restart");
  eq(b.answered().map((x) => [x.question, x.reply]), [["q?", ""]], "the log");
});
