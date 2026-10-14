// `deno test -A --ext js goals_test.js`

import {Goals} from "./goals.js";

function eq(got, want, what = "") {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

Deno.test("goals: set, read back after a restart, cleared by an empty one", () => {
  const file = Deno.makeTempFileSync();
  const g = new Goals(file);
  g.set(42, "  cc: the session\n goal  ");
  eq(g.get(42), "cc: the session goal");
  eq(new Goals(file).get(42), "cc: the session goal", "a restart reads the file back");
  g.set(42, "");
  eq(new Goals(file).get(42), "");
});

Deno.test("goals: a pid unlisted for 10 minutes is dropped, a listed one kept", () => {
  const file = Deno.makeTempFileSync();
  const g = new Goals(file), now = Date.now();
  g.set(1, "one");
  g.set(2, "two");
  g.prune([1], now + 5 * 60_000);
  g.prune([1], now + 11 * 60_000);
  eq([g.get(1), g.get(2)], ["one", ""]);
  eq(new Goals(file).get(2), "", "and the drop is saved");
});
