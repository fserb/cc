// `deno test -A --ext js typed_test.js`

import {Typed} from "./typed.js";

function eq(got, want, what = "") {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

Deno.test("a typed prompt tags its log line once, and comes back after a restart", () => {
  const file = Deno.makeTempFileSync();
  const t = new Typed(file), at = Date.now();
  t.add(7, "watchdog", "You are nadya\n(restarted)", at);
  const ev = (text, s = 1) => ({type: "user", at: at / 1000 + s, text});
  const events = [ev("\n\n<pasted_content id=\"a1\">\nYou are nadya (restarted)\n</pasted_content>"),
    ev("You are nadya (restarted)", 2), ev("hi")];
  eq(t.tag(7, events).map((e) => e.by ?? null), ["watchdog", null, null]);
  eq(t.tag(8, events).map((e) => e.by ?? null), [null, null, null]);
  eq(new Typed(file).tag(7, events)[0].by, "watchdog");
  eq(t.tag(7, [ev("You are nadya (restarted)", 120)])[0].by ?? null, null);
});

Deno.test("an image is a mark in what was typed and [Image #N] in the log", () => {
  const t = new Typed(Deno.makeTempFileSync()), at = Date.now();
  const r = t.add(7, "nadya", "see \u{1F5BC} here", at);
  const e = {type: "user", at: at / 1000, text: "see [Image #2] here"};
  eq(t.tag(7, [e])[0].by, "nadya");
  t.drop(r);
  eq(t.tag(7, [e])[0].by ?? null, null);
});
