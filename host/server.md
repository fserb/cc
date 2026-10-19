# cchost's API: remote control over HTTP

An HTTP API, served by cchost, that lists every running Claude Code instance, shows each one's
conversation, lets you type into it, answer its dialogs, interrupt it, and start new
ones. Its client is cc (`web/`), which calls `https://nadya.gum.ts.net/ccapi/api/...`:
nadya's caddy forwards `/ccapi/*` to nadya's cchost, which answers for every host.

**There is no page any more** (user, 2026-10-12: "I'm not using it at all since cc is much
better"). `page.html`, its manifest, icons and font went; every route is under `/api`, and
`/` is 404. What this file says about the page below is history.

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
- **spawn beside**: a new claude in a new tmux window, in the same kitty window as an
  instance or a group
- **spawn new**: a new kitty window, so a new tmux session, and a new claude in a
  directory you name

An instance outside tmux is read-only: history yes, everything else no. Out of scope for
the first version: attaching files or images.

## Shape

    server.js        Deno.serve, the routes, the poll
    transcript.js    reads one session log into display events, tail first, paged back
    dialog.js        parses the dialog out of a pane capture, and picks an option
    spawn.js         starts a claude in a new tmux window or session

`Instance` gains `sessionId` and `cwd` from the record. `path` is the pane's
`pane_current_path`, which follows a `cd` in the shell, so it cannot name the log. Both are
empty with no record, and then there is no history.

`server.js` exports `runServer({port, source})`. `source` is a function returning the
current instance list, the daemon's own poll result, so there is one `discover()` per
poll. `doctor` asks the port over HTTP, since the server is cchost's process.

## Reaching it through caddy

The server binds **127.0.0.1 only**, default port 7681. Caddy already terminates TLS for
`marx.gum.ts.net:443` and proxies `/boxerz` the same way, so one more block:

    redir /ccx /ccx/
    handle_path /ccx* {
        reverse_proxy localhost:7681 {
            header_up Host {upstream_hostport}
        }
    }

Added to `/opt/homebrew/etc/Caddyfile` after `/boxerz` and reloaded, 2026-10-04. Through
it: the API answered, both SSE streams arrived unbuffered, a `text/plain` POST was
refused, and `/boxerz` still answered. `handle_path` strips the prefix. That marx block
served the page, which is gone; nothing calls it now. On nadya, `/ccapi/` (below) is cc's
route; it replaced the `/ccx/` lemon app (`host/www/lemon.js`, deleted 2026-10-12).

## Who may use it

Anyone who can reach it. The tailnet is the boundary: cchost answers only a tailnet
address or loopback (`tailnetOrLocal`). No auth. The docker bridge rule went with lemon
(2026-10-12): every container on nadya could type.

Behind caddy (`handle_path /ccapi/* { reverse_proxy localhost:7681 }`) the connection
comes from loopback with the client in `X-Forwarded-For`, which caddy with no
`trusted_proxies` overwrites, so a loopback connection carrying that header is judged by
the header's last address (`clientAddr`). The Host is then `<host>.<tailnet>.ts.net` with
no port, which `ownHost` accepts for this machine's own name only; any other Host needs
our port.

That boundary does not cover your own browser. `type` runs whatever it is given, so any
web page you visit could otherwise reach it two ways, and both are refused before routing:

- **DNS rebinding**: a page points a name of its own at 127.0.0.1 and calls the port, as
  same-origin. It arrives with that name as Host, so only `127.0.0.1:<port>` and
  `localhost:<port>` are accepted, and caddy sends the upstream's own with `header_up Host
  {upstream_hostport}`
- **cross-site POST**: a form or a no-cors fetch to the tailnet URL. `Sec-Fetch-Site:
  cross-site` is refused, and a POST must be `application/json`, which another origin
  cannot send without a CORS preflight the server never answers

## API

All JSON, all under `api/`.

    GET  api/list                  {rows, offline}: rows as in "Rows" below; no age, which would make
                                   every row change every second; in tmux order, with
                                   `window` and `paneIndex` compared as numbers,
                                   since tmux gives them as strings
    GET  api/events                SSE; `list` with the same body at once, then whenever
                                   it changes
    GET  api/changes[?all=1][&since=ID]  SSE of session changes, below
    GET  api/s/<pid>/log?before=N  {events, start, end}: the page ending before byte N,
                                   the tail with no N. `start` is the next N back. A
                                   `user` event with `images` carries `img`, its line's
                                   byte offset
    GET  api/s/<pid>/img?at=N&i=K  the K-th image of the prompt on the line at byte N,
                                   decoded from the log's base64, as its own type
    GET  api/s/<pid>/events?from=N SSE from byte N (or Last-Event-ID): `state` with the
                                   row, `log` {events, end, reset?} with `end` as its id,
                                   `screen` {text}, `dialog` (parsed, or null), `gone`
                                   when the pid leaves the poll. No N: the tail, as a reset
    GET  api/s/<pid>/screen        {text, input, dialog}, once; input is what is typed in
                                   the input box, "" if empty or only a dim suggestion,
                                   null with no box (a dialog); draft is what cc's chat
                                   box holds for it, "" if nothing
    POST api/s/<pid>/draft  {text}  cc's chat box text for it ("" clears); kept 30s, cc
                                    re-posts every 10s while it lasts
    POST api/s/<pid>/type   {text, images?}  typeInto(). `images` [{type, data}], data base64,
                                           png/jpeg/gif/webp, at most 4 of 10 MB: written
                                           to /tmp/cc-img (gone after a day), each path
                                           pasted alone where the text's nth 🖼 (U+1F5BC)
                                           is, else first, and Claude Code takes it as
                                           `[Image #N]`; text may then be empty
    POST api/s/<pid>/pick   {i, labels, text?}  option i of the dialog, refused unless its
                                           labels are still `labels`; `text` answers the
                                           question tool's free-text option (`free` on it)
    POST api/s/<pid>/tab    {k, labels}    the question tool's tab k (the dialog's `tab` is
                                           the current one), refused unless its tab labels
                                           are still `labels`; an answered question shows
                                           its answer as `picked`
    POST api/s/<pid>/now                   ctrl+x ctrl+s, Claude Code's "send now": with an
                                           empty input, stops the turn and sends the queue
                                           (`esc`, a bare Escape, went 2026-10-12: nothing
                                           called it; `screen` stays, nadya reads it)
    POST api/s/<pid>/unqueue {text}        takes the first queued message equal to text (runs
                                           of whitespace aside) out of the queue and leaves the
                                           rest queued, in order: {ok, kept}, kept the number
                                           typed back (queue.js). 409 when the box holds
                                           unsent text, a dialog is up, nothing is queued or
                                           text is not in it, every popped message typed back
                                           in the last two cases. Without text: drops every
                                           queued message and answers {ok} (cchost before
                                           2026-10-12 does this with text too); the turn goes on
    POST api/s/<pid>/goal {goal}           what cc shows under its name (goals.js), kept in
                                           ~/.claude/ccx-goals.json; "" clears it. {ok, goal}
    POST api/spawn  {dir, after?, mkdir?, goal?}
                                   with `after`, a pane id: a new tmux window right after
                                   that pane's, in its session. Without: a new kitty
                                   window. `goal` as api/s/<pid>/goal. Answers {pid, pane}
    GET  api/dirs?prefix=~/ai/c    {dirs, exists}: subdirectories under prefix, for the
                                   dir field, and whether prefix itself is one. Here and
                                   in spawn a dir not starting with ~ or / is under ~
                                   (`ai/c` is `~/ai/c`; 2026-10-13, user)
    GET  api/away[?all=1]          away mode (away.js): {on, since, delay, answered}; with
                                   all, {hosts: [{host, on, since, delay} | {host, down}],
                                   answered: [... each with host], newest first}
    POST api/away[?all=1] {on}     turn it on or off, here or on every host that answers

### Rows

Every row has these fields and no others (`ROW` in server.js, pinned by a test; until
2026-10-12 the record's fields were spread in, and absent with no record):

- `pid`, `name`, `path` (`~`-relative), `cwd`, `sessionId`, `sock` (the messaging socket)
- `goal` (goals.js, "" with none) and `context` (tokens in its context at its last reply,
  read off the session log; 0 with none), since 2026-10-14
- `state` wait | busy | hold | free, `since` (epoch s), `summary`, `asking` (the dialog a
  wait is on), `question` (2026-10-14: a wait whose last reply ends in a question mark,
  that reply's last line; "" otherwise), `waitsOn` (the peer a hold is on), `agents` (its subagents running now,
  0 unless busy; claudes.js `subagentsRunning`)
- `hasPane`, `pane`, `session`, `window`, `paneIndex`, `tab`: where it is in tmux
- the session record's own, `""`/`0`/`[]` when there is none (a session read off the
  pane): `status` busy | waiting | idle | shell, `statusUpdatedAt` (epoch ms),
  `startedAt`, `version`, `peerFeatures`. The relay's stand-ins are built from these;
  `status` tells a background shell from a peer hold, which `state` draws as `hold` for
  both (nadya's co.js reads it)

The merged list (`all=1`) rewrites `pid`, `pane`, `session` and `path` with the host.

### Every host through one daemon (2026-10-12)

Any cchost answers for every host, which is what `www/lemon.js` did until it was deleted.
Without `all=1` and with a bare pid every route is this host's alone, as above: the other
daemons' relay streams and ccx call them that way, and marx may run older code.

    GET  api/list?all=1            {rows, offline, up, down, host}: every host's rows in
                                   CCX_HOSTS order, tagged: pid `<host>.<pid>`, pane
                                   `<host>/<pane>` (or ""), session `<host>:<session>`
                                   (or ""), path `<host>:<path>`; every other field as the
                                   host gave it. `up` [host], `down` [[host, why]],
                                   `offline` the first host's non-empty one, `host` the
                                   old display text `marx · nadya (x down)`
    GET  api/events?all=1          SSE; `list` with that body at once and on any change
    *    api/s/<host>.<pid>/<verb> this host: `api/s/<pid>/<verb>`, with `state` rows and
                                   `gone` in its stream tagged the same. Another host:
                                   proxied to its daemon, method, body, status and the
                                   headers content-type, sec-fetch-site and last-event-id
                                   passed; its stream re-sent with rows tagged. 404 for a
                                   host not in CCX_HOSTS, 502 for one that does not answer
    POST api/spawn                 `after` `<host>/<pane>` or dir `<host>:dir` runs it on
                                   that host, the answer's pid and pane tagged; neither,
                                   here as before
    POST api/focus {id, on}        `id` `<host>.<pid>` shown in a kitty window on host `on`
                                   (default this one), passed to `on`'s daemon. There: its
                                   own session by jump() when a tmux client shows it, else
                                   a new kitty window attached; another host's by its
                                   `select` (which answers `session` too) and a kitty
                                   window running `ssh -t <host> tmux attach`, as `ccx
                                   focus`. cc's ⧉ button, with on=marx (2026-10-12)
    GET  api/dirs?prefix=<host>:p  that host's dirs, each `<host>:`-tagged; a bare prefix
                                   with `all=1` asks every host

    GET  api/chat?cwd=<dir>        {cwd, msgs}: chat.js's messages between the sessions
                                   that ran in dir, this host's transcripts only. dir is
                                   absolute or `~/...`; `since` (epoch s) keeps the later
    GET  api/chat?all=1&cwd=<dir>  {cwd, msgs, down}: every host's, a path under HOME asked
                                   for as `~/...`; each message with its `host`, one row
                                   for a message's two copies (chat.js mergeChats)
    GET  api/chat/events?cwd=<dir> SSE; `log` {msgs} at once, then `msg` per new message.
                                   With all=1 `log` {msgs, down}, then a poll every 2s
    GET  api/doctor                {self, api: {url, from, ok, note, ms}}, one probe
    *    api/subs, api/unsub       with `host` (query or body) another host's, passed on

- the other hosts' rows are the event streams cchost already follows for the relay
  (`remote.follow`), cached per host as their last `list` body, so `all=1` opens no
  connection. A host whose stream dropped is in `down` with the fetch error, one not yet
  heard from with `no list yet`; it retries every 5s
- tried on nadya against the live daemons: rows from both hosts, `log`, `screen` and the
  session stream of a marx instance through nadya, `dirs` with `marx:` and with `all=1`

Errors use the existing convention: the functions return a message or null, and the
server answers `{error}` with 502 when the message starts `tmux:` and 409 otherwise (not
in tmux, no dialog, the dialog changed), 400 for a malformed body.

Built: `server.js` and `ccx serve [--port N]` (`ccx serve` went 2026-10-12; `host/cchost
--port N` with `CCX_SELF`/`CCX_HOSTS` set to a scratch host does the same). Run against a scratch session through every
route: spawn into a new directory, `pick` refusing stale labels with 409 and then
answering folder trust, `type` starting a turn, `esc` (since removed) interrupting it, the
log showing the prompt and the partial reply. The session stream follows a /clear, which
starts a new log under a new sessionId, by checking the path every tick.

**pid is checked against the current poll** before any action. A pid that is no longer
a claude is 404: `typeInto` on a pane whose claude exited types into whatever shell took
it over, which runs the text.

**SSE, not WebSocket.** Updates go one way and actions are plain POSTs. SSE reconnects by
itself and resends `Last-Event-ID`, which here is the transcript byte offset, so a phone
that slept resumes where it left off. iOS Safari drops the connection when the tab goes to
the background; the client reconnects on `visibilitychange`.

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
  the client drew. Live: a stale list was refused, then `No` declined a Bash command

## Away mode (away.js, 2026-10-19)

User: "auto answer questions ... when I'm offline, so work doesn't get stuck on me". Off by
default; while on, each cchost answers its own sessions' question boxes (AskUserQuestion
only, told apart by `Chat about this`) after 5 minutes on one with nothing in cc's box for
it. A single-select gets a typed answer in its free-text field: "The user is away
(auto-answer). Pick the option you'd recommend, note the pick and why in your reply, and
continue. If the choice can't be undone (...), don't pick: stop and leave the question for
the user." A multi-select or a preview layout gets `Chat about this`, then the same words as
an `[auto-answer]` prompt once idle; several tabs go one by one, then `Submit answers`.

Tried on 2.1.303, 2026-10-19, on a throwaway session: `Chat about this` alone ("talk about
it") left the agent asking "What would you like to clarify?", still waiting; the typed answer
got a pick with its reason, and the work went on. Each answer goes to
`~/.claude/ccx-away.jsonl` (14 days) with the question, its options, how, the text, and the
log's size then, from which `answered` reads the agent's reply.

## Taking a queued message back (queue.js, 2026-10-12)

Measured on 2.1.296 on a scratch session kept busy by a foreground sleep:

- typed messages queued during a turn are drawn above the input box, each as `❯ <text>`,
  and the empty box reads `Press up to edit queued messages`, dim (SGR 2, so the capture
  is `capture-pane -e`). A peer message waits in the same queue, drawn `› Message from
  @<name>`
- **Up pops every typed message into the box, oldest first, joined by "\n"**; peer messages
  stay queued. A draft already in the box goes after them. A large paste shows as
  `[Pasted text #1 +11 lines]`. With nothing queued, Up recalls the last prompt instead
- the transcript logs `queue-operation` records: `enqueue` with the content, one `popAll`
  per popped message (same timestamp, in order), `dequeue` with no content as one is sent,
  `remove` with the content as a peer message is. A large paste's content is wrapped in
  `<pasted_content id="...">`. One session logged an `enqueue` with no content and none at
  all for another, so the queue is not rebuilt from the log: only the `popAll` records
  written after our Up are trusted, polled up to 2s (about 200ms in practice)
- **two paste+Enter pairs in one tmux call, or keys sent in quick separate calls, reach
  Claude Code as one chunk**: "A" and "C" queued as one message "AC", and 16 ctrl+u
  followed by pastes read as a paste with "Removed 12 invisible characters", not sent. So
  each message goes back in its own call and waits for its `enqueue` record (up to 1s), and
  the box is emptied 4 ctrl+u at a time, re-reading the screen in between
- unqueue: refuse unless the box is empty but for the dim hint, Up, read the popped
  messages, empty the box, type back all but the first equal to `text` (unwrapped from the
  paste tags), each a bracketed paste and Enter. They queue again behind the peer messages
  still queued, which they may have been ahead of. A dialog that comes up meanwhile gets the
  rest pasted into the box with no Enter. 0.2-0.7s for three or four messages. One at a
  time per pane
- tried live through `POST /api/s/<pid>/unqueue` on nadya: three queued, the middle one
  taken, the other two ran in order after the turn; text not in the queue and a draft in
  the box answered 409 and left the queue as it was

Free text (2.1.296, 2026-10-12): the option above `Chat about this` is a field; its digit
focuses it, after which a digit is text (cc sent `3` again and again into one). `pick` with
`text` sends the digit unless the cursor is on it, then ctrl+u, a bracketed paste, Enter.
Not tried yet: dialogs other than these six. One that does not parse shows the screen view, where the textarea works.

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
- a tool's result is its own event, `result`, joined to its `tool` on `id` by the client.
  They can sit on different pages, and while following, the result arrives later
- an AskUserQuestion result carries `answers: [[question, answer], ...]`, from the record's
  `toolUseResult.answers` ({question: answer}), uncut; its `text` is cut like any result.
  cc shows them as what you said (2026-10-12; before, cc read them back out of the text
  with a regex, which it still does for an event with no `answers`)

Built: `transcript.js`, `readPage(path, before)` and `readFrom(path, offset)`, events
`user`, `peer`, `text`, `tool`, `result`, `command` (a slash command or `!`), `output`
(its stdout), `note` (interrupted, compacted). Paging all of 60 logs, 545MB, takes 1s.

Markdown rendering is a small hand-written subset (paragraphs, code fences, inline code,
lists, bold, links) in the client (cc now). No dependency. Undocumented format, same caveat as
the rest of ccx: a missing field falls back, a changed meaning is not caught.

## The page (removed 2026-10-12)

`page.html` was served at `/`: a list grouped by kitty window, a session view with history,
the screen and a dialog card, and a new-claude form, checked on Android Chrome through
caddy on 2026-10-04. cc replaced it; it is in git history before the removal commit.

## Starting a claude

How it is done here today: each kitty OS window runs `~/.config/kitty/ktmux`, which is
`tmux new-session -s kitty-$$`, so one kitty window is one tmux session named `kitty-<pid>`
and its tmux windows are its tabs. Every claude pane is a login zsh with `claude` typed into
it (`pane_start_command` is empty, the pane process is `-zsh`), and its window is named
`cc:<name>` by `tmuxWindowName()`. Spawning copies that, so a claude started from the phone
looks the same as one started by hand, and drops back to zsh when it exits.

**Beside an instance, or in a group.** One tmux call, `after` being the instance's pane or
the group's last:

    display-message -p -t <after> '#{session_name}:#{window_index}'
    new-window -a -d -t <that> -c <dir> -P -F '#{pane_id}'

`new-window -t` takes a window and refuses a pane ("can't specify pane here"), hence the
lookup. `-a` puts it right after that window, in the same kitty window, and renumbers the
rest; `-d` leaves the desk on the window it is showing. Then
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
- `ktmux`'s `tmux new-session` starts in the `cwd` kitty gave the window, measured
- **macOS only.** Here one kitty process (pid 656) already holds every OS window, and
  focus matches on the window's child pid, so one more window costs nothing. On Linux,
  `raiseWindow()` finds the niri window by kitty's own pid and assumes one window per
  process (comment above `niriWindow()` in `jump.js`), which `launch` would break. There
  the server starts `kitty --directory <dir>` as its own process, detached, instead
- `mkdir -p` first when the form asked for it
- with no kitty running there is no tty to write to. Then it falls back to `new-session
  -d -s ccx-<basename> -c <dir>`, detached, which the phone can use and the desk reaches
  with `tmux attach`

**Finding the new pid.** Once the pane is known, both kinds go the same way. Not by the
record: a new directory opens on folder trust, which writes none until it is answered. So
`discover()` is polled until an instance sits in the new pane, which walks claude's
process up to it, up to 10s. The client then opens `#<pid>`. A timeout answers with the pane
id and an error; the screen view still works off the pane.

Built: `spawn.js`, `spawn({dir, after, mkdir})`. Measured live: beside, 457ms from the call
to the pid; a new kitty window, 657ms. `claude` typed before the login zsh is up still
arrives.

**Folder trust.** A directory claude has not seen opens on its trust dialog, with no
record yet, so the new pid cannot come from one until it is answered. Its options parse
(bare, `❯ No, exit` first), and a client shows it like any other dialog. Tapping the first
option exits claude, so the button order on the card has to read clearly.

## Session changes (changes.js, 2026-10-14)

`GET api/changes` streams each session change as it happens, for the trigger engine `trig`
(~/ai/trig, its format agreed with trig-a) and anything else that would poll api/list.
`/api/events` was taken by the list stream, hence the name.

- `event: change`, `id: <id>`, data `{id, host, pid: "<host>.<pid>", name, dir:
  "<host>:~/...", cwd, sessionId, from, to, what, asking, waitsOn, summary, goal, context,
  at}` (at in epoch s). `what` is cchost's word for it: `new` (first sight), `busy`, `done`
  (busy to a plain wait), `wait` (any other plain wait), `asking` (a wait on a dialog,
  `asking` names it; or a turn that ended on a plain-text question, `question` holds its
  last line), `hold`, `free`, `gone` (ended from anything but busy), `crashed`
  (ended while busy, so a `ccx delete` of a busy session is one too), `context` (its
  context crossed a 100k mark upward, `over` the mark; from and to the unchanged state)
- ids are ms since the epoch, or one past the last, so they go up across restarts. The last
  2000 changes are kept in memory. `since` (or Last-Event-ID) replays every change after it,
  first with `event: lost` {host, since} for each host whose changes may be missing: the id
  is from before this daemon started, or older than the buffer. Then `event: ready` {id,
  host}, and the stream is live
- a restart does not announce the sessions already running as `new`: changes start after
  the first poll, as for `any is new`. What happened while cchost was down is not seen
- `all=1`: every host's. Each cchost follows every other's `api/changes` (remote.js
  `followChanges`), and puts each change in its own buffer under an id of its own; a
  reconnect asks with the last id it got, so a dropped link loses nothing the other host
  still holds, and a `lost` from it (it restarted) is passed on as a buffered `lost` entry
- tried live on nadya with a scratch server: `ccx new` then `ccx delete` gave `new` (free),
  `gone`, and nadya's own `busy`, `done` in between; `since` replayed them, `since=5` said
  `lost` first

## Notifications

Web Push from the page was planned and never built; the page is gone. Notices to agents
are `ccx notify` (subs.js).

## To verify

Each is a guess the build has to check before relying on it:

- spawning on Linux, `kitty --directory`, which nothing here has run

## Open questions

- **screen colours**: `capture-pane -p` is plain text. `-e` keeps the colours as escape
  codes, which a client would turn into spans. Colour is how Claude Code marks the
  selected option, diff lines and errors; not decided
