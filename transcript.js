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
// ends, `end` where readFrom() picks up. A page that holds nothing worth drawing, 256KB of
// attachments, goes on back until it finds something or reaches the top.
export function readPage(path, before = null, size = PAGE) {
  const total = sizeOf(path);
  if (total < 0) return {events: [], start: 0, end: 0};
  let stop = Math.min(before ?? total, total), end = null;
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
    const events = parse(buf.subarray(a, Math.max(a, b)));
    if (events.length || from === 0) return {events, start: from + a, end};
    stop = from + a;
    from = Math.max(0, stop - size);
  }
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
  const results = content.filter((b) => b?.type === "tool_result")
    .map((b) => ({type: "result", at, id: b.tool_use_id ?? "", error: b.is_error === true,
      ...blocksText(b.content)}));
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

function assistantEvents(rec, at) {
  const events = [];
  for (const b of rec.message?.content ?? []) {
    if (b?.type === "text" && b.text?.trim()) events.push({type: "text", at, text: b.text});
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
function blocksText(content) {
  if (typeof content === "string") return {text: clip(content), images: 0};
  if (!Array.isArray(content)) return {text: "", images: 0};
  const text = content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n");
  return {text: clip(text), images: content.filter((b) => b?.type === "image").length};
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

function clip(s) {
  return s.length > CLIP ? `${s.slice(0, CLIP)}…` : s;
}
