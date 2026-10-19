// Away mode (user, 2026-10-19: "auto answer questions ... when I'm offline, so work doesn't
// get stuck on me"). While it is on, a session's question box (the AskUserQuestion dialog,
// never a permission, trust, plan or any other dialog) that has waited DELAY with nothing in
// cc's box for it is answered with ANSWER, and the answer is written down for cc to list.
//
// - the question tool is told apart by its `Chat about this` option, which no other dialog
//   has (fixtures/dialog), and its review page by `Review your answers` over `Submit answers`
// - a single-select question with a free-text field gets ANSWER typed there: the agent picks
//   its recommended option, says which and why, and goes on (tried on 2.1.303, 2026-10-19)
// - a multi-select or a preview layout has no field that takes a sentence and an Enter, so
//   it gets `Chat about this` and then AFTER_CHAT typed as a prompt once the session is idle.
//   `Chat about this` alone ("talk about it") left the agent asking in text what to clarify,
//   still waiting on the user (same test), which is why it is never the whole answer
// - several questions are tabs: each is answered as it comes up, then the review is submitted,
//   one step per check; once one step is taken, the next does not wait DELAY again
// - each host answers its own sessions; the setting and the log are per host, in
//   `~/.claude/ccx-away.json` and `~/.claude/ccx-away.jsonl` (KEEP days)

import {HOME} from "./sh.js";
import {parseDialog, pendingAsk, pick, screen, withAsk} from "./dialog.js";
import {typeInto} from "./jump.js";
import {logPath, readFrom, sizeOf} from "./transcript.js";

export const DELAY = 5 * 60_000;
const STEP = 90_000;            // a later tab or the review, this soon after the last step
const TYPE_BY = 120_000;        // a prompt left after `Chat about this` is dropped this late
const KEEP = 14 * 86400_000;

const RULES = "Pick the option you'd recommend, note the pick and why in your reply, and continue. " +
  "If the choice can't be undone (spending, sending, deleting, changing other repos), don't pick: " +
  "stop and leave the question for the user.";
export const ANSWER = `The user is away (auto-answer). ${RULES}`;
export const AFTER_CHAT = (q) =>
  `[auto-answer] Your question${q ? ` ("${q}")` : ""} went unanswered: the user is away. ${RULES}`;

// What to do with a dialog: {how: "free"|"chat"|"submit", i}, or null when it is not the
// question tool's
export function plan(dialog) {
  if (!dialog) return null;
  const at = (label) => dialog.options.findIndex((o) => o.label === label);
  if (/^Review your answers/.test(dialog.title) && at("Submit answers") >= 0) return {how: "submit", i: at("Submit answers")};
  const chat = at("Chat about this");
  if (chat < 0) return null;
  const multi = dialog.options.some((o) => o.checked !== null);
  const free = dialog.options.findIndex((o) => o.free);
  if (!multi && free >= 0 && dialog.options[free].n !== null) return {how: "free", i: free};
  return {how: "chat", i: chat};
}

export class Away {
  constructor({file = `${HOME}/.claude/ccx-away.json`, log = `${HOME}/.claude/ccx-away.jsonl`,
    delay = DELAY} = {}) {
    Object.assign(this, {file, log, delay});
    this.on = false;
    this.since = 0;
    try {
      ({on: this.on = false, since: this.since = 0} = JSON.parse(Deno.readTextFileSync(file)));
    } catch {
      // off
    }
    this.list = [];             // {at, pid, name, cwd, sessionId, question, options, how, text, end}
    try {
      for (const line of Deno.readTextFileSync(log).split("\n")) {
        try {
          if (line) this.list.push(JSON.parse(line));
        } catch {
          // a torn line
        }
      }
    } catch {
      // none yet
    }
    this.list = this.list.filter((a) => a.at > Date.now() - KEEP);
    this.steps = new Map();     // pid -> ms of the last step taken
    this.typing = new Map();    // pid -> {text, at}: a prompt to type once the chat closed the box
    this.busy = false;
  }

  set(on) {
    if (Boolean(on) === this.on) return this.state();
    this.on = Boolean(on);
    this.since = Date.now();
    Deno.writeTextFileSync(this.file, JSON.stringify({on: this.on, since: this.since}));
    return this.state();
  }

  state() {
    return {on: this.on, since: this.since, delay: this.delay};
  }

  // the answers of the last KEEP days, newest first, each with the agent's first reply after it
  answered() {
    return this.list.map((a) => ({...a, reply: a.reply ?? replyAfter(a)})).reverse();
  }

  // one look at every session; `draftOf(pid)` is the text in cc's box for it
  async check(instances, draftOf = () => "") {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = Date.now();
      for (const inst of instances) {
        if (!inst.pane) continue;
        const t = this.typing.get(inst.pid);
        if (t && now - t.at > TYPE_BY) this.typing.delete(inst.pid);
        else if (t && (inst.state === "wait" || inst.state === "free") && !inst.asking) {
          this.typing.delete(inst.pid);
          const err = await typeInto(inst, t.text);
          if (err) console.error(`away: ${inst.name || inst.pid}: ${err}`);
          continue;
        }
        if (!this.on || inst.state !== "wait" || !inst.asking || draftOf(inst.pid)) continue;
        const stepped = now - (this.steps.get(inst.pid) ?? 0) < STEP;
        if (!stepped && now - inst.since * 1000 < this.delay) continue;
        await this.answer(inst, now);
      }
    } finally {
      this.busy = false;
    }
  }

  async answer(inst, now) {
    const text = await screen(inst.pane);
    if (text === null) return;
    const dialog = parseDialog(text);
    const p = plan(dialog);
    if (!p) return;
    const log = inst.sessionId ? logPath(inst.cwd, inst.sessionId) : "";
    const asked = withAsk(dialog, pendingAsk(inst.sessionId, log))?.ask;
    const labels = dialog.options.map((o) => o.label);
    const question = asked?.question || dialog.title || dialog.body.split("\n")[0] || "";
    const end = log ? sizeOf(log) : -1;
    const err = await pick(inst, p.i, labels, p.how === "free" ? ANSWER : undefined);
    this.steps.set(inst.pid, now);
    if (err) {
      console.error(`away: ${inst.name || inst.pid}: ${err}`);
      return;
    }
    if (p.how === "chat") this.typing.set(inst.pid, {text: AFTER_CHAT(question), at: now});
    if (p.how === "submit") return;
    const options = asked ? asked.options.map((o) => o.label)
      : dialog.options.filter((o) => !o.free && o.label !== "Chat about this" && o.n !== null).map((o) => o.label);
    const a = {at: now, pid: inst.pid, name: inst.name ?? "", cwd: inst.cwd ?? "", sessionId: inst.sessionId ?? "",
      question, options, how: p.how, text: p.how === "free" ? ANSWER : AFTER_CHAT(question), end};
    this.list.push(a);
    console.log(`away: answered ${inst.name || inst.pid} (${p.how}): ${question}`);
    try {
      Deno.writeTextFileSync(this.log, `${JSON.stringify(a)}\n`, {append: true});
    } catch (e) {
      console.error(`away: ${e.message}`);
    }
  }
}

// The agent's first text after the answer, read from where the log ended when it was sent,
// up to the user's next own prompt. After an `[auto-answer]` prompt (a `Chat about this` in
// this or a later tab declines the whole box), the first text after it. Kept once found
function replyAfter(a) {
  if (!a.sessionId || a.end < 0) return "";
  let {events} = readFrom(logPath(a.cwd, a.sessionId), a.end);
  const auto = (e) => e.type === "user" && e.text?.startsWith("[auto-answer]");
  const next = events.findIndex((e) => e.type === "user" && !auto(e));
  if (next >= 0) events = events.slice(0, next);
  const typed = events.findLastIndex(auto);
  if (a.how === "chat" && typed < 0) return "";
  const t = events.slice(typed + 1).find((e) => e.type === "text" && e.text?.trim());
  if (!t) return "";
  // still mid-turn: the text may be one of several, so it is read again next time
  if (events.at(-1) !== t || typed >= 0 || next >= 0) a.reply = t.text;
  return t.text;
}
