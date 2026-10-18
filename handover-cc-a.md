# cc-a handover: cc web design talk (2026-10-18)

The user's ask (Oct 17th): "spawn a new agent to discuss cc web design with me". Rules from nadya's brief:
talk first, change no code until the user says to build; mocks only when asked (web/mocks/); after page
changes `cd ~/nadya && ./task ccreload`; commit only my own hunks (other agents work in web/index.html:
cc-c did the click fixes; never `git commit -a`); tell peers before restarting cchost.

## The user's requirements list (their own, Oct 18th)

- a way to reach all files / history / posts of a project together
- a better blog: more images/videos per post when available
- reorganize ideas/projects
- the list bar in 3 sections: fixed (nadya, blog); temporary/notifications (Uber Eats, package
  tracking, every new mock/research, things agents build on the fly like nightly or dream); open sessions
- a place for less-used things: files, reopening closed sessions, new session, running extra tasks

Today's topic was only the last item. It is built (below). The user said to hold back on the
"now" part (the list bar's bigger changes) for implementation.

## What was decided and built

Mocks: web/mocks/more.html (rounds A-J dropped; the final is option K). The user liked the
+ and restore pop-ups most; tasks and files were reworked to "a short list + a button to the page".

Built (commits 342a5a0, 6152213, 8a4e8a7, 49db437; details in CLAUDE.md "The tools"):
- desktop header in 3 parts: tools over the list (new, tasks, files, restore at the far right),
  the title over the page, the quota. Phone: same buttons spread across the top of the list,
  same order; the page behind a pop-up is dimmed
- each tool is a pop-up, not a page:
  - new: host:dir with hints, recent-dir chips, goal, focus (desktop)
  - tasks: ~/nadya/tasks.md (`- <name>: <message>`), a click types `[cc task] <message>` into
    nadya; `<...>` asked for in the pop-up first; the 7 sent last first; "all tasks" opens the file
  - files: 10 recent files of ~/nadya (web/api `GET api/recent`) + "all files"
  - restore: cchost `api/closed?all=1` (closed.js), a row click is the restore
    (`api/spawn {resume}` = `claude -n name --resume id`, tested); second line goal, else first prompt
- the bottom + of the list, the files row and the new-session page are gone
- goals are kept by sessionId (~/.claude/ccx-goals-sessions.json) so closed sessions show them

User preferences learned in this talk: no buttons that are a row's only action (the row is the
action); pop-up titles name the action ("restore session"); no decorative glyph columns.

## Open

- the "now" section and the rest of the user's list (projects view, blog media, ideas/projects)
- not done: a count on the restore button; whether "tasks"/"files" titles become "run task"/"open file"
- nadya was asked to commit ~/nadya/tasks.md and check its wording ("loop" = "Do a loop.")
- when the talk ends: SendMessage nadya "cc-a done: <decisions, what was built, commits>"
