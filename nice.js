// Every claude and everything under it, moved to a lower scheduling priority and back.
// Draws nothing.
//
// On macOS this is PRIO_DARWIN_BG, what `taskpolicy -b` sets, not a nice value: a user can
// raise nice but never lower it again without root, so `renice 10` has no way back. BG can
// be cleared by the same user. It is more than nice: CPU priority 31 -> 4, I/O throttled,
// and on Apple Silicon only the efficiency cores. A child inherits it at fork, so the
// claude's future children start in it; clearing it is per process, so `normal` has to
// walk the tree the same way `low` does. On Linux it is nice 10, and back to 0 needs root.
import {IS_CLAUDE, processes} from "./claudes.js";
import {MAC} from "./sh.js";

const PRIO_PROCESS = 0, PRIO_DARWIN_PROCESS = 4, PRIO_DARWIN_BG = 0x1000, ESRCH = 3;

let LIBC = null;
function libc() {
  LIBC ??= Deno.dlopen(MAC ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    setpriority: {parameters: ["i32", "u32", "i32"], result: "i32"},
    [MAC ? "__error" : "__errno_location"]: {parameters: [], result: "pointer"},
  }).symbols;
  return LIBC;
}

// pids of every claude and every process under one, parents before children, so a child
// forked while this runs is born from a parent that already has the new priority
export function claudeTree(table) {
  const depth = new Map();
  for (const pid of table.keys()) {
    let cur = pid;
    for (let n = 0; n < 64 && cur > 1; n++) {
      if (IS_CLAUDE.test(table.get(cur)?.[1] ?? "")) {
        depth.set(pid, n);
        break;
      }
      cur = table.get(cur)?.[0] ?? 0;
    }
  }
  return [...depth].sort((a, b) => a[1] - b[1]).map(([pid]) => pid);
}

// [changed, refused]. Two passes: the second catches what a not-yet-lowered process forked
// between `ps` and its own turn. A process that exited since `ps`, zombies included, is
// ESRCH and counts as neither
export async function setNice(low) {
  const {setpriority, __error, __errno_location} = libc();
  const errno = () => new Deno.UnsafePointerView((__error ?? __errno_location)()).getInt32();
  const ok = new Set(), bad = new Set();
  for (let pass = 0; pass < 2; pass++) {
    for (const pid of claudeTree(await processes())) {
      if (ok.has(pid)) continue;
      const r = MAC
        ? setpriority(PRIO_DARWIN_PROCESS, pid, low ? PRIO_DARWIN_BG : 0)
        : setpriority(PRIO_PROCESS, pid, low ? 10 : 0);
      if (r === 0) {
        ok.add(pid);
        bad.delete(pid);
      } else if (errno() !== ESRCH) {
        bad.add(pid);
      }
    }
  }
  return [ok.size, bad.size];
}
