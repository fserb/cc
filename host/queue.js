// Taking a queued message back out of a session's queue, leaving the rest queued.
//
// Measured on 2.1.296 (2026-10-12), on a scratch session kept busy by a foreground sleep:
//
// - a prompt typed while a turn runs is queued, drawn above the input box as `❯ <text>`
//   blocks, and the empty box reads `Press up to edit queued messages`, dim (SGR 2). A
//   peer message (SendMessage, `ccx send`) is queued too, drawn as `› Message from @<name>`
// - **Up pops every typed message into the input box, oldest first, joined by "\n"**; the
//   peer messages stay queued. Text already in the box goes after them, after one more
//   "\n". A large paste is drawn as `[Pasted text #1 +11 lines]` in the box. With nothing
//   to pop, Up recalls the previous prompt from history instead
// - the transcript writes each change as a `queue-operation` record: `enqueue` with the
//   content, `popAll` once per popped message with its content (same timestamp), `dequeue`
//   (no content) as one is sent, `remove` with the content as a peer message is. A large
//   paste's content is `<pasted_content id="841e">\n<text>\n</pasted_content id="841e">`.
//   The records are not complete: the first session here logged an `enqueue` with no
//   content and none at all for another, so the queue is not rebuilt from the log; the
//   `popAll` records written after our Up are what came out
// - ctrl+u deletes to the start of the line, then the newline before it; Enter on a
//   pasted message queues it again behind the peer messages still queued
//
// So: refuse unless the box is empty but for its dim hint, press Up, read the `popAll`
// records it wrote, empty the box, and type back every popped message but the first equal
// to `text`, each a bracketed paste and Enter, as typeInto() does.

import { run } from "./sh.js";
import { dialogRefusal } from "./dialog.js";
import { imageKey, pasteParts, sendKeys, typedImages, unpic } from "./jump.js";
import { logPath } from "./transcript.js";

const SGR = /\x1b\[[\d;]*m/g;
const RULE = /^\s*─{3,}/;
const plain = (line) => line.replace(SGR, "");

// The input box off a `capture-pane -e` screen: {state, lines}, state `empty` (nothing,
// or only the dim hint or a dim suggestion) or `text`, lines the box's plain lines. null
// when there is no box: the bottom two `─` rules with `❯` opening the lines between.
export function inputBox(raw) {
  const lines = raw.replace(/\n+$/, "").split("\n");
  let bottom = -1, top = -1;
  for (let i = lines.length - 1; i >= 0 && top < 0; i--) {
    if (!RULE.test(plain(lines[i]))) continue;
    if (bottom < 0) bottom = i;
    else top = i;
  }
  if (top < 0 || bottom - top < 2) return null;
  const box = lines.slice(top + 1, bottom);
  const first = box[0], at = first.indexOf("❯");
  if (at < 0 || plain(first.slice(0, at)).trim()) return null;
  const text = box.map(plain);
  text[0] = plain(first.slice(at + 1)).replace(/^\s/, "");
  // up to the first visible character, was SGR 2 (dim) set?
  let dim = false, rest = first.slice(at + 1);
  for (;;) {
    const m = rest.match(/^(?:\s+|\x1b\[([\d;]*)m)/);
    if (!m) break;
    if (m[1] !== undefined) {
      const codes = m[1].split(";");
      if (codes.includes("2")) dim = true;
      else if (codes.includes("0") || m[1] === "" || codes.includes("22")) {
        dim = false;
      }
    }
    rest = rest.slice(m[0].length);
  }
  const empty = text.join("").trim() === "" || (dim && box.length === 1);
  return {
    state: empty ? "empty" : "text",
    lines: text.map((l) => l.trimEnd()),
  };
}

// The contents of the `popAll` records in a stretch of transcript, in order.
export function poppedFrom(appended) {
  const out = [];
  for (const line of appended.split("\n")) {
    if (!line.includes('"queue-operation"')) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      r.type === "queue-operation" && r.operation === "popAll" &&
      typeof r.content === "string"
    ) {
      out.push(r.content);
    }
  }
  return out;
}

// A queued content as it was typed: a large paste is logged inside <pasted_content> tags.
export function unwrap(content) {
  return content.replace(/<pasted_content id="[^"]*">\n?/g, "")
    .replace(/\n?<\/pasted_content id="[^"]*">/g, "");
}

// an image is `[Image #N]` in the queue and IMAGE in what typeInto() was given
const norm = (t) => unpic(unwrap(t)).replace(/\s+/g, " ").trim();

// What goes back into the queue: every popped message but the first equal to `text`,
// unwrapped, and whether one was. Equal ignores how whitespace runs.
export function remaining(popped, text) {
  const i = popped.findIndex((c) => norm(c) === norm(text));
  return { found: i >= 0, rest: popped.filter((_, k) => k !== i).map(unwrap) };
}

async function capture(pane) {
  const r = await run("tmux", "capture-pane", "-p", "-e", "-t", pane);
  return r.code === 0 ? r.out : null;
}

function sizeOf(path) {
  try {
    return Deno.statSync(path).size;
  } catch {
    return -1;
  }
}

function readAfter(path, offset) {
  const f = Deno.openSync(path);
  try {
    f.seekSync(offset, Deno.SeekMode.Start);
    const size = f.statSync().size - offset;
    if (size <= 0) return "";
    const buf = new Uint8Array(size);
    let n = 0;
    while (n < size) {
      const got = f.readSync(buf.subarray(n));
      if (!got) break;
      n += got;
    }
    return new TextDecoder().decode(buf.subarray(0, n));
  } finally {
    f.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The popAll records written after `offset`: polled up to 2s for the first, then until a
// read adds none.
async function waitPopped(path, offset) {
  let popped = [];
  for (let t = 0; t < 2000; t += 50) {
    await sleep(50);
    const now = poppedFrom(readAfter(path, offset));
    if (now.length && now.length === popped.length) return now;
    popped = now;
  }
  return popped;
}

// ctrl+u 4 at a time until the box reads empty: 200 in one call arrive as one chunk,
// which Claude Code takes as a paste. null, or why not.
async function clearBox(pane) {
  for (let i = 0; i < 100; i++) {
    const raw = await capture(pane);
    if (raw === null) return `tmux: cannot capture ${pane}`;
    if (inputBox(raw)?.state === "empty") return null;
    const r = await run(
      "tmux",
      "send-keys",
      "-t",
      pane,
      "C-u",
      "C-u",
      "C-u",
      "C-u",
    );
    if (r.code !== 0) return `tmux: ${r.err.trim() || `exit ${r.code}`}`;
  }
  return "the input box did not empty";
}

// Each text pasted and submitted, one tmux call each, so it queues again behind the turn.
// Two pastes and Enters in one call arrive as one chunk, and the first Enter is lost: "A"
// and "C" queued as "AC". A text with images is typed again with their files, when
// typeInto() typed it; else as text, `[Image #N]` and all. So each waits, up to 1s, for the session to log its `enqueue`
// (or a `user` record, if the turn ended and it went in as a prompt) before the next.
async function retype(pane, texts, path) {
  for (const t of texts) {
    const offset = sizeOf(path);
    const err = await typeAgain(pane, t);
    if (err) return err;
    for (let w = 0; w < 1000; w += 50) {
      await sleep(50);
      const got = offset < 0 ? "" : readAfter(path, offset);
      if (got.includes('"operation":"enqueue"') || got.includes('"type":"user"')) break;
    }
  }
  return null;
}

async function typeAgain(pane, text) {
  const parts = typedImages.get(imageKey([unpic(text)]));
  if (!parts) return await paste(pane, text, true);
  const err = await pasteParts(pane, parts);
  if (err) return err;
  const r = await run("tmux", "send-keys", "-t", pane, "Enter");
  return r.code === 0 ? null : `tmux: ${r.err.trim() || `exit ${r.code}`}`;
}

// A bracketed paste, then Enter when `enter`. null, or why not.
async function paste(pane, text, enter) {
  const buf = `ccx-unqueue-${pane}`;
  const r = await run("tmux", "set-buffer", "-b", buf, "--", text, ";",
    "paste-buffer", "-p", "-d", "-b", buf, "-t", pane, ...(enter ? [";", "send-keys", "-t", pane, "Enter"] : []));
  return r.code === 0 ? null : `tmux: ${r.err.trim() || `exit ${r.code}`}`;
}

const busy = new Map();

// Take `text` out of the instance's queue and leave the rest queued, in order. {kept}, the
// number typed back, or {error}. Without `text`, every queued message goes (the old route).
export async function unqueue(inst, text) {
  if (!inst.pane) {
    return {
      error: `pid ${inst.pid} is not inside tmux; nothing to send keys to`,
    };
  }
  if (text === undefined) return { error: await dropAll(inst), kept: 0 };
  // one at a time per pane: two would pop each other's messages
  const prev = busy.get(inst.pane) ?? Promise.resolve();
  const mine = prev.then(() => takeBack(inst, text));
  const tail = mine.catch(() => {});
  busy.set(inst.pane, tail);
  try {
    return await mine;
  } finally {
    if (busy.get(inst.pane) === tail) busy.delete(inst.pane);
  }
}

async function dropAll(inst) {
  const err = await sendKeys(inst, ["Up"]);
  if (err) return err;
  for (let i = 0; i < 50; i++) {
    const e = await sendKeys(inst, ["C-u", "C-u", "C-u", "C-u"]);
    if (e) return e;
  }
  return null;
}

async function takeBack(inst, text) {
  const { pane } = inst;
  if (!inst.sessionId) {
    return {
      error: `pid ${inst.pid} has no session log to read the queue from`,
    };
  }
  const path = logPath(inst.cwd, inst.sessionId);
  const raw = await capture(pane);
  if (raw === null) return { error: `tmux: cannot capture ${pane}` };
  const refused = dialogRefusal(raw.replace(SGR, ""));
  if (refused) return { error: refused };
  const box = inputBox(raw);
  if (!box) return { error: "no input box on screen" };
  if (box.state !== "empty") {
    return { error: "the input box holds unsent text" };
  }
  const offset = sizeOf(path);
  if (offset < 0) return { error: "no session log to read the queue from" };
  const e1 = await sendKeys(inst, ["Up"]);
  if (e1) return { error: e1 };
  const popped = await waitPopped(path, offset);
  // nothing popped: Up recalled history instead, which clearing undoes
  const e2 = await clearBox(pane);
  if (e2) return { error: e2 };
  if (!popped.length) return { error: "nothing in the queue" };
  const { found, rest } = remaining(popped, text);
  const after = await capture(pane);
  if (after !== null && dialogRefusal(after.replace(SGR, ""))) {
    await paste(pane, rest.join("\n"), false);
    return {
      error:
        "a dialog came up; the other queued messages are in the input box, not sent",
    };
  }
  const e3 = await retype(pane, rest, path);
  if (e3) return { error: e3 };
  return found ? { kept: rest.length } : { error: "not in the queue" };
}
