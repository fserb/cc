# Projects page: handover (cc-c, Oct 18th)

## What's live
- bc49d74: cc's projects page, built from the round-3 mocks. The plan tab is merged into it, and the sidebar's
  plan row is gone (its due dot and line are on the projects row). `#projects` is the index; `#project/<id>` is a
  project page. Old `#plan`, `#idea/x.md` and `#project/x.md` links still open the right page.
  - Index: up to six cards (projects being worked on with a picture post in the last 3 days), then one list by
    last post (dot, name, last post, posts a day for 14 days, age), filters (all, working, ideas, done), search,
    and a "N todos need a project" link with ok / change on each.
  - Project page: tabs overview, todo, history, posts, files, docs; arcade has a part filter (ps2, ps3, switch).
  - Code: `web/index.html`, the block after `// ---------- projects` (loadPosts, loadPlan, pjModel, projectsView,
    projectView, pjDocs...), CSS after `/* projects`, click handlers before `// phone: opening an item`.
  - `web/api/lemon.js`: `GET files?dir=` (the 40 files changed last, names only) and `GET log?dir=` (the last 60
    commits), for dirs on nadya only (`~/ai`, `~/web`, `~/srv`, `~/nadya`).
- How things attach (also in ~/ai/cc/CLAUDE.md, "Projects"; that file is gitignored, so the section is local):
  - Projects: `<x>-<part>.md`, two or more files, become one project with parts. nadya is a project too.
  - Posts: by `data-project`, else by `data-dir`, else nadya.
  - Todos: read from todo.md, reminders.md, plan.md, hard-queue.md (### items) and free-cycles.md. A todo
    starting with a project name is on that project; otherwise it is a guess (a project named in its first 60
    characters, else nadya).
  - Ok / change, the done checkbox and "add a todo" type a message to nadya (format told to nadya).
- Mocks, all committed: `projects-{a..f}.html`, `project-{a,b,c,d,f}.html`. Their builder lives in /tmp/ccmock
  (`build.js`, `extract.js`, `extra.js`, `lib.js`, `base.css`, `tpl/`). It is not committed and is lost on reboot.

## The user's decisions, in their words
- The ask (Oct 18th, 13:5x): "a way to access all files / history / posts of a project together; reorganize
  ideas/projects; group projects/plan together; every todo is attached to a project (or nady itself); including
  done project and project ideas; fuzzy search projects; clicking on a project/idea go to the project page;
  project page: related files, todo, blog posts, docs / mocks / etc".
- Round 1 (A by state, B by when, C by activity): "for index: more like the C direction (but needs more work);
  for the project, more like B."
- Round 2 (D, E, project-d): "read the two design skills before continuing please. D is way too chaotic, still
  would like C better. I can get behind some image cards, but it has be less busy than that, maybe top 3-6 and
  then the full list below? For the project page, it's fine. But again, it has to be less busy."
  The skills are ~/ai/skills apple-design and emil-design-eng; nadya relayed frontend-design too. All three are
  noted in my memory.
- Round 3 (F): "yeah, let's do this version." That is what got built.

## Open / next
- Done in 6441dc6: history = posts + commits (user: "history/posts are supposed to be the same thing"); the files tab
  is gone; docs = notes, their links, and the docs found in the project's dir on nadya (web/api `docs`, `doc`).
- Done in 7a66867: no Next on the overview (user: the todo tab has it); marx's dirs read by the api box over
  `ssh marx` (user: "fair to allow the server to ssh marx to list/fetch files only").
- Not built: the "out of date" flags shown in the mocks (they were hand-made); cc and ccx stay two projects;
  `~/nadya` files that only mention a project are not listed (the docs tab has the notes' own links).
- Peers: cc-d is doing sidebar mocks (`mocks/sidebar-rich-*.html`) with fixed rows nadya, blog, projects, and will
  ask before editing index.html.
