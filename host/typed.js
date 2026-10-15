// Who typed a prompt, when it was not the user. A prompt typed by `ccx user` (the watchdog,
// nadya giving a helper its task, project-start) is on disk exactly like one typed at the
// keyboard: `origin.kind` "human", `promptSource` "typed" (2.1.296, every human prompt in
// 80 nadya logs). So cchost writes down what api/s/<pid>/type typed with a `by`, and the
// session's log events take it back: a `user` event of that pid whose text holds it, from
// a little before to a minute after. Kept in `~/.claude/ccx-typed.jsonl` (each host its
// own, the one that typed), so a restart keeps it, trimmed to KEEP days.

import {HOME} from "./sh.js";

const KEEP = 14 * 86400_000, SKEW = 10_000, LATE = 60_000;
// an image is a 🖼 in what was typed and [Image #N] in the log
const norm = (t) => t.replace(/<\/?pasted_content(?: id="[^"]*")?>/g, "")
  .replace(/\[Image #\d+\]/g, "\u{1F5BC}").replace(/\s+/g, " ").trim();

export class Typed {
  constructor(file = `${HOME}/.claude/ccx-typed.jsonl`) {
    this.file = file;
    this.list = [];             // {pid, at, by, text}, at in ms, text normalized
    try {
      for (const line of Deno.readTextFileSync(file).split("\n")) {
        try {
          if (line) this.list.push(JSON.parse(line));
        } catch {
          // a torn line
        }
      }
    } catch {
      // none yet
    }
    this.trim();
  }

  // the record, or null for an empty text
  add(pid, by, text, at = Date.now()) {
    const t = {pid, at, by, text: norm(text)};
    if (!t.text) return null;
    this.list.push(t);
    if (this.trim()) return t;
    try {
      Deno.writeTextFileSync(this.file, `${JSON.stringify(t)}\n`, {append: true});
    } catch {
      // the prompt shows as the user's after a restart
    }
    return t;
  }

  // one add() whose typing failed
  drop(t) {
    this.list = this.list.filter((x) => x !== t);
    this.save();
  }

  // drops the old ones and rewrites the file when it did
  trim() {
    const n = this.list.length;
    this.list = this.list.filter((t) => t.at > Date.now() - KEEP);
    if (this.list.length === n) return false;
    this.save();
    return true;
  }

  save() {
    try {
      Deno.writeTextFileSync(this.file, this.list.map((t) => `${JSON.stringify(t)}\n`).join(""));
    } catch {
      // kept in memory
    }
  }

  // `events` of pid's log, each `user` one typed for someone given `by`; a typed prompt
  // tags one event per call. A copy, so a cached page is not changed.
  tag(pid, events) {
    const mine = this.list.filter((t) => t.pid === pid);
    if (!mine.length) return events;
    const used = new Set();
    return events.map((e) => {
      if (e.type !== "user") return e;
      const text = norm(e.text ?? ""), at = e.at * 1000;
      const t = mine.find((t) => !used.has(t) && at > t.at - SKEW && at < t.at + LATE &&
        text.includes(t.text));
      if (!t) return e;
      used.add(t);
      return {...e, by: t.by};
    });
  }
}
