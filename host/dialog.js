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
// - **the question tool's free-text option is the one above `Chat about this`**, a field
//   that reads `Type something.` until it holds text, then the text. Its digit moves the
//   cursor onto it and focuses it; with the cursor there every key is text, so a second
//   `3` types `3` (2.1.296). It is answered with its digit unless already focused, ctrl+u
//   to clear it, a bracketed paste, Enter. Only single-select: a multi-select's is a box
// - **several questions draw a tab row** (2.1.296), `←  ☐ Design  ☐ Storage  ✔ Submit  →`, ✔
//   ☒ once answered (Submit's ✔ is its icon). Which tab is current is only a background colour, which `capture-pane -p`
//   drops, so `tabs` says only which are answered; a pick moves to the next question
// - **options with a preview draw it to their right**, a ┌─┐ box at a fixed column whose
//   rows end the option lines, with `Notes: press n to add notes` under it at that column;
//   that dialog has no free-text option and a bare `Chat about this` under a rule. The box
//   is cut off the lines and its text, `✂ N lines hidden` and all, is the current option's
//   `preview`. **There a digit only moves the cursor**, and Enter picks (the dialog says
//   `digitMoves`)

import {run} from "./sh.js";
import {sendKeys} from "./jump.js";

const NUMBERED = /^(\s*)(?:❯\s+)?(\d+)\.\s+(.*)$/;
const CURSOR = /^\s*❯\s+\S/;
const RULE = /^\s*─{3,}/;
const DASHED = /^\s*╌{3,}\s*$/;
const FOOTER = /Esc to cancel/;
const CHECK = /^\[([^\]])\]\s+/;
const BELOW = 3;
const TABS = /^←\s.*→$/;

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
  // the cursor on the preview layout's bare `Chat about this`: the option whose preview shows
  // keeps its ❯, so the block is read from there
  let onChat = false;
  if (/^\s*❯\s+Chat about this$/.test(lines[cursor])) {
    const opt = lines.findLastIndex((l, i) => i < cursor && CURSOR.test(l) && NUMBERED.test(l));
    if (opt >= 0 && lines.slice(opt + 1, cursor).some((l) => RULE.test(l))) [cursor, onChat] = [opt, true];
  }
  const preview = cutPreview(lines, cursor);
  const head = lines[cursor].match(NUMBERED);
  let [from, to, options] = head
    ? numbered(lines, cursor, head[1].length + head[0].slice(head[1].length).search(/\d/))
    : bare(lines, cursor);
  // the preview layout's bare `Chat about this`, under a rule below the options
  let end = to;
  while (end < lines.length && !lines[end].trim()) end++;
  if (options.length && RULE.test(lines[end] ?? "") && /^\s*(?:❯)?\s+Chat about this$/.test(lines[end + 1] ?? "")) {
    if (onChat) options.forEach((o) => o.current = false);
    options.push({n: null, label: "Chat about this", detail: "", current: onChat, checked: null, bare: true});
    to = end + 2;
  }
  if (options.length < 2) return null;
  const below = lines.slice(to).filter((l) => l.trim());
  if (RULE.test(below.at(-1) ?? "")) below.pop();  // the bottom rule with the session's name
  if (below.length > BELOW) return null;
  if (preview) options[onChat ? options.length - 2 : options.findIndex((o) => o.current)].preview = preview;
  const chat = options.findIndex((o) => o.label === "Chat about this");
  const free = options[chat - 1];
  const bareChat = options[chat]?.bare;
  if (bareChat) delete options[chat].bare;
  else if (chat > 1 && free.n !== null && options.every((o) => o.checked === null)) free.free = true;
  let top = from - 1;
  while (top >= 0 && !RULE.test(lines[top])) top--;
  const card = cardLines(lines.slice(top < 0 ? Math.max(0, from - 12) : top + 1, from));
  while (card.length && !card[0]) card.shift();
  const tabs = TABS.test(card[0] ?? "") ? [...card.shift().matchAll(/([☐✔☒])\s+(.+?)(?=\s{2,}|\s*→)/g)].map(([, box, label]) => ({label, done: box === "☒"})) : null;
  while (card.length && !card[0]) card.shift();
  // a tab's question can wrap: it is the title up to the first blank line
  const qEnd = tabs ? Math.max(1, card.indexOf("") < 0 ? card.length : card.indexOf("")) : 1;
  const title = card.slice(0, qEnd).join(" ");
  const body = card.slice(qEnd).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return {title, body, options, ...tabs && {tabs}, ...bareChat && {digitMoves: true}};
}

// The preview box right of the options: found on the lines from the dialog's top rule down, cut
// off them in place (a line all at its column goes blank), and its text returned, or null
function cutPreview(lines, cursor) {
  let top = cursor;
  while (top > 0 && !RULE.test(lines[top - 1])) top--;
  let col = -1;
  for (let i = top; i < lines.length && col < 0; i++) {
    const m = lines[i].match(/^(.*\S)?\s{2,}┌─+┐$/);
    if (m && i <= cursor + 1) col = lines[i].lastIndexOf("┌");
  }
  if (col < 0) return null;
  const out = [];
  for (let i = top; i < lines.length; i++) {
    const l = lines[i];
    if (l.length <= col || l.slice(0, col).trim() && !/\s{2}$/.test(l.slice(0, col))) continue;
    if (!/^[┌│├└]/.test(l.slice(col)) && !(indentOf(l) >= col && /^Notes:/.test(l.trim()))) continue;
    const box = l.slice(col);
    lines[i] = l.slice(0, col).trimEnd();
    const cut = box.match(/✂\s*─*\s*(.*?)\s*─*┤$/);
    if (cut) out.push(`✂ ${cut[1]}`);
    else if (box.startsWith("│")) out.push(box.replace(/^│ ?/, "").replace(/\s*│$/, ""));
  }
  while (out.length && !out.at(-1).trim()) out.pop();
  return out.join("\n") || null;
}

// The card's lines trimmed, except what sits between two `╌` rules (a command, a diff, a
// file): that comes back as a ``` block with its indentation as drawn, less the `│` gutter
// and the indent all its lines share, so cc can show it as code. The card runs up to the
// dialog's `─` rule however far up it is, or a long command cuts its title off
function cardLines(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!DASHED.test(lines[i])) {
      out.push(lines[i].replace(/^\s*│/, "").trim());
      continue;
    }
    const end = lines.findIndex((l, k) => k > i && DASHED.test(l));
    if (end < 0) continue;
    let code = lines.slice(i + 1, end);
    if (code.every((l) => !l.trim() || /^\s*│/.test(l))) code = code.map((l) => l.replace(/^\s*│ ?/, ""));
    const cut = Math.min(...code.filter((l) => l.trim()).map(indentOf));
    code = code.map((l) => l.slice(cut));
    // longer than any run of backticks inside, so none of them closes it
    const fence = "`".repeat(Math.max(3, ...code.map((l) => Math.max(0, ...(l.match(/`+/g) ?? []).map((b) => b.length + 1)))));
    out.push(fence, ...code, fence);
    i = end;
  }
  return out;
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
    // short of the label too, outside a multi-select: a label wrapped beside a preview
    if (indentOf(line) >= labelCol || last.checked === null) {
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
// and Enter. The free-text option takes `text` after its keys, which pick() pastes.
export function pickKeys(dialog, i) {
  const opt = dialog.options[i];
  if (opt.free) return [...opt.current ? [] : [String(opt.n)], "C-u"];
  if (opt.n !== null && opt.n >= 1 && opt.n <= 9) return dialog.digitMoves ? [String(opt.n), "Enter"] : [String(opt.n)];
  const d = i - dialog.options.findIndex((o) => o.current);
  return [...Array(Math.abs(d)).fill(d < 0 ? "Up" : "Down"), "Enter"];
}

// Pick option `i` of the dialog up on the instance's pane, if its labels are still
// `labels`: the screen is read again first, so a tap never lands on a dialog other than the
// one it was drawn from. `answer` answers the free-text option and is refused on any other.
// An error message, or null when it worked.
export async function pick(inst, i, labels, answer) {
  if (!inst.pane) return `pid ${inst.pid} is not inside tmux`;
  const text = await screen(inst.pane);
  if (text === null) return `tmux: cannot capture ${inst.pane}`;
  const dialog = parseDialog(text);
  if (!dialog) return "no dialog is up";
  const now = dialog.options.map((o) => o.label);
  if (JSON.stringify(now) !== JSON.stringify(labels)) return "the dialog changed";
  if (!Number.isInteger(i) || i < 0 || i >= now.length) return `no option ${i}`;
  if (answer === undefined) {
    if (dialog.options[i].free) return "that option takes text";
    return sendKeys(inst, pickKeys(dialog, i));
  }
  if (!dialog.options[i].free) return `option ${i} takes no text`;
  if (!String(answer).trim()) return "no text";
  // the digit first and on its own: the field takes keys once it has focus, a render later
  const keys = pickKeys(dialog, i), clear = keys.pop();
  if (keys.length) {
    const err = await sendKeys(inst, keys);
    if (err) return err;
    await new Promise((res) => setTimeout(res, 300));
  }
  const buf = `ccx-${inst.pid}`, t = inst.pane;
  const r = await run("tmux", "send-keys", "-t", t, clear, ";",
    "set-buffer", "-b", buf, "--", String(answer), ";",
    "paste-buffer", "-p", "-d", "-b", buf, "-t", t, ";", "send-keys", "-t", t, "Enter");
  return r.code === 0 ? null : `tmux: ${r.err.trim() || `exit ${r.code}`}`;
}
