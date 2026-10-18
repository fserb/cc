// Starting a claude from outside the terminal: beside an instance, in a new tmux window of
// its session, or in a new kitty OS window. Either way a login zsh with `claude` typed into
// it, the way one is started by hand, so it drops back to zsh when it exits.
//
// Measured on macOS, kitty with `allow_remote_control yes` and `ktmux` as its shell:
// - `launch` written to a kitty client's tty opens an OS window running `ktmux`, whose
//   `tmux new-session` starts in the `cwd` kitty gave it, so the new session's pane is
//   in the directory asked for. Nothing comes back on a tty, so the session is found by
//   diffing `list-sessions`
// - `new-window -t` takes a window, not a pane: "can't specify pane here". `-a` inserts
//   after it and renumbers the rest; `-d` keeps the desk on the window it is showing
// - a new directory opens on the folder-trust dialog, which writes no session record until
//   it is answered, so the pid is found by the process in the pane, not by a record
// - starting a claude in a directory is the trust decision (user, 2026-10-10), so spawn()
//   answers that dialog, and only that one, "Yes, I trust this folder". It reads the pane
//   until the session writes its record (a trusted dir, ~600ms) or the dialog shows

import {HOME, MAC, run, sh} from "./sh.js";
import {jump, sendKeys, sendKitty, typeInto} from "./jump.js";
import {discover} from "./claudes.js";
import {parseDialog, pickKeys, screen} from "./dialog.js";

const TMUX_ERR = (r) => `tmux: ${r.err.trim() || `exit ${r.code}`}`;

export function expandDir(dir) {
  dir = homeRel(dir);
  return dir === "~" || dir.startsWith("~/") ? `${HOME}${dir.slice(1)}` : dir;
}

// a dir not starting with / or ~ is under home: `ai/cc` is `~/ai/cc`. Sent to
// another host in this form, since its home is another path. "" is `~/`
export function homeRel(dir) {
  return /^[~/]/.test(dir) ? dir : `~/${dir}`;
}

function isDir(dir) {
  try {
    return Deno.statSync(dir).isDirectory;
  } catch {
    return false;
  }
}

function isFile(path) {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

// A new tmux window right after the one holding pane `after`, in the same session.
export async function newWindowAfter(after, dir) {
  const w = await run("tmux", "display-message", "-p", "-t", after,
    "#{session_name}:#{window_index}");
  if (w.code !== 0) return {error: TMUX_ERR(w)};
  const r = await run("tmux", "new-window", "-a", "-d", "-t", w.out.trim(), "-c", dir,
    "-P", "-F", "#{pane_id}");
  return r.code === 0 ? {pane: r.out.trim()} : {error: TMUX_ERR(r)};
}

async function sessions() {
  return new Set((await sh("tmux", "list-sessions", "-F", "#{session_name}")).split("\n")
    .filter(Boolean));
}

// A new kitty OS window, which `ktmux` makes a new `kitty-<pid>` session. With no kitty
// attached to tmux there is nothing to write the request to, so a detached session
// instead, which the desk reaches with `tmux attach`.
export async function newKittyWindow(dir, wait = 5000, name = "") {
  const clients = (await sh("tmux", "list-clients", "-F", "#{client_tty}\t#{client_session}"))
    .split("\n").map((l) => l.split("\t")).filter(([, s]) => s?.startsWith("kitty-"));
  if (!clients.length) return detachedSession(dir, name);
  const before = await sessions();
  if (MAC) {
    if (!sendKitty("launch", {type: "os-window", cwd: dir}, clients[0][0])) {
      return {error: `cannot write to ${clients[0][0]}`};
    }
  } else {
    // one kitty process per window here, which raiseWindow() relies on
    new Deno.Command("kitty", {args: ["--directory", dir], stdin: "null", stdout: "null",
      stderr: "null"}).spawn().unref();
  }
  for (const end = Date.now() + wait; Date.now() < end;) {
    await new Promise((ok) => setTimeout(ok, 200));
    const fresh = [...await sessions()].filter((s) => !before.has(s) && s.startsWith("kitty-"));
    if (!fresh.length) continue;
    const pane = (await sh("tmux", "list-panes", "-t", fresh[0], "-F", "#{pane_id}"))
      .split("\n")[0];
    if (pane) return {pane};
  }
  return {error: `no new kitty window after ${wait / 1000}s`};
}

// named after the claude when it has a name, else ccx-<dir>
async function detachedSession(dir, claude = "") {
  const base = (claude || `ccx-${dir.split("/").filter(Boolean).at(-1) ?? "root"}`)
    .replace(/[.:]/g, "-");
  const taken = await sessions();
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  const r = await run("tmux", "new-session", "-d", "-s", name, "-c", dir,
    "-P", "-F", "#{pane_id}");
  return r.code === 0 ? {pane: r.out.trim()} : {error: TMUX_ERR(r)};
}

// The last tmux window with a pane whose cwd is exactly `dir` (or its realpath), as
// `session:index`, in a session with a client attached when `attached`; or "". Spawning
// adds a window there instead of a session per claude (user, 2026-10-12: "we should reuse
// a tmux of the same path")
export async function windowIn(dir, attached = false) {
  const dirs = [dir, Deno.realPathSync(dir)];
  const out = await sh("tmux", "list-panes", "-a", "-F",
    "#{session_name}\t#{window_index}\t#{session_attached}\t#{pane_current_path}");
  return out.split("\n").map((l) => l.split("\t"))
    .findLast(([s, , a, path]) => s && dirs.includes(path) && (!attached || a !== "0"))
    ?.slice(0, 2).join(":") ?? "";
}

// A new window after `target` (`session:index`), in the background, named `name` if given.
async function newWindowAt(target, dir, name = "") {
  const r = await run("tmux", "new-window", "-a", "-d", "-t", target, "-c", dir,
    ...(name ? ["-n", name] : []), "-P", "-F", "#{pane_id}");
  return r.code === 0 ? {pane: r.out.trim()} : {error: TMUX_ERR(r)};
}

// The pid of the claude in `pane`, once it is running.
export async function claudeIn(pane, wait = 10000) {
  for (const end = Date.now() + wait; Date.now() < end;) {
    const inst = (await discover()).find((i) => i.pane === pane);
    if (inst) return inst.pid;
    await new Promise((ok) => setTimeout(ok, 300));
  }
  return 0;
}

// The index of "Yes, I trust this folder" when `dialog` is the folder-trust dialog, else -1.
export function trustYes(dialog) {
  if (dialog?.title !== "Accessing workspace:") return -1;
  return dialog.options.findIndex((o) => o.n === null && o.label === "Yes, I trust this folder");
}

// Answer the folder-trust dialog on `pane` if it comes up before claude `pid` writes its
// session record. Keys sent as soon as the dialog is drawn can be lost (seen on nadya,
// 2.1.296: drawn 0.3s after start, Down Enter did nothing), so it reads on until the
// record shows and picks again, from wherever the cursor is then, once a second while the
// dialog is still up. An error message, or null.
export async function trustFolder(pid, pane, wait = 10000) {
  let sent = 0;
  for (const end = Date.now() + wait; Date.now() < end;) {
    if (isFile(`${HOME}/.claude/sessions/${pid}.json`)) return null;
    const text = await screen(pane);
    const dialog = text === null ? null : parseDialog(text);
    const yes = trustYes(dialog);
    if (yes >= 0 && Date.now() - sent >= 1000) {
      const err = await sendKeys({pid, pane}, pickKeys(dialog, yes));
      if (err) return err;
      sent = Date.now();
    }
    await new Promise((ok) => setTimeout(ok, 250));
  }
  return sent ? `the trust dialog was answered, but no session record after ${wait / 1000}s`
    : `no session record and no trust dialog after ${wait / 1000}s`;
}

// The pane of the last instance in `dir`, the one the page's per-directory + goes after, or
// "" when no instance there is in tmux.
export async function paneIn(dir) {
  return (await discover()).findLast((i) => i.path === dir && i.pane)?.pane ?? "";
}

function shQuote(s) {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

// Start a claude in `dir`: in a new window after the last tmux window already in `dir`,
// else a detached tmux session, unless `focus`, which puts it in a new tmux window after
// pane `after` when given, else after a window in `dir` of an attached session, else in a
// new kitty window, and focuses it.
// `name` is its `claude -n`. {pid, pane, into: the window it went after when reused}, or {error} with the pane when one was made,
// since the screen still works off it. A claude by that name already in dir is the one
// asked for: nothing starts, and {pid, pane, existing: true} names it. `resume`, a sessionId
// whose log is under dir's project, starts it as `claude --resume <id>`: that conversation again.
export async function spawn({dir, after = "", mkdir = false, name = "", focus = false, resume = ""}) {
  dir = expandDir(dir ?? "");
  if (!dir.startsWith("/")) return {error: `not an absolute path: ${dir}`};
  if (!isDir(dir)) {
    if (!mkdir) return {error: `no such directory: ${dir}`};
    try {
      Deno.mkdirSync(dir, {recursive: true});
    } catch (e) {
      return {error: `cannot create ${dir}: ${e.message}`};
    }
  }
  if (name) {
    const real = Deno.realPathSync(dir);
    const same = (await discover()).find((i) => i.name === name &&
      [dir, real].includes(i.cwd || i.path));
    if (same) return {pid: same.pid, pane: same.pane, existing: true};
  }
  // focus needs a client on the session to show it, so only an attached one is reused
  const at = after ? "" : await windowIn(dir, focus);
  const made = at ? await newWindowAt(at, dir, name)
    : !focus ? await detachedSession(dir, name)
    : after ? await newWindowAfter(after, dir) : await newKittyWindow(dir, undefined, name);
  if (made.error) return made;
  // a shell, not a claude: no dialog to guard against
  const err = await typeInto({pid: 0, pane: made.pane},
    ["claude", name && `-n ${shQuote(name)}`, resume && `--resume ${resume}`].filter(Boolean).join(" "), {force: true});
  if (err) return {error: err, pane: made.pane};
  const pid = await claudeIn(made.pane);
  if (!pid) return {error: "claude did not start", pane: made.pane};
  const warnings = [await trustFolder(pid, made.pane)];
  if (focus) {
    const inst = (await discover()).find((i) => i.pid === pid);
    warnings.push(inst ? await jump(inst) : `${pid} not found to focus`);
  }
  const warning = warnings.filter(Boolean).join("; ");
  const r = at ? {pid, pane: made.pane, into: at} : {pid, pane: made.pane};
  return warning ? {...r, warning} : r;
}

function alive(pid) {
  try {
    Deno.kill(pid, "SIGCONT");      // a no-op signal that still fails with ESRCH once gone
    return true;
  } catch {
    return false;
  }
}

// End `inst`: SIGTERM, which lets claude take its MCP servers and shells with it, SIGKILL
// after `wait`, then its pane, and the tmux window with it when that was its only pane.
// An error message, or null.
export async function close(inst, wait = 2000) {
  try {
    Deno.kill(inst.pid, "SIGTERM");
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) return `kill ${inst.pid}: ${e.message}`;
  }
  for (const end = Date.now() + wait; alive(inst.pid) && Date.now() < end;) {
    await new Promise((ok) => setTimeout(ok, 100));
  }
  if (alive(inst.pid)) {
    try {
      Deno.kill(inst.pid, "SIGKILL");
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) return `kill ${inst.pid}: ${e.message}`;
    }
  }
  if (!inst.pane) return null;
  // a pane whose command was claude itself (ccx new) closes when claude exits
  const r = await run("tmux", "kill-pane", "-t", inst.pane);
  return r.code === 0 || /can't find pane/.test(r.err) ? null : TMUX_ERR(r);
}
