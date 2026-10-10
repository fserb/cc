// `deno test -A --ext js subs_test.js`. Parsing, matching and the one-shot / timed
// lifetimes, against a fake deliver and a fake clock.

import {
  matches,
  noticeText,
  parseDuration,
  parseNotify,
  Subs,
} from "./subs.js";

function eq(got, want, what) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`${what}: got ${g}, want ${w}`);
}

const ev = (pid, from, to, extra = {}) => ({
  pid,
  name: `n${pid}`,
  from,
  to,
  asking: "",
  waitsOn: "",
  ...extra,
});

Deno.test("parseDuration", () => {
  eq(
    [
      parseDuration("90s"),
      parseDuration("30m"),
      parseDuration("2h"),
      parseDuration("1d"),
    ],
    [90, 1800, 7200, 86400],
    "units",
  );
  eq(
    [
      parseDuration("2"),
      parseDuration("h"),
      parseDuration("2w"),
      parseDuration(undefined),
    ],
    [0, 0, 0, 0],
    "not durations",
  );
});

Deno.test("parseNotify", () => {
  eq(parseNotify(["me", "when", "nadya:ccx-a"]), {
    who: "me",
    target: "nadya:ccx-a",
    state: "",
    secs: 0,
  }, "any change, once");
  eq(parseNotify(["nadya", "when", "x", "is", "wait", "for", "2h"]), {
    who: "nadya",
    target: "x",
    state: "wait",
    secs: 7200,
  }, "a state for 2h");
  eq(
    parseNotify(["me", "when", "x", "for", "1d", "is", "gone"]).state,
    "gone",
    "any order",
  );
  eq(!!parseNotify(["me", "x"]).error, true, "no when");
  eq(
    !!parseNotify(["me", "when", "x", "is", "sleepy"]).error,
    true,
    "a bad state",
  );
  eq(
    !!parseNotify(["me", "when", "x", "for", "soon"]).error,
    true,
    "a bad duration",
  );
  eq(
    !!parseNotify(["me", "when", "x", "until", "2h"]).error,
    true,
    "a bad word",
  );
});

Deno.test("matches: a change of the target's state, gone always", () => {
  const any = { target: { pid: 1 }, state: "" },
    wait = { target: { pid: 1 }, state: "wait" };
  eq(matches(any, ev(1, "busy", "wait")), true, "any change");
  eq(matches(any, ev(1, "", "wait")), false, "first sight");
  eq(
    matches(any, ev(1, "wait", "wait", { asking: "permission_prompt" })),
    false,
    "a new dialog",
  );
  eq(matches(any, ev(2, "busy", "wait")), false, "another pid");
  eq(matches(wait, ev(1, "wait", "busy")), false, "not the state asked for");
  eq(matches(wait, ev(1, "busy", "wait")), true, "the state asked for");
  eq(matches(wait, ev(1, "busy", "gone")), true, "gone");
});

Deno.test("noticeText: names the dialog or what it holds on", () => {
  const sub = { id: 3, target: { pid: 1, name: "a" } };
  eq(
    noticeText(
      "nadya",
      sub,
      ev(1, "busy", "wait", { asking: "permission_prompt" }),
    ),
    "[ccx notify nadya:3] nadya:n1 busy -> wait (permission_prompt)",
    "a dialog",
  );
  eq(
    noticeText("marx", sub, ev(1, "busy", "hold", { waitsOn: "ccx-b" })),
    "[ccx notify marx:3] marx:n1 busy -> hold (on ccx-b)",
    "a hold",
  );
});

function setup() {
  const sent = [], t = { now: 1000 };
  const subs = new Subs("nadya", (who, text) => {
    sent.push([who.pid, text]);
    return who.pid === 99 ? "no claude instance with pid 99" : null;
  }, () => t.now);
  return { sent, t, subs };
}

const me = (pid = 50) => ({ host: "nadya", pid, name: "me" });

Deno.test("Subs: one shot fires once", async () => {
  const { sent, subs } = setup();
  subs.add({ who: me(), target: { pid: 1, name: "a" } });
  await subs.onEvents([ev(1, "wait", "busy")]);
  await subs.onEvents([ev(1, "busy", "wait")]);
  eq(sent.length, 1, "once");
  eq(subs.list().length, 0, "dropped");
});

Deno.test("Subs: for <time> fires every match until then", async () => {
  const { sent, t, subs } = setup();
  subs.add({ who: me(), target: { pid: 1 }, state: "wait", secs: 60 });
  await subs.onEvents([ev(1, "busy", "wait")]);
  await subs.onEvents([ev(1, "wait", "busy")]);
  await subs.onEvents([ev(1, "busy", "wait")]);
  eq(sent.length, 2, "both waits");
  t.now += 61;
  await subs.onEvents([ev(1, "wait", "busy"), ev(1, "busy", "wait")]);
  eq(sent.length, 2, "expired");
  eq(subs.list().length, 0, "dropped");
});

Deno.test("Subs: the target going ends it, the subscriber going drops it", async () => {
  const { sent, subs } = setup();
  subs.add({ who: me(), target: { pid: 1 }, state: "free", secs: 3600 });
  await subs.onEvents([ev(1, "busy", "gone")]);
  eq(sent.length, 1, "told it went");
  eq(subs.list().length, 0, "and dropped");
  subs.add({ who: me(), target: { pid: 2 } });
  await subs.onEvents([ev(50, "wait", "gone")]);
  eq(subs.list().length, 0, "a local subscriber that exited");
  subs.add({ who: { host: "marx", pid: 50 }, target: { pid: 2 } });
  await subs.onEvents([ev(50, "wait", "gone")]);
  eq(subs.list().length, 1, "a pid on another host is not ours");
});

Deno.test("Subs: a subscriber that is no longer a claude loses its subscription", async () => {
  const { subs } = setup();
  subs.add({ who: me(99), target: { pid: 1 }, secs: 3600 });
  subs.add({ who: me(), target: { pid: 1 }, secs: 3600 });
  await subs.onEvents([ev(1, "busy", "wait")]);
  eq(subs.list().map((s) => s.who.pid), [50], "only the reachable one");
});
