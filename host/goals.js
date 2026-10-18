// A few words on what each session is for, set when it is spawned (`ccx new --goal`,
// api/spawn {goal}) or later (`ccx goal`, api/s/<pid>/goal). cc draws it as the row's second
// line, in place of Claude's summary. Kept in `~/.claude/ccx-goals.json` (each host its own),
// pid -> goal, so a cchost restart keeps them. Keyed by pid and not by name, since nadya
// reuses names like cc-a for new work. A pid not in the listing for GONE is dropped: a
// session read off the pane can miss a poll, and spawn sets the goal before a poll lists
// the new claude.
// Each listed session's goal is also kept by sessionId in `ccx-goals-sessions.json` for
// SESSION_KEEP, so cc's restore pop-up can say what a closed session was for (closed.js).

import {HOME} from "./sh.js";

const GONE = 10 * 60_000, SESSION_KEEP = 14 * 86400_000;

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
    this.sessionFile = file.replace(/\.json$/, "-sessions.json");
    this.bySession = new Map();  // sessionId -> [goal, ms last seen]
    try {
      this.bySession = new Map(Object.entries(JSON.parse(Deno.readTextFileSync(this.sessionFile))));
    } catch {
      // none yet
    }
  }

  ofSession(id) {
    return this.bySession.get(id)?.[0] ?? "";
  }

  // after each poll, with its instances: their goals by sessionId, saved when one changes
  remember(instances, now = Date.now()) {
    let changed = false;
    for (const i of instances) {
      if (!i.goal || !i.sessionId) continue;
      const was = this.bySession.get(i.sessionId);
      if (was?.[0] === i.goal && now - was[1] < 86400_000) continue;  // its last seen moves once a day
      this.bySession.set(i.sessionId, [i.goal, now]);
      changed = true;
    }
    for (const [id, [, at]] of this.bySession) if (now - at > SESSION_KEEP) { this.bySession.delete(id); changed = true; }
    if (!changed) return;
    try {
      Deno.writeTextFileSync(`${this.sessionFile}.tmp`, JSON.stringify(Object.fromEntries(this.bySession)));
      Deno.renameSync(`${this.sessionFile}.tmp`, this.sessionFile);
    } catch (e) {
      console.error(`goals: ${e.message}`);
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
