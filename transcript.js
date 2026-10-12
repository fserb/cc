// One session's conversation, read out of its log for a page to draw. No UI here:
// readPage() reads back from an offset, readFrom() follows what was appended since.
//
// Undocumented internals, surveyed over 60 logs on 2.1.284. A missing field falls back; a
// changed meaning would not be caught.
//
// - your prompt is a `user` record with string content and `origin.kind` "human", or no
//   origin at all, which is what a slash command and its output are written with. Typed
//   while a turn runs, it is instead a `queued_command` attachment, `commandMode:
//   "prompt"`, and never also a `user` record: 0 of 411
// - a peer message is a `user` record with `origin.kind === "peer"`, or a `queued_command`
//   attachment carrying the same origin when it lands mid-turn. 315 of 2415 queued ones
//   are on disk both ways, so a peer event carries `origin.msg_id` as its `id` and a
//   reader drops a repeat
// - a tool_result's content is a string, or an array of text and image blocks
// - `[Request interrupted by user]` is a `user` record of text blocks with no origin
// - a log is one content block per line, so a reply arrives block by block

import {HOME, UTF8} from "./sh.js";
import {slug} from "./claudes.js";

const CLAUDE = `${HOME}/.claude`;

export const PAGE = 256 * 1024;

// Past this much appended since the last read, readFrom() starts over at the tail: a phone
// that slept through an hour of tool output wants the end, not 40MB of what led to it.
export const CATCHUP = 2 * 1024 * 1024;

// What a tool's input and result are cut to. A Write's input is the whole file and a
// Read's result is the file again, and the page shows only the first lines of either.
const CLIP = 4000;

export function logPath(cwd, sessionId, root = CLAUDE) {
  return `${root}/projects/${slug(cwd)}/${sessionId}.jsonl`;
}

function sizeOf(path) {
  try {
    return Deno.statSync(path).size;
  } catch {
    return -1;
  }
}

function readRange(path, from, to) {
  const buf = new Uint8Array(Math.max(0, to - from));
  let f;
  try {
    f = Deno.openSync(path, {read: true});
  } catch {
    return buf.subarray(0, 0);
  }
  try {
    f.seekSync(from, Deno.SeekMode.Start);
    let got = 0;
    while (got < buf.length) {
      const n = f.readSync(buf.subarray(got));
      if (n === null || n === 0) break;
      got += n;
    }
    return buf.subarray(0, got);
  } finally {
    f.close();
  }
}

// The events in the `size` bytes before `before`, or before the end of the log when it is
// null. Only whole lines: the partial first one is left to the next page back, and with no
// `before` the unfinished last one to readFrom(). `start` is where the next page back
// ends, `end` where readFrom() picks up. A window goes on back until it holds `want` chat
// messages (yours, its text, a peer's), the top or `budget` bytes. Tool calls and results
// between them come along but do not count: launcher-a's last 40 events were 75 tools
// and 3 texts, so a count of events left the page with almost no conversation. A page's
// tool input and result text are cut to PAGE_CLIP, so a tool-heavy page stays small;
// readFrom() keeps CLIP. The budget is 16MB: 4MB of launcher-a's log held 9 chat messages.
export const WANT = 40, BUDGET = 16 * 1024 * 1024, PAGE_CLIP = 600;
const CHAT = new Set(["user", "text", "peer"]);

export function readPage(path, before = null, size = PAGE, want = WANT, budget = BUDGET) {
  const total = sizeOf(path);
  if (total < 0) return {events: [], start: 0, end: 0};
  let stop = Math.min(before ?? total, total), end = null, events = [], chat = 0;
  const limit = stop - budget;
  for (let from = Math.max(0, stop - size); ;) {
    const buf = readRange(path, from, stop);
    const a = from === 0 ? 0 : buf.indexOf(10) + 1;
    const b = before === null && end === null ? buf.lastIndexOf(10) + 1 : buf.length;
    // one line longer than the window: widen it until a line starts inside
    if (from > 0 && b <= a) {
      from = Math.max(0, from - size);
      continue;
    }
    end ??= from + Math.max(a, b);
    const got = parse(buf.subarray(a, Math.max(a, b))).map(short);
    chat += got.filter((e) => CHAT.has(e.type)).length;
    events = [...got, ...events];
    if (chat >= want || from === 0 || from <= limit) {
      return {events, start: from + a, end};
    }
    stop = from + a;
    from = Math.max(0, stop - size);
  }
}

function short(e) {
  if (e.type === "tool") return {...e, input: clip(e.input, PAGE_CLIP)};
  if (e.type === "result" && !e.ask) return {...e, text: clip(e.text, PAGE_CLIP)};
  return e;
}

// What was appended after `offset`, up to the last newline. A log that shrank was
// replaced, and one that grew by more than CATCHUP is too far behind to replay: both come
// back as the tail with `reset`, for the reader to draw from scratch.
export function readFrom(path, offset) {
  const total = sizeOf(path);
  if (total < 0) return {events: [], end: offset};
  if (total < offset || total - offset > CATCHUP) return {...readPage(path), reset: true};
  if (total === offset) return {events: [], end: offset};
  const buf = readRange(path, offset, total);
  const b = buf.lastIndexOf(10) + 1;
  return {events: parse(buf.subarray(0, b)), end: offset + b};
}

export function parse(bytes) {
  const events = [], peers = new Set();
  for (const line of UTF8.decode(bytes).split("\n")) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;           // one unreadable line, not the end of the log
    }
    for (const e of eventsOf(rec)) {
      if (e.type === "peer" && e.id) {
        if (peers.has(e.id)) continue;
        peers.add(e.id);
      }
      events.push(e);
    }
  }
  return events;
}

function eventsOf(rec) {
  if (rec.isSidechain) return [];
  const when = Date.parse(rec.timestamp ?? "");
  const at = Number.isFinite(when) ? when / 1000 : 0;
  switch (rec.type) {
    case "user": return userEvents(rec, at);
    case "assistant": return assistantEvents(rec, at);
    case "attachment": return queuedEvents(rec.attachment ?? {}, at);
    case "system": return systemEvents(rec, at);
  }
  return [];
}

function peerEvent(origin, at) {
  return {type: "peer", at, id: origin.msg_id ?? "", from: origin.name || origin.from || "?",
    text: origin.body ?? ""};
}

function userEvents(rec, at) {
  const origin = rec.origin ?? {};
  if (origin.kind === "peer") return [peerEvent(origin, at)];
  if (rec.isMeta || rec.isCompactSummary) return [];
  if (origin.kind && origin.kind !== "human") return [];
  const content = rec.message?.content;
  if (typeof content === "string") return stringEvents(content, at);
  if (!Array.isArray(content)) return [];
  // An AskUserQuestion result is the questions and the answers picked, which a page shows
  // as what you said: kept whole, not cut like other results
  const ask = rec.toolUseResult?.answers !== undefined;
  const results = content.filter((b) => b?.type === "tool_result")
    .map((b) => ({type: "result", at, id: b.tool_use_id ?? "", error: b.is_error === true,
      ...blocksText(b.content, ask ? Infinity : CLIP), ...(ask && {ask})}));
  if (results.length) return results;
  const {text, images} = blocksText(content);
  if (text.startsWith("[Request interrupted")) return [{type: "note", at, text}];
  return text || images ? [{type: "user", at, text, images}] : [];
}

// A slash command and the shell escape are written as tags in the content. Anything else
// starting with `<` is a prompt that happens to.
const TAG = (name, s) => s.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];

function stringEvents(s, at) {
  const command = TAG("command-name", s);
  if (command !== undefined) {
    const args = TAG("command-args", s)?.trim();
    return [{type: "command", at, text: args ? `${command} ${args}` : command}];
  }
  const bash = TAG("bash-input", s);
  if (bash !== undefined) return [{type: "command", at, text: `! ${bash}`}];
  const out = TAG("local-command-stdout", s) ??
    [TAG("bash-stdout", s), TAG("bash-stderr", s)].filter(Boolean).join("\n");
  if (s.startsWith("<local-command-stdout>") || s.startsWith("<bash-std")) {
    return out && out !== "(no content)" ? [{type: "output", at, text: clip(out)}] : [];
  }
  return s ? [{type: "user", at, text: s, images: 0}] : [];
}

// A thinking block with text in it is drawn in the terminal as a reply, a `●` line like
// any text block (seen on 2.1.296, claude-opus-5-5, on cc-a's pane). The reasoning itself
// is the empty signed block written before it, which stays out.
function assistantEvents(rec, at) {
  const events = [];
  for (const b of rec.message?.content ?? []) {
    if (b?.type === "text" && b.text?.trim()) events.push({type: "text", at, text: b.text});
    if (b?.type === "thinking" && b.thinking?.trim()) {
      events.push({type: "text", at, text: b.thinking.trim()});
    }
    if (b?.type === "tool_use") {
      events.push({type: "tool", at, id: b.id ?? "", name: b.name ?? "?",
        arg: argOf(b.input ?? {}), input: clip(JSON.stringify(b.input ?? {}, null, 2))});
    }
  }
  return events;
}

function queuedEvents(att, at) {
  if (att.type !== "queued_command") return [];
  if (att.origin?.kind === "peer") return [peerEvent(att.origin, at)];
  if (att.commandMode !== "prompt" || att.origin?.kind !== "human") return [];
  const {text, images} = typeof att.prompt === "string"
    ? {text: att.prompt, images: 0} : blocksText(att.prompt);
  return [{type: "user", at, text, images}];
}

function systemEvents(rec, at) {
  if (rec.subtype === "compact_boundary") return [{type: "note", at, text: "conversation compacted"}];
  if (rec.subtype !== "local_command") return [];
  const out = TAG("local-command-stdout", rec.content ?? "");
  return out && out !== "(no content)" ? [{type: "output", at, text: clip(out)}] : [];
}

// Text and image blocks, or a bare string, as text plus how many images were in it.
function blocksText(content, n = CLIP) {
  if (typeof content === "string") return {text: clip(content, n), images: 0};
  if (!Array.isArray(content)) return {text: "", images: 0};
  const text = content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n");
  return {text: clip(text, n), images: content.filter((b) => b?.type === "image").length};
}

// The one argument that says what a tool call did, on one line.
const ARGS = ["command", "file_path", "path", "pattern", "url", "query", "to", "description",
  "prompt", "skill"];

function argOf(input) {
  const key = ARGS.find((k) => typeof input[k] === "string") ??
    Object.keys(input).find((k) => typeof input[k] === "string");
  const s = key ? input[key] : "";
  const line = s.split("\n")[0];
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function clip(s, n = CLIP) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
