import {assertEquals} from "jsr:@std/assert";
import {byDay, pace, readHistory, readUsage, usageLine, usedNow, weekSamples} from "./usage.js";

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
  assertEquals(/^usage 50% \(3\.0x 1h, 3\.0x 3h pace - out \w{3} \d\d?[ap]m\)$/.test(out.text), true);
  assertEquals(/^usage 20% \(0\.[23]x 1h, 0\.[23]x 3h pace\)$/.test(fine.text), true);
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

Deno.test("pace: the rate is what the last 1h added, not the week's average", () => {
  // 44% by hour 44, 46% at 48, then 2% over the last 2h, 1% over the last 1h: 24%/day, 52% left lasts 52h
  const u = {...at(48, 50), history: []};
  u.history = [line(16, 10, u), line(44, 44, u), line(46, 48, u)];
  const p = pace(u, now);
  assertEquals(Math.round(p.rate * 10) / 10, 24);
  assertEquals(p.out, now + 52 * H);
  // 52% over the 118h to the reset is 10.6%/day, and 24 is 2.3 times that
  assertEquals(p.ratio.toFixed(1), "2.3");
  // over 3h it is 2.5% from 45.5 at hour 47, 20%/day, 1.9 times
  assertEquals(pace(u, now, 3 * H).ratio.toFixed(1), "1.9");
  assertEquals(/^usage 48% \(2\.3x 1h, 1\.9x 3h pace - out /.test(usageLine(u, now).text), true);
});

Deno.test("pace: with no history the 1h rate is the average", () => {
  const p = pace(at(50, 42), now);
  assertEquals(Math.round(p.rate * 1e6), Math.round(50 * 24 / 42 * 1e6));
});

Deno.test("pace: an older number written late, or last week's, does not pull it down", () => {
  const u = {...at(48, 50), history: []};
  u.history = [line(42, 44, u), line(46, 47.5, u), line(20, 48, u),
    {at: now - H, used: 99, resetsAt: u.resetsAt - WEEK}];
  assertEquals(pace(u, now).used, 48);
  assertEquals(Math.round(pace(u, now).rate * 1e6) / 1e6, 6 * 4);
});

Deno.test("pace: nothing added in the last 1h is 0%/day and never runs out", () => {
  const u = {...at(48, 60), history: []};
  u.history = [line(48, 40, u)];
  const p = pace(u, now);
  assertEquals([p.rate, p.end, p.out], [0, 48, null]);
  assertEquals(/^usage 48% \(0\.0x 1h, 0\.0x 3h pace\)$/.test(usageLine(u, now).text), true);
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

// nadya's ccx-usage.log, 2026-10-12 to 13: 10% until 00:28, the counter reset to 0 under the
// same resets_at, and at 07:12 one instance writing its older 10 with no five_hour
const RESET_LOG = `1791858581 8 1792429200 8 1791865200
1791859290 8 1792429200 9 1791865200
1791859587 9 1792429200 9 1791865200
1791861075 9 1792429200 10 1791865200
1791861401 9 1792429200 11 1791865200
1791861577 9 1792429200 12 1791865200
1791861758 10 1792429200 12 1791865200
1791861781 10 1792429200 13 1791865200
1791863606 10 1792429200 14 1791865200
1791865709 10 1792429200 0 1791883200
1791877504 0 1792429200 0 1791895200
1791889976 10 1792429200
1791889985 0 1792429200 0 1791895200
1791889986 0 1792429200 1 1791895200
1791890149 0 1792429200 2 1791895200
`;

async function resetUsage(used, lines = RESET_LOG) {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/log`, lines);
  const history = readHistory(`${dir}/log`);
  await Deno.remove(dir, {recursive: true});
  return {used, resetsAt: 1792429200_000, at: 0, history};
}

Deno.test("weekSamples: a confirmed drop is a reset, the lone stale 10 after it is not", async () => {
  const now = 1791890400_000, u = await resetUsage(0);
  const s = weekSamples(u, now);
  assertEquals(s.drops, [{at: 1791877504_000, by: 10}]);
  assertEquals(s.some((x) => x.at === 1791889976_000), false);
  assertEquals(usedNow(s), 0);
  const p = pace(u, now);
  assertEquals([p.used, p.rate, p.end], [0, null, null]);
  assertEquals(usageLine(u, now).text, "usage 0%");
  // the days still add up what was used before the reset
  const days = byDay(u, now);
  assertEquals(days.at(-1).used, 0);
  assertEquals(Math.round(days.reduce((n, d) => n + d.added, 0)), 10);
});

Deno.test("weekSamples: a file still saying 10 after the reset does not put it back", async () => {
  const now = 1791890400_000;
  assertEquals(pace(await resetUsage(10), now).used, 0);
  // and usage after the reset counts from 0, with a rate
  const u = await resetUsage(3, `${RESET_LOG}1791890200 3 1792429200 2 1791895200\n`);
  const p = pace(u, now);
  assertEquals(p.used, 3);
  assertEquals(p.rate > 0, true);
});

Deno.test("weekSamples: one low reading between highs is an older number, not a reset", async () => {
  const lines = `1791858581 8 1792429200 8 1791865200
1791859290 9 1792429200 9 1791865200
1791859587 8 1792429200 9 1791865200
1791861075 9 1792429200 10 1791865200
`;
  const s = weekSamples(await resetUsage(9, lines), 1791862000_000);
  assertEquals([s.drops, usedNow(s)], [[], 9]);
});
