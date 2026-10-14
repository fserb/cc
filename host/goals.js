// A few words on what each session is for, set when it is spawned (`ccx new --goal`,
// api/spawn {goal}) or later (`ccx goal`, api/s/<pid>/goal). cc draws it as the row's second
// line, in place of Claude's summary. Kept in `~/.claude/ccx-goals.json` (each host its own),
// pid -> goal, so a cchost restart keeps them. Keyed by pid and not by name, since nadya
// reuses names like cc-a for new work. A pid not in the listing for GONE is dropped: a
// session read off the pane can miss a poll, and spawn sets the goal before a poll lists
// the new claude.

import {HOME} from "./sh.js";

const GONE = 10 * 60_000;

export class Goals {
  constructor(file = `${HOME}/.claude/ccx-goals.json`) {
    this.file = file;
    this.goals = new Map();     // pid -> goal
    this.seen = new Map();      // pid -> ms it was last listed; memory only
    try {
      for (const [pid, goal] of Object.entries(JSON.parse(Deno.readTextFileSync(file)))) {
        this.goals.set(Number(pid), String(goal));
        this.seen.set(Number(pid), Date.now());
      }
    } catch {
      // none yet
    }
  }

  get(pid) {
    return this.goals.get(pid) ?? "";
  }

  // an empty goal clears it
  set(pid, goal) {
    goal = goal.replace(/\s+/g, " ").trim();
    if (goal) this.goals.set(pid, goal);
    else this.goals.delete(pid);
    this.seen.set(pid, Date.now());
    this.save();
  }

  // after each poll, with the pids it listed
  prune(pids, now = Date.now()) {
    for (const pid of pids) this.seen.set(pid, now);
    let dropped = false;
    for (const pid of this.goals.keys()) {
      if (now - (this.seen.get(pid) ?? 0) < GONE) continue;
      this.goals.delete(pid);
      this.seen.delete(pid);
      dropped = true;
    }
    if (dropped) this.save();
  }

  save() {
    try {
      const tmp = `${this.file}.tmp`;
      Deno.writeTextFileSync(tmp, JSON.stringify(Object.fromEntries(this.goals)));
      Deno.renameSync(tmp, this.file);
    } catch (e) {
      console.error(`goals: ${e.message}`);
    }
  }
}
