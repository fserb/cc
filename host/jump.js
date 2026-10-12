// Finding an instance's window, putting it in front of you, and typing into it.

import {BYTES, MAC, ON_EXIT, run, sh, shSync} from "./sh.js";
import {kittyOwner, processes} from "./claudes.js";
import {dialogRefusal, screen} from "./dialog.js";

// `kitten @` writes a bare `ESC P @kitty-cmd {...} ESC \`, and tmux forwards only
// `ESC P tmux; ... ESC \`, so the command never reaches kitty and --no-response still
// exits 0. Hence building the sequence here and wrapping it.
const KITTY_RC_VERSION = [0, 26, 0];

// Send one kitty remote-control command. With a `tty` the bare sequence goes straight
// there, the only path that works with no controlling terminal of our own; without one it
// falls back to /dev/tty, wrapped for tmux, which swallows a bare DCS.
export function sendKitty(command, payload, tty = null) {
  const msg = {cmd: command, version: KITTY_RC_VERSION, no_response: true, payload};
  const wid = Deno.env.get("KITTY_WINDOW_ID");
  if (wid) msg.kitty_window_id = Number(wid);
  let seq = `\x1bP@kitty-cmd${JSON.stringify(msg)}\x1b\\`;
  if (!tty && Deno.env.get("TMUX")) {
    seq = `\x1bPtmux;${seq.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
  }
  const target = tty ?? "/dev/tty";
  try {
    // create/truncate are no-ops on a tty, which is what every real target is
    const f = Deno.openSync(target, {write: true, create: true, truncate: true});
    try {
      f.writeSync(BYTES.encode(seq));
    } finally {
      f.close();
    }
    return true;
  } catch (e) {
    console.error(`cannot write to ${target}: ${e.message}`);
    return false;
  }
}

// A tty to write kitty commands to when we have no terminal of our own, as when Raycast or
// launchd runs us: one of kitty's windows, whose pty kitty reads the bytes off like any
// output. A ktmux `kitty-` session's client first, else any process kitty started with a
// tty, as an `ssh -t <host> tmux attach` window, which is no tmux client here: with only
// those open, the reopen in openKitty() raised one of them and opened nothing. null when
// /dev/tty or tmux will carry them, "" when nothing can
export async function kittyTty() {
  if (Deno.env.get("TMUX")) return null;
  try {
    Deno.openSync("/dev/tty", {write: true}).close();
    return null;
  } catch {
    // no controlling terminal
  }
  const own = (await sh("tmux", "list-clients", "-F", "#{client_tty}\t#{client_session}"))
    .split("\n").map((l) => l.split("\t")).find(([, s]) => s?.startsWith("kitty-"));
  if (own) return own[0];
  const rows = (await sh("ps", MAC ? "-axo" : "-eo", "pid=,ppid=,tty=,comm=")).split("\n")
    .map((l) => l.trim().split(/\s+/)).filter((r) => r.length >= 4);
  const kitty = new Set(rows.filter((r) => r[3].split("/").pop() === "kitty").map((r) => r[0]));
  const win = rows.find(([, ppid, tty]) => kitty.has(ppid) && /^(ttys|pts\/)\d+$/.test(tty));
  return win ? `/dev/${win[2]}` : "";
}

// The niri window id for a process, or null. A kitty process owns exactly one OS window,
// so its pid identifies the window; `single_instance` or `kitty @ launch --type=os-window`
// would break that and raise whichever of them niri lists first.
async function niriWindow(pid) {
  try {
    for (const w of JSON.parse(await sh("niri", "msg", "--json", "windows") || "[]")) {
      if (String(w.pid) === String(pid)) return w.id;
    }
  } catch {
    return null;
  }
  return null;
}

// Bring the terminal's own window to the front. On Wayland an app cannot raise itself
// without a recent interaction, so the compositor is asked by its own window id.
async function raiseWindow(inst) {
  if (MAC) {
    await sh("open", "-a", "kitty");
    return;
  }
  if (!inst.kittyProc) return;
  const wid = await niriWindow(inst.kittyProc);
  if (wid !== null) await sh("niri", "msg", "action", "focus-window", "--id", String(wid));
}

// What raiseWindow() would do with this instance, for `ccx doctor` to print.
export async function raiseTarget(inst) {
  if (MAC) return "open -a kitty";
  if (!inst.kittyProc) return "(no kitty ancestor)";
  const wid = await niriWindow(inst.kittyProc);
  return wid !== null ? `niri ${wid}` : `(kitty ${inst.kittyProc} not in niri)`;
}

// Focus the instance. Returns an error message, or null when it worked.
export async function jump(inst) {
  if (!inst.pane) return `pid ${inst.pid} is not inside tmux; nothing to focus`;
  // one tmux call: the three must land in this order, and `;` says so in one process
  const client = inst.clientTty
    ? ["switch-client", "-c", inst.clientTty, "-t", inst.session, ";"]
    : Deno.env.get("TMUX") ? ["switch-client", "-t", inst.session, ";"] : [];
  // tmux stops at the first command that fails, so a session gone since the last poll
  // moves nothing; say so, or the caller reports a jump that did not happen
  const r = await run("tmux", ...client,
    "select-window", "-t", `${inst.session}:${inst.window}`, ";",
    "select-pane", "-t", inst.pane);
  if (r.code !== 0) return `tmux: ${r.err.trim() || `exit ${r.code}`}`;
  if (inst.match) {
    // the client's own tty, so this works with no controlling terminal of our own
    sendKitty("focus-window", {match: inst.match}, inst.clientTty || null);
  }
  await raiseWindow(inst);
  return null;
}

// The instance's window and pane made current in its session, and nothing else: what a
// client attached to it from another machine then shows. An error message, or null
export async function select(inst) {
  if (!inst.pane) return `pid ${inst.pid} is not inside tmux; nothing to select`;
  const r = await run("tmux", "select-window", "-t", `${inst.session}:${inst.window}`, ";",
    "select-pane", "-t", inst.pane);
  return r.code === 0 ? null : `tmux: ${r.err.trim() || `exit ${r.code}`}`;
}

// The background tmux paints panes with here, `#rrggbb`, or "" when it leaves the terminal's
// own: window-active-style, then window-style, as `bg=#282828` in either
export async function tmuxBackground() {
  for (const opt of ["window-active-style", "window-style"]) {
    const bg = (await sh("tmux", "show", "-gwv", opt)).match(/bg=(#[0-9a-fA-F]{6})\b/)?.[1];
    if (bg) return bg.toLowerCase();
  }
  return "";
}

// Name our own tmux window for as long as the app runs. Returns the restore.
// automatic-rename otherwise shows the pane's foreground command, `deno`. `allow-rename`
// is off by default, so ESC k is ignored and only `rename-window` works; that turns
// automatic-rename off for the window, hence the restore.
export function tmuxWindowName(name) {
  const pane = Deno.env.get("TMUX_PANE");
  if (!pane) return () => {};
  // shSync, not sh: the restore runs from ON_EXIT, and Deno.exit does not await a promise
  const was = shSync("tmux", "display-message", "-p", "-t", pane,
    "#{automatic-rename}\t#{window_name}").trim();
  shSync("tmux", "rename-window", "-t", pane, name);

  const restore = () => {
    const [auto, before] = [was.slice(0, was.indexOf("\t")), was.slice(was.indexOf("\t") + 1)];
    if (auto === "1" || !before) {
      shSync("tmux", "set-window-option", "-t", pane, "automatic-rename", "on");
    } else {
      shSync("tmux", "rename-window", "-t", pane, before);
    }
  };
  ON_EXIT.push(restore);
  return () => {
    ON_EXIT.splice(ON_EXIT.indexOf(restore), 1);
    restore();
  };
}

// Name our own kitty window for as long as the app runs. Target the client's kitty
// ancestor, never KITTY_WINDOW_ID: inside a pane that is inherited from the tmux SERVER's
// environment and can name a window that closed long ago.
export async function kittyWindowTitle(name) {
  let target = {};
  if (Deno.env.get("TMUX")) {
    const pid = (await sh("tmux", "display-message", "-p", "#{client_pid}")).trim();
    if (!pid) return () => {};        // no client attached, so no window to name
    target = {match: `pid:${kittyOwner(Number(pid), await processes())[0]}`};
  }
  sendKitty("set-window-title", {...target, title: name});

  const restore = () => sendKitty("set-window-title", target);  // no title: kitty's default
  ON_EXIT.push(restore);
  return () => {
    ON_EXIT.splice(ON_EXIT.indexOf(restore), 1);
    restore();
  };
}

// Type `text` into the instance's prompt as its user and press Enter, so a `/command` runs
// the way a typed one does. Returns an error message, or null when it worked.
//
// A bracketed paste, then Enter. Keys sent with `send-keys -l` are read as an unbracketed
// paste once there are enough of them, and on 2.1.284 that swallows every Enter after it
// as a newline: 749 characters sat in the input through the Enter and another 3s later.
// `paste-buffer -p` wraps the text in the markers, so the paste ends where the text does
// and the Enter submits, in the same tmux call: 10KB, two lines and `/clear` all measured.
// A newline in the text stays a newline. The pane hosted a claude when discover() ran; a
// session that exited since leaves the text in whatever shell took the pane, and runs it.
//
// Refused while the pane shows a dialog, since the Enter would answer it (dialogRefusal);
// `force` types anyway. The screen is read just before the paste, so a dialog drawn in
// between still takes it.
//
// `images` are file paths, one per IMAGE mark in the text, in order, each pasted where its
// mark is: Claude Code reads a paste that is only an image's path as that image,
// `[Image #N]` in the box, and a path inside other text stays text (2.1.296). It reads the
// file after the paste returns and inserts the tag at the cursor then, so a text pasted
// right behind it lands before it: each image waits until one more `[Image #` is on the
// screen, 5s at most. An image with no mark left goes first.
export const IMAGE = "\u{1F5BC}";
// `text` cut at its marks around `images`, as [string | {path}], in paste order, no ""
export function imageParts(text, images) {
  const cut = text.split(IMAGE), n = Math.min(images.length, cut.length - 1);
  const parts = [...images.slice(n).map((path) => ({path})), cut[0]];
  for (let i = 0; i < n; i++) parts.push({path: images[i]}, cut[i + 1]);
  if (cut.length > n + 1) parts[parts.length - 1] += IMAGE + cut.slice(n + 1).join(IMAGE);
  return parts.filter((p) => p !== "");
}
export async function typeInto(inst, text, {force = false, images = []} = {}) {
  if (!inst.pane) return `pid ${inst.pid} is not inside tmux; nothing to type into`;
  if (!force) {
    const shown = await screen(inst.pane);
    if (shown === null) return `tmux: cannot capture ${inst.pane}`;
    const refused = dialogRefusal(shown);
    if (refused) return refused;
  }
  const buf = `ccx-${inst.pid}`;
  if (!images.length) {
    const r = await run("tmux", "set-buffer", "-b", buf, "--", text, ";",
      "paste-buffer", "-p", "-d", "-b", buf, "-t", inst.pane, ";", "send-keys", "-t", inst.pane, "Enter");
    return r.code === 0 ? null : `tmux: ${r.err.trim() || `exit ${r.code}`}`;
  }
  const parts = imageParts(text, images);
  const err = await pasteParts(inst.pane, parts);
  if (err) return err;
  typedImages.set(imageKey(parts), parts);
  if (typedImages.size > 100) typedImages.delete(typedImages.keys().next().value);
  const r = await run("tmux", "send-keys", "-t", inst.pane, "Enter");
  return r.code === 0 ? null : `tmux: ${r.err.trim() || `exit ${r.code}`}`;
}

// imageParts() each a paste of its own, an image waiting for its tag. null, or why not.
export async function pasteParts(pane, parts) {
  const buf = `ccx-parts-${pane}`;
  const tags = async () => ((await screen(pane)) ?? "").split("[Image #").length;
  for (const part of parts) {
    const before = part.path ? await tags() : 0;
    const r = await run("tmux", "set-buffer", "-b", buf, "--", part.path ?? part, ";",
      "paste-buffer", "-p", "-d", "-b", buf, "-t", pane);
    if (r.code !== 0) return `tmux: ${r.err.trim() || `exit ${r.code}`}`;
    for (let t = 0; part.path && t < 100 && (await tags()) <= before; t++) {
      await new Promise((ok) => setTimeout(ok, 50));
    }
  }
  return null;
}

// The last 100 messages typed with images, by imageKey(): a queued one taken back by
// unqueue() comes out as text, `[Image #N]` where each image was, and has to be typed
// again with the same files (queue.js)
export const typedImages = new Map();
export const imageKey = (parts) => parts.map((p) => p.path ? IMAGE : p).join("")
  .replace(/\s+/g, " ").trim();
export const unpic = (t) => t.replace(/\[Image #\d+\]/g, IMAGE);

// Press `keys`, tmux key names, on the instance's pane, in one call. An error message, or
// null when it worked. Same caveat as typeInto(): a pane whose claude exited since takes
// them in its shell.
export async function sendKeys(inst, keys) {
  if (!inst.pane) return `pid ${inst.pid} is not inside tmux; nothing to send keys to`;
  const r = await run("tmux", "send-keys", "-t", inst.pane, ...keys);
  return r.code === 0 ? null : `tmux: ${r.err.trim() || `exit ${r.code}`}`;
}

// The tmux client showing `inst`'s session and the kitty window it is in, read now, for a
// focus from this machine: {...inst, clientTty, kittyPid, kittyProc, match}
export async function withClient(inst) {
  if (!inst.session) return inst;
  const client = (await sh("tmux", "list-clients", "-F",
    "#{client_tty}\t#{client_pid}\t#{client_session}")).split("\n").map((l) => l.split("\t"))
    .find(([, , s]) => s === inst.session);
  if (!client) return {...inst, clientTty: "", kittyPid: "", kittyProc: "", match: null};
  const [child, kitty] = kittyOwner(Number(client[1]), await processes());
  return {...inst, clientTty: client[0], kittyPid: String(child),
    kittyProc: kitty ? String(kitty) : "", match: `pid:${child}`};
}

// The command a kitty window runs to show a remote tmux session: a plain attach of the
// whole session, since a kitty window is a session and its tabs one piece of work. Closing
// the window hangs the client up, and tmux keeps a session whose client got SIGHUP.
// -u: an ssh session on nadya has no LANG, so tmux fell back to line-drawing and dropped
// every non-ASCII glyph, the powerline ones included
// With no host it is this machine's tmux, by its full path: kitty runs the command with its
// own PATH, which on macOS has no /opt/homebrew/bin
const attachArgs = (host, session, tmux = "tmux") => host
  ? ["ssh", "-t", host, "tmux", "-u", "attach", "-t", session]
  : [tmux, "-u", "attach", "-t", session];

// The kitty window already attached to a remote tmux session comes to the front, or a new
// one opens attached.
//
// The window takes the remote tmux's pane background, so the padding around it and the
// title bar (`macos_titlebar_color background`) match what tmux paints: `color` when it is
// made, `set-colors` on every focus after, so a theme changed since still lands
const PAINTED = ["background", "active_border_color", "inactive_border_color"];

// kitty on macOS keeps running with every window closed, and then no tty reaches it.
// `open -a kitty` reopens it with one window, which runs ktmux (kitty.conf `shell`): a tmux
// client in a new `kitty-<pid>` session. [tty, session, client pid], or null after 5s
async function openKitty() {
  if (!MAC) return null;
  const clients = async () => (await sh("tmux", "list-clients", "-F",
    "#{client_tty}\t#{client_session}\t#{client_pid}")).split("\n").map((l) => l.split("\t"))
    .filter(([, s]) => s?.startsWith("kitty-"));
  const before = new Set((await clients()).map(([t]) => t));
  await sh("open", "-a", "kitty");
  for (let n = 0; n < 50; n++) {
    const got = (await clients()).find(([t]) => !before.has(t));
    if (got) return got;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

export async function attachSession(host, session, background = "") {
  let tty = await kittyTty(), helper = null;
  if (tty === "") {
    // a window opened only to reach kitty by, closed once the attached one is up
    helper = await openKitty();
    if (!helper) return "no terminal of our own and no kitty window in tmux to reach kitty by";
    tty = helper[0];
  }
  const bg = /^#[0-9a-f]{6}$/.test(background ?? "") ? background : "";
  const tmux = host ? "tmux" : (await sh("sh", "-c", "command -v tmux")).trim() || "tmux";
  const args = attachArgs(host, session, tmux);
  const want = args.join(" "), procs = await processes();
  for (const [pid, [, cmd]] of procs) {
    if (cmd !== want) continue;
    const [child, kitty] = kittyOwner(pid, procs);
    if (!kitty) continue;
    if (bg) {
      const rgb = parseInt(bg.slice(1), 16);
      sendKitty("set-colors", {match_window: `pid:${child}`,
        colors: Object.fromEntries(PAINTED.map((c) => [c, rgb]))}, tty);
    }
    if (!sendKitty("focus-window", {match: `pid:${child}`}, tty)) return "cannot reach kitty";
    if (MAC) await sh("open", "-a", "kitty");
    return null;
  }
  // launch's `color` reaches the window's profile and not the title bar, which kitty worked
  // out when it made the window, still black; set-colors recomputes it (kitty 0.49.2,
  // launch.py apply_colors against colors.py patch_colors). The user var is how the
  // set-colors finds a window that has no process to look up yet
  const tag = `${host || "local"}.${session}`;
  if (!sendKitty("launch", {args, type: "os-window",
    var: [`ccx_remote=${tag}`], ...(bg ? {color: PAINTED.map((c) => `${c}=${bg}`)} : {})}, tty)) {
    return "cannot reach kitty";
  }
  if (bg) {
    const rgb = parseInt(bg.slice(1), 16);
    sendKitty("set-colors", {match_window: `var:ccx_remote=^${tag.replace(/[.\\^$*+?()[\]{}|]/g, "\\$&")}$`,
      colors: Object.fromEntries(PAINTED.map((c) => [c, rgb]))}, tty);
  }
  if (helper) {
    const [child] = kittyOwner(Number(helper[2]), await processes());
    sendKitty("close-window", {match: `pid:${child}`}, tty);
  }
  if (MAC) await sh("open", "-a", "kitty");
  return null;
}

// Focus one of this machine's instances from a daemon, which has no terminal: jump() when a
// tmux client shows its session, else its pane selected and a new kitty window attached to
// the session. An error message, or null
export async function show(inst) {
  if (!inst.pane) return `pid ${inst.pid} is not inside tmux; nothing to focus`;
  const w = await withClient(inst);
  if (w.clientTty) return await jump(w);
  const err = await select(inst);
  if (err) return err;
  if (await kittyTty() !== "") return await attachSession("", inst.session, await tmuxBackground());
  // nothing reaches kitty: the window opened to reach it by shows the session itself
  const got = await openKitty();
  if (!got) return "no kitty window in tmux to reach kitty by, and none opened";
  const r = await run("tmux", "switch-client", "-c", got[0], "-t", inst.session, ";",
    "kill-session", "-t", got[1]);
  return r.code === 0 ? null : `tmux: ${r.err.trim() || `exit ${r.code}`}`;
}
