import {assertEquals} from "jsr:@std/assert";
import {breakdown, group, projectName, projectOf, weigh} from "./burn.js";

const H = 3600_000, WEEK = 168 * H;

Deno.test("projectOf: the dir under web or ai, a team prefix, an old name", () => {
  assertEquals(projectOf("/Users/fserb/web/arcade", "arcade-switch-a"), "arcade-switch");
  assertEquals(projectOf("/Users/fserb/web/bb", "bb-a0"), "bb");
  assertEquals(projectOf("/home/fserb/nadya", "nadya-a"), "nadya");
  assertEquals(projectOf("/Users/fserb/ai/head", "head"), "nadya");
  assertEquals(projectOf("/home/fserb/ai/cc", "ccx-a"), "cc");
  assertEquals(projectOf("/Users/fserb/ai/ccx", "ccx-a"), "cc");
  assertEquals(projectOf("/Users/fserb/prj/ccx", "x"), "cc");
});

Deno.test("projectOf: tmp, dotfiles, claude, home, a dated dir, a dot dir", () => {
  assertEquals(projectOf("/tmp/x", "x"), "tmp");
  assertEquals(projectOf("/private/tmp/ccx-newtest", "ccx-newtest"), "tmp");
  assertEquals(projectOf("/home/fserb/.dotfiles/config", "x"), "dotfiles");
  assertEquals(projectOf("/Users/fserb/.claude/projects", "x"), "claude");
  assertEquals(projectOf("/home/fserb", "x"), "home");
  assertEquals(projectOf("/Users/fserb/prj/bank", "x"), "bank");
  assertEquals(projectOf("/Users/fserb/notes/2026-10", "x"), "notes");
  assertEquals(projectOf("/Users/fserb/.config", "x"), "config");
});

Deno.test("projectName: what older rules stored reads as projectOf names it now", () => {
  const old = ["/tmp/wt", "/tmp", "~/", ".dotfiles", "~/.dotfiles/config", "~/.claude/projects",
    "ccx", "~/prj/ccx", "head", "arcade-switch", "nadya", "~/tmp/q-test"];
  assertEquals(old.map(projectName), ["tmp", "tmp", "home", "dotfiles", "dotfiles", "claude",
    "cc", "cc", "nadya", "arcade-switch", "nadya", "q-test"]);
  for (const n of ["tmp", "home", "dotfiles", "claude", "cc", "arcade-switch", "bank"]) {
    assertEquals(projectName(n), n, `${n} stays`);
  }
});

Deno.test("group: rows stored under old names join the project's row", () => {
  const g = group([row(0, "cc", "cc-a", 300), row(0, "ccx", "ccx-a", 100), row(0, "/tmp/a", "a", 50),
    row(H, "/tmp/b", "b", 50)]);
  assertEquals(g.projects.map((p) => [p.p, p.w, p.sessions.length]), [["cc", 400, 2], ["tmp", 100, 2]]);
});

const row = (h, p, n, w) => ({h, p, n, w, out: 0, cw: 0, cr: 0, in: 0, m: 1, host: "a"});

Deno.test("group: shares of the weighted tokens times the % the log added", () => {
  const g = group([row(0, "bb", "bb-a", 300), row(H, "bb", "bb-b", 100), row(0, "cc", "cc", 100)], 10);
  assertEquals(g.projects.map((p) => [p.p, p.q]), [["bb", 8], ["cc", 2]]);
  assertEquals(g.projects[0].sessions.map((s) => [s.n, s.q]), [["bb-a", 6], ["bb-b", 2]]);
});

Deno.test("breakdown: last week with no log falls back to the token estimate", () => {
  const reset = 1000 * WEEK, start = reset - WEEK, now = start + 30 * H;
  const u = {used: 20, resetsAt: reset, history: [{at: start + 10 * H, used: 5, resetsAt: reset}]};
  const b = breakdown([row(start - 5 * H, "bb", "bb", 14e6), row(start + H, "cc", "cc", 7)], u, now);
  assertEquals(b.weeks.map((w) => [w.label, w.used, w.projects[0].p, w.projects[0].q]),
    [["last week", null, "bb", null], ["this week", 20, "cc", 20]]);
  assertEquals(b.days.reduce((s, d) => s + d.w, 0), 14e6 + 7);
});

Deno.test("weigh: each model's list price over $5/M, Opus 5.5 reads at 0.05x input", () => {
  const u = {in: 1e6, cw: 2e6, cw1: 1e6, cr: 1e6, out: 1e6};
  // Opus 5.5: $4 in, $5 cw 5m, $8 cw 1h, $0.20 read, $20 out = $37.20
  assertEquals(Math.round(weigh("claude-opus-5-5", u)), 37.2e6 / 5);
  assertEquals(Math.round(weigh("claude-opus-4-8", u)), 46.75e6 / 5);
  assertEquals(Math.round(weigh("claude-sonnet-5-5", u)), 18.7e6 / 5);
  assertEquals(Math.round(weigh("claude-haiku-5-5", u)), 0.935e6 / 5);
  assertEquals(Math.round(weigh("claude-fable-5-1", u)), 93.5e6 / 5);
  assertEquals(weigh("<synthetic>", u), weigh("claude-opus-5-5", u));
});
