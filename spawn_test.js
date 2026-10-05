// `deno test -A --ext js spawn_test.js`. Only what is decided before tmux is touched; the
// spawning itself opens windows on the desk, so it was checked by hand (see spawn.js).

import {expandDir, spawn} from "./spawn.js";
import {HOME} from "./sh.js";

function eq(got, want, what) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`${what}: got ${g}, want ${w}`);
}

Deno.test("expandDir: ~ is HOME, and only at the start", () => {
  eq(expandDir("~"), HOME, "alone");
  eq(expandDir("~/ai/ccx"), `${HOME}/ai/ccx`, "as a prefix");
  eq(expandDir("~x/ai"), "~x/ai", "another user's home is left alone");
  eq(expandDir("/tmp/~"), "/tmp/~", "not in the middle");
});

Deno.test("spawn: a bad directory is refused before tmux is touched", async () => {
  eq(await spawn({dir: "ai/ccx"}), {error: "not an absolute path: ai/ccx"}, "relative");
  const gone = `${Deno.makeTempDirSync()}/not/here`;
  eq(await spawn({dir: gone}), {error: `no such directory: ${gone}`}, "missing, no mkdir");
  const file = Deno.makeTempFileSync();
  eq(await spawn({dir: file, mkdir: true}).then((r) => r.error.startsWith("cannot create")),
    true, "a file in the way");
});
