import {assertEquals} from "jsr:@std/assert";
import {breakdown, group, projectOf} from "./burn.js";

const H = 3600_000, WEEK = 168 * H;

Deno.test("projectOf: the dir under web or ai, a team prefix, an old name", () => {
  assertEquals(projectOf("/Users/fserb/web/arcade", "arcade-switch-a"), "arcade-switch");
  assertEquals(projectOf("/Users/fserb/web/bb", "bb-a0"), "bb");
  assertEquals(projectOf("/home/fserb/nadya", "nadya-a"), "nadya");
  assertEquals(projectOf("/Users/fserb/ai/head", "head"), "nadya");
  assertEquals(projectOf("/tmp/x", "x"), "/tmp/x");
});

const row = (h, p, n, w) => ({h, p, n, w, out: 0, cw: 0, cr: 0, in: 0, m: 1, host: "a"});

Deno.test("group: shares of the weighted tokens times the % the log added", () => {
  const g = group([row(0, "bb", "bb-a", 300), row(H, "bb", "bb-b", 100), row(0, "ccx", "ccx", 100)], 10);
  assertEquals(g.projects.map((p) => [p.p, p.q]), [["bb", 8], ["ccx", 2]]);
  assertEquals(g.projects[0].sessions.map((s) => [s.n, s.q]), [["bb-a", 6], ["bb-b", 2]]);
});

Deno.test("breakdown: last week with no log falls back to the token estimate", () => {
  const reset = 1000 * WEEK, start = reset - WEEK, now = start + 30 * H;
  const u = {used: 20, resetsAt: reset, history: [{at: start + 10 * H, used: 5, resetsAt: reset}]};
  const b = breakdown([row(start - 5 * H, "bb", "bb", 14e6), row(start + H, "ccx", "ccx", 7)], u, now);
  assertEquals(b.weeks.map((w) => [w.label, w.used, w.projects[0].p, w.projects[0].q]),
    [["last week", null, "bb", null], ["this week", 20, "ccx", 20]]);
  assertEquals(b.days.reduce((s, d) => s + d.w, 0), 14e6 + 7);
});
