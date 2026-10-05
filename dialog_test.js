// `deno test -A --ext js dialog_test.js`. The fixtures are `tmux capture-pane -p` of real
// dialogs on 2.1.289, one session in a scratch directory; question-wide.txt is a capture
// from another project with its words replaced and its layout kept.

import {parseDialog, pickKeys} from "./dialog.js";

function eq(got, want, what) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`${what}: got ${g}, want ${w}`);
}

const fixture = (name) =>
  Deno.readTextFileSync(new URL(`fixtures/dialog/${name}.txt`, import.meta.url));

// [n, label, current, checked, keys] per option
function summary(name) {
  const d = parseDialog(fixture(name));
  return d.options.map((o, i) => [o.n, o.label, o.current, o.checked, pickKeys(d, i).join(" ")]);
}

Deno.test("parseDialog: folder trust is bare, and its default is No", () => {
  const d = parseDialog(fixture("trust"));
  eq(d.title, "Accessing workspace:", "title");
  eq(d.body.split("\n")[0], "/private/tmp/ccx-dlg", "the folder, first in the body");
  eq(summary("trust"), [
    [null, "No, exit", true, null, "Enter"],
    [null, "Yes, I trust this folder", false, null, "Down Enter"],
  ], "options, picked by arrows");
});

Deno.test("parseDialog: a Bash permission, the command in the card", () => {
  const d = parseDialog(fixture("bash"));
  eq(d.title, "Bash command", "title");
  eq(d.body.includes("date > now.txt") && d.body.endsWith("Do you want to proceed?"), true,
    "command and question");
  eq(summary("bash").map(([n, label, , , keys]) => [n, label.slice(0, 12), keys]), [
    [1, "Yes", "1"], [2, "Yes, and alw", "2"], [3, "Yes, and swi", "3"], [4, "No", "4"],
  ], "numbered, picked by digit");
});

Deno.test("parseDialog: a wrapped label goes to detail", () => {
  const d = parseDialog(fixture("write-narrow"));
  eq(d.options[1].label, "Yes, and switch to accept edits (auto-approve file", "first line");
  eq(d.options[1].detail,
    "edits and common file commands) for this session\n(shift+tab)", "the rest");
  eq(parseDialog(fixture("write")).options[1].detail, "", "unwrapped at full width");
});

Deno.test("parseDialog: the question tool, past the rule to Chat about this", () => {
  eq(summary("question").map(([n, label]) => [n, label]), [
    [1, "red"], [2, "green"], [3, "blue"], [4, "Type something."], [5, "Chat about this"],
  ], "single-select");
  eq(parseDialog(fixture("question")).options[0].detail, "Red", "description");
  const wide = parseDialog(fixture("question-wide"));
  eq([wide.title, wide.body], ["☐ First run",
    "The cache takes about 14 s to build the first time. What should the first run do?"],
    "the │ stripped off the question");
});

Deno.test("parseDialog: a multi-select, its boxes and its bare Submit", () => {
  eq(summary("question-multi-checked"), [
    [1, "apple", true, true, "1"],
    [2, "pear", false, false, "2"],
    [3, "plum", false, true, "3"],
    [4, "Type something", false, false, "4"],
    [null, "Submit", false, null, "Down Down Down Down Enter"],
    [5, "Chat about this", false, null, "5"],
  ], "checked state, and Submit by arrows");
  eq(parseDialog(fixture("question-multi-checked")).options[0].detail, "Apple",
    "the description sits past the box");
});

Deno.test("parseDialog: the review page and plan approval", () => {
  eq(summary("question-submit").map(([n, label]) => [n, label]),
    [[1, "Submit answers"], [2, "Cancel"]], "review");
  const plan = parseDialog(fixture("plan"));
  eq(plan.options.map((o) => o.label), ["Yes, and use auto mode",
    "Yes, manually approve edits", "Tell Claude what to change"],
    "the plan's own 1. and 2. are not options");
  eq(plan.title.startsWith("Claude has written up a plan"), true, "title");
});

Deno.test("parseDialog: an idle input box is no dialog", () => {
  const idle = fixture("idle");
  eq(parseDialog(idle), null, "an echoed prompt over a numbered list");
  const echoed = idle.replace('❯ Reply with just "ok":\n  1. first', "❯ 1. first");
  eq(echoed.includes("❯ 1. first\n  2. second"), true, "the fixture edit applied");
  eq(parseDialog(echoed), null, "an echoed prompt that is itself a numbered list");
  eq(parseDialog(""), null, "an empty capture");
});
