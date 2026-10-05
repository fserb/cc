# ccx serve: remote control over HTTP

A web server inside ccx that lists every running Claude Code instance, shows each one's
conversation, lets you type into it, answer its dialogs, interrupt it, and start new
ones. Built for a phone on the tailnet. Runs inside `ccx systray`, in the same process, or
alone as `ccx serve`.

Status: design, nothing built. Open questions are at the end. Checked against the code on
2026-10-04; the bundle question is settled (see Shape).
Mocks, fake data, clickable: https://marx.giraffe-yo.ts.net/tmp/ccx/
(`~/web/tmp/ccx/index.html`).

## What it does

- **list**: the instances the TUI and the panel draw, same states (`wait`, `busy`,
  `hold`, `free`, `◆` for a dialog), grouped by kitty window, in tmux order
- **history**: one instance's transcript, newest at the bottom, older pages on scroll up
- **screen**: the pane as it is now, from `tmux capture-pane`. This is the only place a
  permission dialog, a streaming reply or a `/command` menu is visible, since none of
  them are in the transcript
- **type**: text into the prompt as its user, `typeInto()`, so `/clear` and other
  commands work. Needs tmux
- **dialogs**: when one is up, its options are buttons; tapping one picks it. No raw
  arrow or digit keys
- **esc**: interrupt a turn, or dismiss a dialog
- **spawn beside**: a new claude in a new tmux window, in the same kitty window as an
  instance or a group
- **spawn new**: a new kitty window, so a new tmux session, and a new claude in a
  directory you name

An instance outside tmux is read-only: history yes, everything else no. Out of scope for
the first version: attaching files or images, the bell (the systray owns it).

## Shape

    server.js        Deno.serve, the routes, the poll, and the page as one string
    transcript.js    reads one session log into display events, tail first, paged back
    dialog.js        parses the dialog out of a pane capture, and picks an option
    spawn.js         starts a claude in a new tmux window or session

`Instance` gains `sessionId` and `cwd` from the record. `path` is the pane's
`pane_current_path`, which follows a `cd` in the shell, so it cannot name the log. Both are
empty with no record, and then there is no history.

`server.js` exports `runServer({port, poll})`. `poll` is a function returning the current
instance list; inside the systray it is the systray's own poll result, so there is one
`discover()` per 1.5s and not two. Alone, `ccx serve` runs its own `discover()` +
`StateClock` loop, the same thing the TUI does.

`ccx serve [--port N]` in `ccx`, routed like `list` and `doctor`, never through the bundle.
`ccx systray` always starts the server, in the systray's own process: one poll, one
process. A port already bound (a second copy, or `ccx serve` beside the systray) is
reported in `doctor` and the systray carries on without it.

**Inside the bundle, the first `Deno.serve` loses its port.** Measured on deno 2.9.7 with
two throwaway bundles: the first `Deno.serve({port: 7698})` listened on a random port
(50372, 50718), because the runtime points its startup window at that server. A second
`Deno.serve({port: 7699})` in the same bundle bound 7699 and answered. `systray.js` already
makes the first call, for its panel, so `runServer()` has to start after it. Started
first, it would bind a random port with no error, and caddy would proxy to nothing.

## Reaching it from the phone

The server binds **127.0.0.1 only**, default port 7681. Caddy already terminates TLS for
`marx.giraffe-yo.ts.net:443` and proxies `/boxerz` the same way, so one more block:

    handle_path /ccx* {
        reverse_proxy localhost:7681
    }

Then `https://marx.giraffe-yo.ts.net/ccx/` from the phone. `handle_path` strips the prefix,
so every URL in the page is relative (`api/list`, never `/api/list`).

HTTPS matters beyond privacy: service workers and Web Push only exist on a secure origin,
and the tailnet cert gives that for free.

## Who may use it

Anyone who can reach it. The tailnet is the boundary: caddy only listens for the tailnet
name, and the server only on 127.0.0.1. No auth in ccx.

## API

All JSON, all under the page's own path.

    GET  api/list                  rows: pid, session, name, path, state, asking, waitsOn,
                                   summary, age, hasPane; in tmux order, with
                                   `window` and `paneIndex` compared as numbers,
                                   since tmux gives them as strings
    GET  api/events                SSE; `list` event with the rows whenever they change
    GET  api/s/<pid>/log?before=N  transcript page ending before byte offset N (tail if no N)
    GET  api/s/<pid>/events        SSE; `log` events as the transcript grows, `screen` when
                                   the capture changes, `state` on a state change
    POST api/s/<pid>/type   {text}       typeInto()
    POST api/s/<pid>/pick   {n}          choose option n of the dialog that is up
    POST api/s/<pid>/esc                 Escape
    POST api/spawn  {dir, after?, mkdir?}
                                   with `after`, a pane id: a new tmux window right after
                                   that pane's, in its session. Without: a new kitty
                                   window. Answers {pid}
    GET  api/dirs?prefix=~/ai/c    subdirectories under prefix, for the dir field

Errors use the existing convention: the functions return a message or null, and the
server answers `{error}` with 409 for "not in tmux" and 502 for a tmux failure.

**pid is checked against the current poll** before any action. A pid that is no longer
a claude is 404: `typeInto` on a pane whose claude exited types into whatever shell took
it over, which runs the text.

**SSE, not WebSocket.** Updates go one way and actions are plain POSTs. SSE reconnects by
itself and resends `Last-Event-ID`, which here is the transcript byte offset, so a phone
that slept resumes where it left off. iOS Safari drops the connection when the tab goes to
the background; the page reconnects on `visibilitychange`.

Screen capture runs only while some client holds that instance's `events` stream open,
every 1.5s, and only sends when the text changed.

## Dialogs

Built: `dialog.js`, `parseDialog(text)` and `pick(inst, i, labels)`, tested against
captures of six kinds in `fixtures/dialog`: folder trust, a Bash and a Write permission,
the question tool single-select, multi-select and review page, and plan approval. The
findings are at the top of `dialog.js`; the ones that changed the design:

- **folder trust has no record** until it is answered, so `waitingFor` cannot gate the
  parse. The server parses the screen whenever the state is wait, and the bottom-of-screen
  rule in `dialog.js` keeps an idle input box from reading as a dialog
- **folder trust is not numbered and its default is "No, exit"**. The options are the
  block around the `❯` cursor, numbered or bare, not every `N.` line on screen: a plan's
  own steps are numbered above the options approving it
- **a digit alone picks a numbered option**, no Enter, measured on a permission and the
  question tool; on a multi-select it toggles the box. A bare option (folder trust, the
  multi-select's `Submit`) is arrows from the cursor, then Enter
- the dialog's text is the lines between the `─` rule above it and its options, `╌` rules
  and the question tool's `│` stripped; first line the title
- a wrapped label continues at the column a description uses, so both land in `detail`
- `pick` re-captures and refuses with "the dialog changed" unless the labels are the ones
  the page drew. Live: a stale list was refused, then `No` declined a Bash command

Not tried yet: picking "Type something." and then typing, and dialogs other than these
six. One that does not parse shows the screen view, where `esc` and the textarea work.

## Transcript

The session log is `~/.claude/projects/<slug>/<sessionId>.jsonl`. One measured here is
56MB, so it is never read whole.

- **tail first**: read the last 256KB, drop the partial first line, parse. Page back by
  reading the 256KB before the oldest offset already sent. The same offset trick
  `chat.js` uses to read only what was appended
- **follow**: on each poll, `stat` the file, read from the last offset if it grew
- **what shows** (counts from that 56MB log):
  - `user` with string content and `origin.kind` absent or `human`: your prompt
  - `user` with `origin.kind === "peer"`: a peer message, shown with `origin.name`
  - `assistant` `text`: the reply, rendered as markdown
  - `assistant` `tool_use`: one line, tool name plus its first argument (the command, the
    path), collapsed; tap to expand the input
  - `user` `tool_result` (1249 of them): collapsed under its tool_use, joined on
    `tool_use_id`, first lines only
  - `ai-title` / `custom-title`: the header
- **what hides**: `thinking` (914), `attachment`, `isMeta` records other than peer
  messages, `task-notification`, `mode`, `file-history-snapshot`, `last-prompt`
- a turn is written one content block per line, so a reply appears block by block, not
  token by token. The screen view is where the in-progress text is
- **a prompt typed while a turn runs is not a `user` record**: it is a `queued_command`
  attachment with `commandMode: "prompt"` (411 over 60 logs, none also written as a
  `user` record). A peer message landing mid-turn is one too, and 315 of 2415 of those
  are also written as a `user` record, so peer events carry `msg_id` and repeats drop
- a tool's result is its own event, `result`, joined to its `tool` on `id` by the page.
  They can sit on different pages, and while following, the result arrives later

Built: `transcript.js`, `readPage(path, before)` and `readFrom(path, offset)`, events
`user`, `peer`, `text`, `tool`, `result`, `command` (a slash command or `!`), `output`
(its stdout), `note` (interrupted, compacted). Paging all of 60 logs, 545MB, takes 1s.

Markdown rendering is a small hand-written subset (paragraphs, code fences, inline code,
lists, bold, links) in the page. No dependency. Undocumented format, same caveat as
the rest of ccx: a missing field falls back, a changed meaning is not caught.

## The page

One HTML string in `server.js`, served at `/`, with inline CSS and a module script.
Three views, switched by the URL hash so the back button works: the list, a session, and
the new-claude form.

- **the title bar is one line**, ~40px: back `‹` on the left where there is somewhere to
  go back to, the title, then the buttons on the right

- **states are glyphs only**, `● ◆ ◐ ○ ◌` in the state colours, no `wait`/`busy` words:
  rows, group tallies and the session header all use the glyph alone
- **list** (`#`): one group per kitty window, which is one tmux session (`kitty-<pid>`,
  from `ktmux`), since that is how the work is laid out on the desk. The title is the
  group's main directory: the `path` most of its rows share, ties to the first. A row in
  another directory shows its own path before the summary. Two windows in the same
  directory are two groups with the same title. Instances outside tmux go last, one group
  each. Groups and the rows in them are in tmux order (session, window, pane), so nothing
  moves on the phone when a state changes; the TUI sorts by state, this does not. A
  group header is the title, a tally per state (`●1 ◐2 ○1 ◌1` in the state colours) and a
  `+` that spawns in the main directory, `after` the group's last pane, or a new kitty
  window when the group has no pane. Tap a row to open it. The title bar is `ccx marx`,
  the counter and `offline` from `Online`, then a `+` at the top right that opens the
  new-claude form
- **session** (`#<pid>`): title bar is `‹`, the state glyph, name, path (no summary),
  then two buttons. The first switches between the transcript and the screen capture in
  a monospace `<pre>`: `>_` on history, `≡` (highlighted) on the screen. The second, `+`,
  spawns `after` this pane in its directory and opens the new one. The view always opens
  on history. When a dialog is up a card sits above the input: its title, the command or
  file it is about, the question, and one button per option. Bottom: `esc`, a textarea
  and a Send button. With no pane, neither button, nor the card, nor the bottom show
- **new claude** (`#new`): one text field completed from `api/dirs`, with the cwds of
  running instances listed first, a "create it" checkbox that shows when the path does
  not exist, and a start button. Starts it in a new kitty window and opens the session

**One font, Inconsolata, the one kitty uses** (`font_family` in kitty.conf, 17pt there).
A phone does not have it, so the server serves the variable TTF (347KB, OFL, from
`~/Library/Fonts/Inconsolata[wdth,wght].ttf`) and the page loads it with `@font-face`.
Text is 17px, nothing under 14px; the textarea stays at 17px since iOS zooms into any
field under 16px. The screen view is the exception that cannot fit: the capture is as
wide as the pane, 100+ columns, against ~44 at 14px on a 390px phone, so it scrolls
sideways and does not wrap, since wrapping breaks the dialog boxes.

Dark, large tap targets, `viewport-fit=cover` and safe-area padding for the iPhone notch.
A web app manifest so it can be added to the home screen, which is also what iOS requires
before it allows Web Push.

## Starting a claude

How it is done here today: each kitty OS window runs `~/.config/kitty/ktmux`, which is
`tmux new-session -s kitty-$$`, so one kitty window is one tmux session named `kitty-<pid>`
and its tmux windows are its tabs. Every claude pane is a login zsh with `claude` typed into
it (`pane_start_command` is empty, the pane process is `-zsh`), and its window is named
`cc:<name>` by `tmuxWindowName()`. Spawning copies that, so a claude started from the phone
looks the same as one started by hand, and drops back to zsh when it exits.

**Beside an instance, or in a group.** One tmux call, `after` being the instance's pane or
the group's last:

    new-window -a -t <after> -c <dir> -P -F '#{pane_id}'

`-a` puts it right after that pane's window, in the same kitty window. Then
`typeInto({pane}, "claude")`: it takes an instance and reads only `pane` and `pid`. The tmux server's environment is what the new zsh inherits,
not the launchd plist's, so `claude` is on PATH as it is in any other tab.

**In a new directory, in a new kitty window.** The kitty that is already running opens
the window, so the result is the same as cmd+n: an OS window running `ktmux`, a session
named `kitty-<pid>`, killed by `ktmux` when the window closes, and `jump()` works on it
like any other.

- `sendKitty("launch", {type: "os-window", cwd: dir}, tty)` from `jump.js`, with `tty` the
  `client_tty` of any tmux client kitty owns. That writes kitty's remote-control escape
  sequence straight to the tty, which is the path `focus-window` already takes and the one
  that works with no controlling terminal. `allow_remote_control yes` is set in
  kitty.conf. `launch` with no command runs kitty's `shell`, which is `ktmux`
- nothing comes back on a tty, so the new pane is found by diffing `list-sessions` before
  and after: the one new `kitty-*` session, polled up to 5s. Then `typeInto({pane},
  "claude")`
- unverified: that `tmux new-session` in `ktmux` starts in the `cwd` kitty gave the
  window. tmux uses the client's working directory when there is no `-c`, so it should;
  if not, `ktmux` takes `-c "$PWD"`
- **macOS only.** Here one kitty process (pid 656) already holds every OS window, and
  focus matches on the window's child pid, so one more window costs nothing. On Linux,
  `raiseWindow()` finds the niri window by kitty's own pid and assumes one window per
  process (comment above `niriWindow()` in `jump.js`), which `launch` would break. There
  the server starts `kitty --directory <dir>` as its own process, detached, instead
- `mkdir -p` first when the form asked for it
- with no kitty running there is no tty to write to. Then it falls back to `new-session
  -d -s ccx-<basename> -c <dir>`, detached, which the phone can use and the desk reaches
  with `tmux attach`

**Finding the new pid.** Once the pane is known, both kinds go the same way. It exists at
once, claude's record ~600ms after it starts. The record's `tmux` field is
`<session>:@<window_id>.<pane_id>`, e.g. `kitty-17937:@8.%8`, and `pane_id` already
carries the `%`, so the match is `tmux.endsWith(\`.${pane}\`)`. The server waits for a
record whose `tmux` names the new pane, up to 10s, and answers with its pid. The page then opens
`#<pid>`. A timeout answers with the pane id and an error; the screen view still works
off the pane.

**Folder trust.** A directory claude has not seen opens on its trust dialog, with no
record yet, so the new pid cannot come from one until it is answered. Its options parse
(bare, `❯ No, exit` first), and the page shows it like any other dialog. Tapping the first
option exits claude, so the button order on the card has to read clearly.

## Phase 2: notifications

The point of a phone is hearing when an instance wants you. Web Push, the browser
standard, works on iOS 16.4+ from a home-screen app and on Android Chrome, with no
third-party account.

- the server keeps a VAPID key pair in `~/.config/ccx/vapid.json` and the subscriptions
  the page registers
- it pushes on the same transition the bell rings on, `busy` -> `idle`, and on a new
  `waitingFor`
- sending needs an ES256 JWT and aes128gcm payload encryption (ECDH P-256 + HKDF). Deno's
  WebCrypto has all of it, so no dependency; roughly 120 lines
- the push goes to Apple's or Google's push service, so the payload is the instance name
  and state only, never transcript text

Simpler alternative if Web Push is too much: ntfy.sh or Pushover, one `fetch`, but that is
an account and a third party seeing which sessions you run.

## Build order

The backend first, every piece tested and reachable with curl, then the page on top of
an API that no longer moves.

Backend:

1. `Instance.sessionId` and `Instance.cwd` from the record, in `discover()`
2. `transcript.js` + tests against fixture logs, like `chat_test.js`
3. `dialog.js`: first save `capture-pane -p` output of real dialogs as fixtures
   (permission prompt, folder trust, a multi-select, a `/command` menu), then the parser
   and its tests, then `pick`, settling digit against arrows on a live dialog
4. `spawn.js`, both kinds, checking the `ktmux` cwd and `sendKitty("launch")` on the way
5. `server.js`: every route, both SSE streams, `ccx serve`; exercised with curl
6. `ccx systray` starts it after its own `Deno.serve`; `doctor` shows the port and
   whether it bound

Frontend:

7. the page, list and history; check it on the phone through caddy (the caddy block is a
   change to the live proxy, so ask before adding it)
8. the session view: type, esc, the screen, the dialog card
9. the new-claude form and the `+` buttons
10. Web Push

## To verify

Each is a guess the build has to check before relying on it:

- `ktmux`'s `tmux new-session` starts in the `cwd` kitty gave the window
- `sendKitty("launch", ...)` to a client tty opens an OS window; `focus-window` is the
  only command sent that way so far

## Open questions

- **screen colours**: `capture-pane -p` is plain text. `-e` keeps the colours as escape
  codes, and a ~40 line converter in the page turns them into spans. Colour is how Claude
  Code marks the selected option, diff lines and errors; not decided
- **Linux**: the server itself is portable; only the systray host is macOS-first
