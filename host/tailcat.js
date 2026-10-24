// tailcat links (user, Oct 24th: "manage a tailcat that is installed locally"): cchost runs
// each `tailcat` of CCX_TAILCAT, restarts it when it exits, and says how it is in
// api/list's `tailcat`. nadya runs `forward` to engels's cchost (7691) and ssh (2222 -> 22);
// engels runs `serve` to nadya's key alone (docs/engels.md). tailcat is installed apart.
//
//   CCX_TAILCAT="<name>: <tailcat args>; <name>: <tailcat args>"
//
// `~/` in an argument is HOME, and an argument `@<file>` is that file's text, trimmed (the
// server's address, which holds its pre-shared key, stays in ~/ai/apis/tailcat). A file
// not there yet leaves the link `waiting`, looked at again every 30s.
//
// A forward does not redial a server that restarted (tailcat 0.7.0, tried on nadya Oct 24th:
// no answer through it for 15s after the server came back with the same key), so a forward
// whose name is a host down for DOWN is restarted.

import {HOME} from "./sh.js";

const DOWN = 60_000, CHECK = 10_000, RETRY = 30_000;

// "a: x y; b: z" -> [{name, args}]
export function parseLinks(text = "") {
  return text.split(";").map((s) => s.trim()).filter((s) => s).map((s) => {
    const m = s.match(/^([\w.-]+):\s*(.*)$/);
    if (!m) throw new Error(`CCX_TAILCAT: "${s}" is not "<name>: <tailcat args>"`);
    return {name: m[1], args: m[2].split(/\s+/).filter((a) => a)};
  });
}

// the arguments as tailcat gets them: ~/ expanded, @file read. [args] or [null, why]
export function resolveArgs(args, home = HOME) {
  const out = [];
  for (const a of args.map((a) => a.replace(/(^|=|,|@)~\//g, `$1${home}/`))) {
    if (!a.startsWith("@")) {
      out.push(a);
      continue;
    }
    try {
      out.push(Deno.readTextFileSync(a.slice(1)).trim());
    } catch {
      return [null, `no ${a.slice(1).replace(home, "~")}`];
    }
  }
  return [out];
}

// a line of tailcat's, without the address it prints when it starts (it holds the key)
const clean = (line) => line.replace(/^#\s*/, "").replace(/\btc[\w-]{40,}/g, "tc…").slice(0, 200);

export class Tailcat {
  // isDown(name): why the host `name` is down, or nothing (remote.isDown)
  constructor(links, isDown = () => null, bin = "tailcat") {
    this.bin = bin;
    this.isDown = isDown;
    this.links = links.map((l) => ({...l, cmd: l.args[0] ?? "", state: "starting", pid: 0,
      since: Date.now(), line: "", restarts: 0, child: null, downSince: 0, retry: 0}));
    this.alive = true;
  }

  start() {
    for (const l of this.links) this.run(l);
    this.timer = setInterval(() => this.check(), CHECK);
  }

  // what api/list says: one per link
  state() {
    return this.links.map(({name, cmd, state, pid, since, line, restarts}) =>
      ({name, cmd, state, pid, since, line, restarts}));
  }

  run(l) {
    if (!this.alive) return;
    const [args, why] = resolveArgs(l.args);
    if (!args) return this.wait(l, "waiting", why, RETRY);
    let child;
    try {
      child = new Deno.Command(this.bin, {args, stdin: "null", stdout: "null", stderr: "piped"}).spawn();
    } catch (e) {
      return this.wait(l, "failed", `${this.bin}: ${e.message}`, RETRY);
    }
    const started = Date.now();
    Object.assign(l, {child, pid: child.pid, state: "running", since: started, line: "", downSince: 0});
    this.read(l, child.stderr);
    child.status.then((s) => {
      l.child = null;
      if (!this.alive) return;
      l.restarts++;
      // one that ran a minute is restarted at once, else in 5s, so a bad argument does not spin
      this.wait(l, "exited", `exit ${s.signal ?? s.code}${l.line ? `: ${l.line}` : ""}`,
        Date.now() - started > 60_000 ? 1000 : 5000);
    });
  }

  wait(l, state, line, ms) {
    Object.assign(l, {state, line, pid: 0, since: Date.now()});
    clearTimeout(l.retry);
    l.retry = setTimeout(() => this.run(l), ms);
  }

  async read(l, stream) {
    let rest = "";
    try {
      for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
        const lines = (rest + chunk).split("\n");
        rest = lines.pop();
        const last = lines.map((s) => s.trim()).filter((s) => s).at(-1);
        if (last && l.state === "running") l.line = clean(last);
      }
    } catch {
      // the process went; status says so
    }
  }

  // a forward to a host that has been down for DOWN is restarted. SIGKILL: on SIGTERM a
  // forward with a connection open shuts its listener and does not exit (tried, Oct 24th)
  check(now = Date.now()) {
    for (const l of this.links) {
      if (l.cmd !== "forward" || !l.child) continue;
      if (!this.isDown(l.name)) {
        l.downSince = 0;
        continue;
      }
      l.downSince ||= now;
      if (now - l.downSince < DOWN || now - l.since < DOWN) continue;
      l.line = `${l.name} down ${Math.round((now - l.downSince) / 1000)}s, restarting`;
      kill(l.child);
    }
  }

  stop() {
    this.alive = false;
    clearInterval(this.timer);
    for (const l of this.links) {
      clearTimeout(l.retry);
      if (l.child) kill(l.child);
    }
  }
}

function kill(child) {
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
}
