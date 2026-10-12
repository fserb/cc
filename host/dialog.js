// The dialog a session has up, read off its pane, and the keys that answer it. No UI here:
// parseDialog() is the reading, pick() the answering.
//
// Measured on 2.1.289 against six kinds: folder trust, a Bash and a Write permission, the
// question tool single-select, multi-select and its review page, and plan approval. The
// captures are in fixtures/dialog. Each kind that does not parse is one more to add.
//
// - **folder trust has no record**: the session writes none until it is answered, so
//   `waitingFor` says nothing about it. The screen is the only source, read whenever the
//   state is wait
// - the options are the block around the `❯` cursor, `N. label` with continuation lines
//   under it, a rule between two of them allowed. Not every numbered line: a plan's own
//   steps are `1.` `2.` above the options of the dialog approving it
// - **folder trust is not numbered, and its default is "No, exit"**: `❯ No, exit` over
//   `Yes, I trust this folder`. A bare list counts only over an `Esc to cancel` footer,
//   since the input prompt starts with `❯` too
// - **a dialog ends at the bottom of the screen**: at most 3 non-blank lines under its
//   options (a footer, a rule, `Chat about this`), against 4 for the input box. That is
//   what keeps a prompt echoed as `❯ 1. foo` above an idle input box from reading as one
// - a wrapped label continues at the label's column, which is where a question's
//   description goes, so the two cannot be told apart and both land in `detail`
// - a multi-select draws `[ ]` / `[✔]` before the label, its descriptions at the column
//   after the box, and `Submit` bare at the label's own column
// - **a digit alone picks a numbered option**, no Enter. A Bash permission ran on `1`; the
//   question tool picked on `3` and moved to the next question; a multi-select toggled the
//   box. A bare option is reached with arrows from the cursor, then Enter
// - the dialog is bounded above by a `─` rule; a `╌` rule is inside it, around a command
//   or a diff

import {run} from "./sh.js";
import {sendKeys} from "./jump.js";

const NUMBERED = /^(\s*)(?:❯\s+)?(\d+)\.\s+(.*)$/;
const CURSOR = /^\s*❯\s+\S/;
const RULE = /^\s*─{3,}/;
const DASHED = /^\s*╌{3,}\s*$/;
const FOOTER = /Esc to cancel/;
const CHECK = /^\[([^\]])\]\s+/;
const BELOW = 3;

const indentOf = (line) => line.length - line.trimStart().length;

// The pane as it is on screen now, without scrollback.
export async function screen(pane) {
  const r = await run("tmux", "capture-pane", "-p", "-t", pane);
  return r.code === 0 ? r.out : null;
}

// {title, body, options: [{n, label, detail, current, checked}]}, or null when there is no
// dialog this can read. `n` is the option's number, null for a bare one; `checked` is
// null outside a multi-select.
export function parseDialog(text) {
  const lines = text.split("\n").map((l) => l.trimEnd());
  let cursor = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CURSOR.test(lines[i])) {
      cursor = i;
      break;
    }
  }
  if (cursor < 0) return null;
  const head = lines[cursor].match(NUMBERED);
  const [from, to, options] = head
    ? numbered(lines, cursor, head[1].length + head[0].slice(head[1].length).search(/\d/))
    : bare(lines, cursor);
  if (options.length < 2) return null;
  if (lines.slice(to).filter((l) => l.trim()).length > BELOW) return null;
  let top = from - 1;
  while (top >= 0 && !RULE.test(lines[top])) top--;
  const card = lines.slice(Math.max(top + 1, from - 12), from)
    .filter((l) => !DASHED.test(l)).map((l) => l.replace(/^\s*│/, "").trim());
  while (card.length && !card[0]) card.shift();
  const body = card.slice(1).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return {title: card[0] ?? "", body, options};
}

// The block of numbered options around the cursor: up and down while a line is an option
// at the cursor's number column or indented past it, across a rule with an option under it.
function numbered(lines, cursor, col) {
  const inBlock = (l) => {
    const m = l.match(NUMBERED);
    return m ? m[0].search(/\d/) === col : l.trim() !== "" && indentOf(l) > col;
  };
  const ruleInside = (i) => RULE.test(lines[i] ?? "") && inBlock(lines[i - 1] ?? "") &&
    inBlock(lines[i + 1] ?? "");
  let from = cursor, to = cursor + 1;
  while (from > 0 && (inBlock(lines[from - 1]) || ruleInside(from - 1))) from--;
  while (to < lines.length && (inBlock(lines[to]) || ruleInside(to))) to++;
  // a block starts at an option, never at a continuation
  while (from < cursor && !NUMBERED.test(lines[from])) from++;

  const options = [];
  let labelCol = 0;
  for (let i = from; i < to; i++) {
    const line = lines[i];
    if (RULE.test(line)) continue;
    const m = line.match(NUMBERED);
    if (m && m[0].search(/\d/) === col) {
      const box = m[3].match(CHECK);
      const label = box ? m[3].slice(box[0].length) : m[3];
      labelCol = line.length - label.length;
      options.push({n: Number(m[2]), label: label.trim(), detail: "",
        current: line.trimStart().startsWith("❯"), checked: box ? box[1] !== " " : null});
      continue;
    }
    const last = options.at(-1);
    if (indentOf(line) >= labelCol) {
      last.detail = last.detail ? `${last.detail}\n${line.trim()}` : line.trim();
      continue;
    }
    // under a checkbox, short of its label: the multi-select's `Submit`
    options.push({n: null, label: line.replace("❯", "").trim(), detail: "",
      current: line.trimStart().startsWith("❯"), checked: null});
  }
  return [from, to, options];
}

// Folder trust: one option per line at the cursor's label column, and nothing else on them.
function bare(lines, cursor) {
  const col = lines[cursor].search(/❯\s+\S/) +
    lines[cursor].slice(lines[cursor].indexOf("❯") + 1).search(/\S/) + 1;
  const inBlock = (l) => l !== undefined && !CURSOR.test(l) && l.trim() !== "" &&
    indentOf(l) === col;
  let from = cursor, to = cursor + 1;
  while (inBlock(lines[from - 1])) from--;
  while (inBlock(lines[to])) to++;
  if (!lines.slice(to, to + 3).some((l) => FOOTER.test(l))) return [from, to, []];
  const options = lines.slice(from, to).map((l) => ({n: null,
    label: l.replace("❯", "").trim(), detail: "", current: l.includes("❯"), checked: null}));
  return [from, to, options];
}

// Why text typed onto this screen must not go in, or null. A dialog takes the Enter that
// follows the text as picking its highlighted option, usually "Yes": an approval nobody
// read. typeInto() refuses on it, unless forced.
export function dialogRefusal(text) {
  const dialog = parseDialog(text);
  if (!dialog) return null;
  return dialog.title ? `waits on a dialog: ${dialog.title}` : "waits on a dialog";
}

// The tmux keys that pick option `i`: its digit if it has one, else arrows from the cursor
// and Enter.
export function pickKeys(dialog, i) {
  const opt = dialog.options[i];
  if (opt.n !== null && opt.n >= 1 && opt.n <= 9) return [String(opt.n)];
  const d = i - dialog.options.findIndex((o) => o.current);
  return [...Array(Math.abs(d)).fill(d < 0 ? "Up" : "Down"), "Enter"];
}

// Pick option `i` of the dialog up on the instance's pane, if its labels are still
// `labels`: the screen is read again first, so a tap never lands on a dialog other than the
// one it was drawn from. An error message, or null when it worked.
export async function pick(inst, i, labels) {
  if (!inst.pane) return `pid ${inst.pid} is not inside tmux`;
  const text = await screen(inst.pane);
  if (text === null) return `tmux: cannot capture ${inst.pane}`;
  const dialog = parseDialog(text);
  if (!dialog) return "no dialog is up";
  const now = dialog.options.map((o) => o.label);
  if (JSON.stringify(now) !== JSON.stringify(labels)) return "the dialog changed";
  if (!Number.isInteger(i) || i < 0 || i >= now.length) return `no option ${i}`;
  return sendKeys(inst, pickKeys(dialog, i));
}
