// `deno test -A --ext js dialog_test.js`. The fixtures are `tmux capture-pane -p` of real
// dialogs on 2.1.289, one session in a scratch directory; question-wide.txt is a capture
// from another project with its words replaced and its layout kept.

import {dialogRefusal, parseDialog, pickKeys} from "./dialog.js";
import {IMAGE, imageParts, typeInto} from "./jump.js";
import {run} from "./sh.js";

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

Deno.test("dialogRefusal: every dialog refuses typing, an idle input box does not", () => {
  eq(dialogRefusal(fixture("trust")), "waits on a dialog: Accessing workspace:", "trust");
  for (const name of ["bash", "write", "write-narrow", "plan", "question", "question-multi"]) {
    eq(dialogRefusal(fixture(name)), `waits on a dialog: ${parseDialog(fixture(name)).title}`,
      name);
  }
  eq(dialogRefusal(fixture("idle")), null, "idle");
  eq(dialogRefusal(""), null, "an empty capture");
});

// A pane in a throwaway tmux session showing a captured dialog: typeInto() refuses and
// types nothing, and with force it types.
Deno.test("typeInto: refused on a pane showing a dialog, typed with force", async () => {
  const sess = `ccx-test-${Deno.pid}`;
  const file = new URL("fixtures/dialog/bash.txt", import.meta.url).pathname;
  const made = await run("tmux", "new-session", "-d", "-s", sess, "-x", "200", "-y", "50",
    `cat '${file}'; cat > /dev/null`);
  if (made.code !== 0) return console.log(`no tmux: ${made.err.trim()}`);
  try {
    const pane = `${sess}:0.0`;
    let shown = "";
    for (let n = 0; n < 50 && !dialogRefusal(shown); n++) {
      await new Promise((ok) => setTimeout(ok, 50));
      shown = (await run("tmux", "capture-pane", "-p", "-t", pane)).out;
    }
    const inst = {pid: 0, pane};
    eq(await typeInto(inst, "zzmark"), "waits on a dialog: Bash command", "refused");
    await new Promise((ok) => setTimeout(ok, 200));
    let now = (await run("tmux", "capture-pane", "-p", "-t", pane)).out;
    eq(now.includes("zzmark"), false, "nothing was typed");
    eq(await typeInto(inst, "zzmark", {force: true}), null, "forced");
    for (let n = 0; n < 40 && !now.includes("zzmark"); n++) {
      await new Promise((ok) => setTimeout(ok, 50));
      now = (await run("tmux", "capture-pane", "-p", "-t", pane)).out;
    }
    eq(now.includes("zzmark"), true, "typed");
  } finally {
    await run("tmux", "kill-session", "-t", sess);
  }
});

Deno.test("parseDialog: the question tool's free-text option", () => {
  const d = parseDialog(fixture("question"));
  eq(d.options.map((o) => !!o.free), [false, false, false, true, false], "Type something.");
  eq(pickKeys(d, 3), ["4", "C-u"], "its digit, then clear");
  d.options[3].current = true;
  eq(pickKeys(d, 3), ["C-u"], "no digit once focused: it would be typed");
  eq(parseDialog(fixture("question-multi")).options.some((o) => o.free), false, "not multi");
});

Deno.test("imageParts: each image where its mark is, the unmarked first", () => {
  eq(imageParts(`a ${IMAGE} b ${IMAGE}`, ["/1", "/2"]), ["a ", {path: "/1"}, " b ", {path: "/2"}], "marked");
  eq(imageParts("hi", ["/1"]), [{path: "/1"}, "hi"], "no mark");
  eq(imageParts(`${IMAGE}x${IMAGE}`, ["/1"]), [{path: "/1"}, `x${IMAGE}`], "a mark too many stays");
});

Deno.test("parseDialog: a long command keeps the title, and comes as a ``` block as drawn", () => {
  const d = parseDialog(fixture("bash-code"));
  eq(d.title, "Bash command", "title past 12 lines up");
  const code = d.body.match(/^```\n([^]*?)\n```$/m)[1].split("\n");
  eq(code.slice(0, 4), ["cat <<'X' > /tmp/perm-test/out.txt",
    "  a * b & c < d > e \"quoted\" 'single' `tick` **bold** _u_ &amp; &lt;",
    "    tab-indented line", "X"], "indentation and characters kept, no │");
  eq(d.body.endsWith("Do you want to proceed?"), true, "the question after it");
});

// question-preview is photo-a's pane on marx (2.1.296); question-tabs* a scratch session on
// nadya walked through it: first question, cursor on Chat about this, second, review
Deno.test("parseDialog: several questions with previews, tabs and a bare Chat about this", () => {
  const d = parseDialog(fixture("question-preview"));
  eq(d.title, "Which picking interface should I build? (All judge each look at full strength, through the real shader, on the reference photos or your own.)", "the wrapped question is the title");
  eq(d.tabs, [{label: "Design", done: false}, {label: "Storage", done: false}, {label: "Submit", done: false}], "tabs");
  eq(d.options.map((o, i) => [o.label, o.detail, !!o.free, pickKeys(d, i).join(" ")]), [
    ["Triage + dial strip", "(Recommended)", false, "1 Enter"],
    ["A/B duels", "", false, "2 Enter"],
    ["One per cluster", "", false, "3 Enter"],
    ["Triage + duels + clusters", "", false, "4 Enter"],
    ["Chat about this", "", false, "Down Down Down Down Enter"],
  ], "options, the box cut off them; a digit only moves, so Enter after it");
  eq(d.options[0].preview, "[ref: 1 2 3 4 5 own ]  show: undecided ▾\n✂ 13 lines hidden", "the current option's preview");
  eq(parseDialog(fixture("question-tabs")).options[0].preview, "+--------------------------------------+\n✂ 14 lines hidden", "80 columns");
  eq(parseDialog(fixture("question-tabs-2")).options[0].preview.split("\n")[0], 'const path = "picks.json"', "160 columns: all of it");
  const chat = parseDialog(fixture("question-tabs-chat"));
  eq(chat.options.map((o) => [o.current, !!o.preview]), [[false, false], [false, false], [false, true], [true, false]],
    "the cursor on Chat about this, the last option keeping its ❯ and preview");
  const two = parseDialog(fixture("question-tabs-2"));
  eq([two.title, two.tabs.map((t) => t.done)], ["Where do picks go?", [true, false, false]], "the first answered: ☒");
  const review = parseDialog(fixture("question-tabs-review"));
  eq([review.title, review.options.map((o) => o.label), pickKeys(review, 0)], ["Review your answers", ["Submit answers", "Cancel"], ["1"]], "review");
  eq(review.body.includes("→ SQLite"), true, "the answers in the body");
});

// a 24-row pane (ccx new's detached default) under a question longer than that; the words replaced
Deno.test("parseDialog: a question taller than the screen is cut, all of what shows is its body", () => {
  const d = parseDialog(fixture("question-cut"));
  eq([d.cut, d.title, d.options.map((o) => o.label)], [true, "", ["apply all", "apply none", "Type something.", "Chat about this"]], "cut, no title");
  eq([d.body.split("\n")[0].slice(0, 10), d.body.split("\n").at(-1)], ["LOR emi Ps", "rsita metconse: ctetu rad."], "every line on screen");
});
