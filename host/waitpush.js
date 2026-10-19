// One push to the phone when a session has waited on the user for WAIT (cc-phone.html
// proposal 5, user, 2026-10-19: "all the phone mocks make sense"): a dialog (`asking`) or a
// turn that ended on a question, every host's (the merged list), once per question, before
// away mode answers at 5 min. Only on the host with ~/nadya's push (`./task push`, which
// queues and retries when the phone does not answer); the tap opens the session in cc.
// What was pushed is kept in ~/.claude/ccx-waitpush.json, so a restart does not push again.

import { HOME } from "./sh.js";

export const WAIT = 2 * 60_000;
const TASK = `${HOME}/nadya/task`;
const FILE = `${HOME}/.claude/ccx-waitpush.json`;
const CC = "https://nadya.gum.ts.net/cc/";

const waits = (r) => !!r.asking || (r.state === "wait" && !!r.question);
// a question is a session at one `since`: a new turn, or a new dialog in the same wait, moves it
const keyOf = (r) => `${r.pid} ${r.since}`;

// The rows to push now, and the keys to keep: those still waiting, and those of a host out of
// the list, so its sessions are not pushed again when it is back
export function due({ rows, up }, pushed, now = Date.now()) {
  const live = new Set(
      [...pushed].filter((k) => !up.includes(k.split(".")[0])),
    ),
    push = [];
  for (const r of rows) {
    if (!waits(r)) continue;
    const k = keyOf(r);
    if (pushed.has(k)) live.add(k);
    else if (now - r.since * 1000 >= WAIT) push.push(r);
  }
  return { push, live };
}

export function text(r) {
  const what = (r.question || r.asking).replace(/\s+/g, " ").trim().slice(
    0,
    160,
  );
  return `${r.name || r.pid} waits on you: ${what}`;
}

// A check to run every few seconds over list() ({rows, up}, cchost's merged list), or null on
// a host with no push
export function pusher(list) {
  try {
    Deno.statSync(TASK);
  } catch {
    return null;
  }
  // no file yet: what waits now is taken as pushed, so the first run sends nothing old
  let pushed = null;
  try {
    pushed = new Set(JSON.parse(Deno.readTextFileSync(FILE)));
  } catch {
    // first run
  }
  return async () => {
    const body = list();
    pushed ??= new Set(body.rows.filter(waits).map(keyOf));
    const { push, live } = due(body, pushed);
    for (const r of push) {
      live.add(keyOf(r));
      const out = await new Deno.Command(TASK, {
        args: ["push", text(r), `${CC}#${r.pid}`],
        cwd: `${HOME}/nadya`,
        stdout: "null",
        stderr: "piped",
      }).output();
      if (!out.success) {
        console.error(
          `waitpush: ${new TextDecoder().decode(out.stderr).trim()}`,
        );
      }
    }
    pushed = live;
    Deno.writeTextFileSync(FILE, JSON.stringify([...pushed]));
  };
}
