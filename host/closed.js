// The sessions that ended in the last week, newest first, for cc's restore pop-up: every
// transcript in ~/.claude/projects whose session no live process holds. `claude -n <name>
// --resume <sessionId>` in its cwd brings one back with its conversation (spawn.js).
// A transcript whose name and cwd a live session has is left out: that is the same claude
// after a /clear (nadya clears often), and a spawn by that name would find the live one.

import { HOME } from "./sh.js";
import { sessionRecords } from "./claudes.js";
import { readRange } from "./transcript.js";

const PROJECTS = `${HOME}/.claude/projects`;
const HEAD = 64 * 1024, TAIL = 256 * 1024;
const seen = new Map(); // path -> {mtime, size, info}, so a call reads only what changed

// {name, title, prompt, cwd} or null: a -p/SDK run, or one that never answered
function readInfo(path, size) {
  const dec = new TextDecoder();
  const head = dec.decode(readRange(path, 0, Math.min(size, HEAD)));
  const tail = size > HEAD
    ? dec.decode(readRange(path, Math.max(HEAD, size - TAIL), size))
    : "";
  let cwd = "",
    entry = "",
    name = "",
    title = "",
    prompt = "",
    answered = false;
  for (const line of `${head}\n${tail}`.split("\n")) {
    if (!cwd || !entry) {
      cwd ||= line.match(/"cwd":"((?:[^"\\]|\\.)*)"/)?.[1] ?? "";
      entry ||= line.match(/"entrypoint":"([^"]*)"/)?.[1] ?? "";
    }
    if (line.includes('"type":"assistant"')) answered = true;
    // the first prompt, for a session with no goal kept: its first line that is not markup
    if (
      !prompt && line.includes('"type":"user"') &&
      !line.includes('"isMeta":true')
    ) {
      try {
        const c = JSON.parse(line).message?.content;
        const text = typeof c === "string"
          ? c
          : c?.find?.((b) => b.type === "text")?.text ?? "";
        // a helper's opening "You are cc-a, a helper started by nadya in ..." says only its name and dir
        prompt = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("<")).join(" ")
          .replace(/^You are (?:[^.(]|\([^)]*\))*\.\s*/, "").slice(0, 160);
      } catch {
        // a fragment
      }
    }
    if (
      !line.includes('"type":"custom-title"') &&
      !line.includes('"type":"ai-title"')
    ) continue;
    try {
      const r = JSON.parse(line);
      if (r.type === "custom-title") name = r.customTitle ?? name;
      else title = r.aiTitle ?? title;
    } catch {
      continue; // the tail's first line is a fragment
    }
  }
  if (!answered || !cwd || entry === "sdk-cli") return null;
  return { name, title, prompt, cwd: JSON.parse(`"${cwd}"`) };
}

export function closedSessions({ days = 7, max = 40, goalOf = () => "" } = {}) {
  const since = Date.now() - days * 86400e3;
  const live = Object.values(sessionRecords());
  const ids = new Set(live.map((r) => r.sessionId));
  const named = new Set(
    live.filter((r) => r.name).map((r) => `${r.name}\0${r.cwd}`),
  );
  const out = [];
  let dirs;
  try {
    dirs = [...Deno.readDirSync(PROJECTS)].filter((d) => d.isDirectory);
  } catch {
    return out;
  }
  for (const d of dirs) {
    for (const f of Deno.readDirSync(`${PROJECTS}/${d.name}`)) {
      if (!f.isFile || !f.name.endsWith(".jsonl")) continue;
      const sessionId = f.name.slice(0, -6),
        path = `${PROJECTS}/${d.name}/${f.name}`;
      if (ids.has(sessionId)) continue;
      let st;
      try {
        st = Deno.statSync(path);
      } catch {
        continue;
      }
      const mtime = st.mtime?.getTime() ?? 0;
      if (mtime < since) continue;
      let c = seen.get(path);
      if (!c || c.mtime !== mtime || c.size !== st.size) {
        seen.set(
          path,
          c = { mtime, size: st.size, info: readInfo(path, st.size) },
        );
      }
      if (!c.info || named.has(`${c.info.name}\0${c.info.cwd}`)) continue;
      out.push({ sessionId, ...c.info, goal: goalOf(sessionId), at: mtime });
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, max);
}
