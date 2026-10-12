import {assertEquals} from "jsr:@std/assert";
import {pace, readHistory, readUsage, usageLine} from "./usage.js";

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
  assertEquals([p.even, Math.round(p.end), Math.round(p.out)], [25, 200, u.resetsAt - WEEK + 84 * H]);
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
  assertEquals(/^usage 50% \(3\.0x pace - out \w{3} \d\d?[ap]m\)$/.test(out.text), true);
  assertEquals(/^usage 20% \(0\.[23]x pace\)$/.test(fine.text), true);
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

// a history line for the `at()` week, `hours` into it
const line = (used, hours, u) => ({at: u.resetsAt - WEEK + hours * H, used,
  resetsAt: u.resetsAt});

Deno.test("pace: the rate is what the last 6h added, not the week's average", () => {
  // 30% by hour 36, then 6% over the last 6h: 24%/day, 52% left lasts 52h
  const u = {...at(48, 50), history: []};
  u.history = [line(16, 10, u), line(42, 44, u), line(45, 47, u)];
  const p = pace(u, now);
  assertEquals(Math.round(p.rate * 10) / 10, 24);
  assertEquals(p.out, now + 52 * H);
  // 52% over the 118h to the reset is 10.6%/day, and 24 is 2.3 times that
  assertEquals(p.ratio.toFixed(1), "2.3");
});

Deno.test("pace: with no history the 6h rate is the average", () => {
  const p = pace(at(50, 42), now);
  assertEquals(Math.round(p.rate * 1e6), Math.round(50 * 24 / 42 * 1e6));
});

Deno.test("pace: an older number written late, or last week's, does not pull it down", () => {
  const u = {...at(48, 50), history: []};
  u.history = [line(42, 44, u), line(47, 46, u), line(20, 47, u),
    {at: now - H, used: 99, resetsAt: u.resetsAt - WEEK}];
  assertEquals(pace(u, now).used, 48);
  assertEquals(Math.round(pace(u, now).rate * 1e6) / 1e6, 6 * 4);
});

Deno.test("pace: nothing added in the last 6h is 0%/day and never runs out", () => {
  const u = {...at(48, 60), history: []};
  u.history = [line(48, 40, u)];
  const p = pace(u, now);
  assertEquals([p.rate, p.end, p.out], [0, 48, null]);
  assertEquals(/^usage 48% \(0\.0x pace\)$/.test(usageLine(u, now).text), true);
});

Deno.test("readHistory: one sample per line, five_hour dropped, junk skipped", async () => {
  const dir = await Deno.makeTempDir();
  assertEquals(readHistory(`${dir}/none`), []);
  await Deno.writeTextFile(`${dir}/log`,
    "1791400418 48 1791824400 8 1791411600\nhalf\n1791400500 50.5 1791824400 \n");
  assertEquals(readHistory(`${dir}/log`), [
    {at: 1791400418000, used: 48, resetsAt: 1791824400000},
    {at: 1791400500000, used: 50.5, resetsAt: 1791824400000}]);
  await Deno.remove(dir, {recursive: true});
});
