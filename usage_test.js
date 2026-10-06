import {assertEquals} from "jsr:@std/assert";
import {pace, readUsage, usageLine} from "./usage.js";

const H = 3600_000, WEEK = 168 * H;
const at = (used, hours) => ({used, resetsAt: 1_000 * WEEK + WEEK - hours * H, at: 0});
const now = 1_000 * WEEK;

Deno.test("pace: on an even spread it lands on 100 at the reset and never runs out", () => {
  const p = pace(at(50, 84), now);
  assertEquals([p.even, Math.round(p.end), p.out], [50, 100, null]);
});

Deno.test("pace: twice the even rate runs out halfway through the week", () => {
  const u = at(50, 42);
  const p = pace(u, now);
  assertEquals([p.even, p.end, p.out], [25, 200, u.resetsAt - WEEK + 84 * H]);
});

Deno.test("pace: under an hour in, or nothing used, there is no rate to project", () => {
  assertEquals(pace(at(3, 0.5), now).end, null);
  assertEquals(pace(at(0, 30), now).end, null);
});

Deno.test("pace: past the reset the numbers are a week that is over", () => {
  const u = at(90, 100);
  assertEquals(pace(u, u.resetsAt), null);
  assertEquals(usageLine(u, u.resetsAt + 1), null);
});

Deno.test("usageLine: red only when it runs out before the reset", () => {
  const out = usageLine(at(50, 42), now), fine = usageLine(at(20, 84), now);
  assertEquals(/^usage 50% \(25% - out \w{3} \d\d:\d\d\)$/.test(out.text), true);
  assertEquals(/^usage 20% \(50% - reset \w{3} \d\d:\d\d\)$/.test(fine.text), true);
  assertEquals(out.color === fine.color, false);
});

Deno.test("readUsage: no file, bad JSON or no seven_day is no data", async () => {
  const dir = await Deno.makeTempDir();
  assertEquals(readUsage(`${dir}/none`), null);
  await Deno.writeTextFile(`${dir}/half`, '{"rate_limits":{"seven');
  assertEquals(readUsage(`${dir}/half`), null);
  await Deno.writeTextFile(`${dir}/five`, '{"rate_limits":{"five_hour":{"used_percentage":3}}}');
  assertEquals(readUsage(`${dir}/five`), null);
  await Deno.writeTextFile(`${dir}/ok`,
    '{"rate_limits":{"seven_day":{"used_percentage":12.5,"resets_at":1700000000}}}');
  const u = readUsage(`${dir}/ok`);
  assertEquals([u.used, u.resetsAt], [12.5, 1_700_000_000_000]);
  await Deno.remove(dir, {recursive: true});
});
