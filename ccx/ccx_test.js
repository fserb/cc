// `deno test -A --ext=js ccx_test.js`. Nothing here touches live state: no discover(), no
// tmux, no ~/.claude. The library is imported, the renderer is driven as a subprocess, and
// the icon is pure.

import {fmtAge, Instance, IS_CLAUDE, IS_PRINT, openSubscriptions, paneState, processes, StateClock,
  summaryOf, waitsOn} from "../host/claudes.js";
import {fuzzy, NUMBERS, PALETTE, rank, SORTS, STATE} from "../host/view.js";
import {baseFromSettings, Online, pickBase} from "../host/online.js";

// assertions

function ok(cond, what) {
  if (!cond) throw new Error(what);
}

function eq(got, want, what) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`${what}: got ${g}, want ${w}`);
}

function near(got, want, eps, what) {
  if (!(Math.abs(got - want) <= eps)) {
    throw new Error(`${what}: got ${got}, want ${want} +/- ${eps}`);
  }
}

// the fixtures

let nextPid = 100;
const row = (state, since, shortPath, summary = "", pid = nextPid++) =>
  ({state, since, shortPath, summary, pid});

// written out of Unicode's EastAsianWidth, not copied from the renderer, so a bug in its
// table is not also a bug here. Ambiguous counts NARROW, which is how kitty draws it
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯！-｠￠-￦]/u;

const width = (s) =>
  [...s].reduce((n, c) => n + (WIDE.test(c) || c.codePointAt(0) >= 0x1f300 ? 2 : 1), 0);

// fuzzy

Deno.test("fuzzy: a subsequence matches, and a missing character does not", () => {
  ok(fuzzy("wrng", "~/prj/wrangler"), "wrng should find ~/prj/wrangler");
  eq(fuzzy("zq", "~/ai/ccx"), null, "a character not in the hay");
  eq(fuzzy("xc", "~/ai/ccx"), null, "the right characters in the wrong order");
  eq(fuzzy("", "~/ai/ccx"), {score: 0, idx: []}, "an empty needle matches everything");
});

Deno.test("fuzzy: wrng lands on the letters of wrangler", () => {
  //             0123456789...
  const hay = "~/prj/wrangler";
  eq(fuzzy("wrng", hay).idx, [6, 7, 9, 10], "idx");
  eq([...fuzzy("wrng", hay).idx].map((i) => hay[i]).join(""), "wrng", "the matched text");
  // 6 to reach the w, x1 because a `/` precedes it, then 1 skipped `a` inside a word at x2
  eq(fuzzy("wrng", hay).score, 8, "score");
});

Deno.test("fuzzy: cx collapses onto the TRAILING cx of ~/ai/ccx", () => {
  const hay = "~/ai/ccx";      // indices 5, 6, 7 are c, c, x
  eq(fuzzy("cx", hay).idx, [6, 7], "the backward pass must take the second c, not the first");
});

Deno.test("fuzzy: the hay is matched case-insensitively", () => {
  eq(fuzzy("cx", "~/AI/CCX").idx, [6, 7], "upper case hay");
  // the needle is not lowered here: both UIs lower it before they call
  eq(fuzzy("CX", "~/ai/ccx"), null, "the caller owns lowering the needle");
});

Deno.test("fuzzy: a skipped character costs 2, or 1 at a word start", () => {
  eq(fuzzy("ab", "a-b").score, 1, "the skipped character is a word boundary");
  eq(fuzzy("ab", "axb").score, 2, "the skipped character is inside a word");
});

Deno.test("fuzzy: a match at a path-segment head beats one buried mid-word", () => {
  const head = fuzzy("w", "~/prj/-w").score;     // the w follows a non-alphanumeric
  const buried = fuzzy("w", "~/prj/xw").score;   // the w follows a letter
  eq(head, 7, "head of a segment: 7 skipped cells at x1");
  eq(buried, 14, "mid-word: the same 7 cells at x2");
  ok(head < buried, "lowest score wins, so the segment head must rank first");
});

Deno.test("fuzzy: a prefix costs nothing", () => {
  eq(fuzzy("~/a", "~/ai/ccx"), {score: 0, idx: [0, 1, 2]}, "an exact prefix");
});

// rank

Deno.test("rank: state puts wait before busy before hold before free", () => {
  const rows = [row("free", 0, "~/a"), row("hold", 0, "~/d"), row("busy", 0, "~/b"),
    row("wait", 0, "~/c")];
  eq(rank(rows, "", "state").map((i) => i.state), ["wait", "busy", "hold", "free"],
    "state order");
});

Deno.test("rank: within a state the one stuck there longest goes on top", () => {
  const rows = [
    row("wait", 500, "~/new"), row("wait", 100, "~/old"), row("wait", 300, "~/mid"),
  ];
  eq(rank(rows, "", "state").map((i) => i.shortPath), ["~/old", "~/mid", "~/new"],
    "smallest `since` first: that is the oldest transition");
});

Deno.test("rank: path sorts by code point, not by locale", () => {
  const rows = [row("wait", 0, "~/apple"), row("wait", 0, "~/Banana")];
  eq(rank(rows, "", "path").map((i) => i.shortPath), ["~/Banana", "~/apple"],
    "B is 0x42 and a is 0x61");
  // the two orders really do differ, so this is not a coincidence
  ok("~/apple".localeCompare("~/Banana") < 0,
    "localeCompare would have put apple first; code point must not");
});

Deno.test("rank: path breaks a tie on pid", () => {
  const rows = [row("wait", 0, "~/same", "", 50), row("busy", 0, "~/same", "", 7)];
  eq(rank(rows, "", "path").map((i) => i.pid), [7, 50], "lower pid first");
});

Deno.test("rank: a needle outranks the sort", () => {
  const good = row("free", 0, "~/ai/ccx");        // scores 6 on "ccx"
  const worse = row("wait", 0, "~/ai/c-c-x");     // scores 8: two skipped characters
  eq(rank([good, worse], "", "state").map((i) => i.state), ["wait", "free"],
    "with no needle the wait row is first");
  eq(rank([good, worse], "ccx", "state").map((i) => i.shortPath), ["~/ai/ccx", "~/ai/c-c-x"],
    "with a needle the closer match is first, whatever its state");
});

Deno.test("rank: a needle drops what does not match", () => {
  const rows = [row("wait", 0, "~/ai/ccx"), row("wait", 0, "~/blah")];
  eq(rank(rows, "ccx", "state").map((i) => i.shortPath), ["~/ai/ccx"], "one survivor");
  eq(rank(rows, "zzz", "state"), [], "nothing matches");
});

Deno.test("rank: ties fall back to the sort", () => {
  // identical text, so identical scores; only the sort can order them
  const free = row("free", 0, "~/ai/ccx", "", 1);
  const wait = row("wait", 0, "~/ai/ccx", "", 2);
  eq(rank([free, wait], "ccx", "state").map((i) => i.pid), [2, 1], "state breaks the tie");
  eq(rank([free, wait], "ccx", "path").map((i) => i.pid), [1, 2], "path breaks it on pid");
});

Deno.test("rank: the needle matches the summary as well as the path", () => {
  const rows = [row("wait", 0, "~/x", "reorganize the skills tree"), row("wait", 0, "~/y")];
  eq(rank(rows, "skills", "state").map((i) => i.shortPath), ["~/x"], "matched on summary");
});

Deno.test("rank: the input list is not reordered", () => {
  const rows = [row("free", 0, "~/a"), row("wait", 0, "~/b")];
  const before = rows.map((i) => i.shortPath);
  rank(rows, "", "state");
  eq(rows.map((i) => i.shortPath), before, "rank must copy before it sorts");
});

Deno.test("SORTS is the two sorts the UIs cycle", () => {
  eq(SORTS, ["state", "path"], "SORTS");
  eq(NUMBERS, "1234567890", "the digits label the first ten rows in draw order");
});

// fmtAge etc

Deno.test("fmtAge: seconds, then minutes, then hours", () => {
  eq([0, 1, 59, 60, 61, 3599, 3600, 7199, 86400].map(fmtAge),
    ["0s", "1s", "59s", "1m", "1m", "59m", "1h", "1h", "24h"], "fmtAge");
  eq(fmtAge(-5), "0s", "a clock skew must not print a negative age");
});

Deno.test("Instance: shortPath abbreviates HOME and carries the tab", () => {
  const home = Deno.env.get("HOME");
  eq(new Instance({path: `${home}/ai/ccx`}).shortPath, "~/ai/ccx", "HOME becomes ~");
  eq(new Instance({path: `${home}/ai/ccx`, tab: "2"}).shortPath, "~/ai/ccx:2",
    "the tmux window index is appended only when there is one");
  eq(new Instance({path: `${home}/ai/ccx`, tab: "2", name: "rex"}).shortPath, "~/ai/ccx:rex",
    "the claude's name stands in for the index");
  eq(new Instance({path: `${home}/ai/ccx`, name: "rex"}).shortPath, "~/ai/ccx",
    "a name alone appends nothing");
  eq(new Instance({path: "/tmp/x"}).shortPath, "/tmp/x", "a path outside HOME is untouched");
  eq(new Instance({}).shortPath, "?", "no path at all");
});

Deno.test("Instance: match is kitty's pid: form, or null with no kitty ancestor", () => {
  eq(new Instance({kittyPid: "4242"}).match, "pid:4242", "the direct child of kitty");
  eq(new Instance({}).match, null, "nothing to match on");
});

// the palette rule

// WCAG relative luminance: linearize each sRGB channel, then 0.2126/0.7152/0.0722
function luminance(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => lin(c / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

Deno.test("colors: the documented luminances are what the hexes are", () => {
  near(luminance(STATE.wait.color), 0.69, 0.005, "wait gold #ffd500");
  near(luminance(PALETTE.text), 0.68, 0.005, "the wait row's summary #d6d6dc");
  near(luminance(STATE.busy.color), 0.39, 0.005, "busy #93aeaa");
  near(luminance(STATE.hold.color), 0.23, 0.005, "hold #8a7f9c");
  near(luminance(PALETTE.idle), 0.23, 0.005, "every other summary #82828a");
  near(luminance(STATE.free.color), 0.12, 0.005, "free #626262");
  near(luminance(PALETTE.dim), 0.12, 0.005, "the number and age columns #626262");
});

Deno.test("colors: nothing on either screen is brighter than the gold", () => {
  const gold = luminance(PALETTE.gold);
  eq(PALETTE.gold, STATE.wait.color, "the wait label and the gold are the same color");
  for (const [name, hex] of Object.entries(PALETTE)) {
    ok(luminance(hex) <= gold + 1e-12, `PALETTE.${name} ${hex} is brighter than the gold`);
  }
  for (const [name, {color}] of Object.entries(STATE)) {
    ok(luminance(color) <= gold + 1e-12, `STATE.${name} ${color} is brighter than the gold`);
  }
});

Deno.test("colors: the state labels are 6 cells, which is the state column's width", () => {
  for (const [name, {label}] of Object.entries(STATE)) {
    eq(width(label), 6, `${name} label "${label}" must fill the 6-wide state cell exactly`);
  }
});

// the frame
// `ccx` cannot be imported: --ext is for the entry point only, and the module runs the CLI
// and calls Deno.exit() on load, so it is driven as a subprocess. Frames are cached, one
// process per (cols, rows, flags) however many tests read it

const CCX = new URL("./ccx", import.meta.url).pathname;
const FRAMES = new Map();

async function snapshot(...args) {
  const key = args.join(" ");
  if (!FRAMES.has(key)) {
    const {code, stdout, stderr} = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--ext=js", CCX, "--snapshot", ...args],
    }).output();
    const out = new TextDecoder().decode(stdout);
    if (code !== 0) {
      throw new Error(`ccx --snapshot ${key} exited ${code}: ` +
        new TextDecoder().decode(stderr));
    }
    FRAMES.set(key, out.replace(/\n$/, "").split("\n"));
  }
  return FRAMES.get(key);
}

// one entry per display cell: a two-cell character owns its cell and an empty one after it
function cellsOf(line) {
  const out = [];
  for (const c of line) {
    out.push(c);
    if (width(c) === 2) out.push("");
  }
  return out;
}

const at = (line, n, len = 1) => cellsOf(line).slice(n, n + len).join("");

// 0-based display cells, the table body's own positions plus the one-cell left margin
const NUM = 2, STATE_COL = 5, FOR = 13, PATH = 20, SUMMARY = 48;
const PATH_W = 26, SUMMARY_W = 50;

// SAMPLE in `ccx` after rank(): waits oldest-first, then busys, then hold, then free. Mirrored here
// on purpose, so changing the fixture fails loudly instead of weakening the test
const ROWS = [
  ["● wait", "5m", "~/prj/kanji", "日本語のタイトル in a session title"],
  ["● wait", "42s", "~/ai/ccx", "port ccx from python to deno"],
  ["◆ wait", "7s", "~/blah", "reorganize the skills tree"],
  ["◐ busy", "25m", "~/ai/ccx:2", "inline the bell and play it from memory"],
  ["◐ busy", "3m", "~/prj/wrangler", "wrangler config for the edge worker"],
  ["◐ busy", "1m", "~/prj/a-very-long-director",
    "a summary that is definitely longer t"],                // both cropped, hard
  ["○ hold", "15m", "~/web/arcade", "PS2 blend modes, holding builds for a bench"],
  ["◌ free", "2h", "~/web/blob2", ""],
];
const HEAD = 3;                 // bar, rule, header, then the rows

Deno.test("snapshot: the content sits at cells 2, 5, 13, 20 and 48", async () => {
  const frame = await snapshot("100x14", "plain");
  eq(at(frame[2], STATE_COL, 5), "state", "the state header");
  eq(at(frame[2], FOR, 3), "for", "the for header");
  eq(at(frame[2], PATH, 4), "path", "the path header");
  eq(at(frame[2], SUMMARY, 7), "summary", "the summary header");

  ROWS.forEach(([label, age, path, summary], n) => {
    const line = frame[HEAD + n];
    eq(at(line, NUM), NUMBERS[n], `row ${n}: the digit`);
    eq(at(line, STATE_COL, 6), label, `row ${n}: the state cell`);
    eq(at(line, FOR, age.length), age, `row ${n}: the age`);
    eq(at(line, PATH, width(path)), path, `row ${n}: the path`);
    const shown = width(summary) > SUMMARY_W ? summary.slice(0, SUMMARY_W) : summary;
    eq(at(line, SUMMARY, width(shown)), shown, `row ${n}: the summary`);
  });
});

Deno.test("snapshot: the gaps between the columns are two cells", async () => {
  const frame = await snapshot("100x14", "plain");
  for (const line of frame.slice(HEAD, HEAD + ROWS.length)) {
    for (const n of [1, 3, 4, 11, 12, 18, 19, 46, 47]) {
      eq(at(line, n), " ", `cell ${n} is a column gap or a margin`);
    }
  }
});

Deno.test("snapshot: the japanese row's summary starts where the ascii rows' do", async () => {
  const frame = await snapshot("100x14", "plain");
  const kanji = frame[HEAD];
  eq(at(kanji, SUMMARY, 2), "日", "the summary column, counted in cells");
  // 100 cells holding eight two-cell characters is 92 code points; counting UTF-16 units
  // would pad to 100 code points, 108 cells, and throw this row's summary out of line
  eq([...kanji].length, 92, "code points in the japanese row");
  eq(width(kanji), 100, "display cells in the japanese row");
});

Deno.test("snapshot: every line is exactly as wide as the screen", async () => {
  for (const size of ["100x14", "46x14", "200x14"]) {
    const cols = Number(size.split("x")[0]);
    for (const [n, line] of (await snapshot(size, "plain")).entries()) {
      eq(width(line), cols, `${size} line ${n} must not run off the right edge`);
    }
  }
});

Deno.test("snapshot: a path crops hard at 26 cells and a summary at 50", async () => {
  const frame = await snapshot("100x14", "plain");
  const line = frame[HEAD + 5];                 // the over-long fixture row
  eq(at(line, PATH, PATH_W), "~/prj/a-very-long-director", "26 cells of path, no more");
  eq(at(line, PATH + PATH_W), " ", "and then the column gap");
  eq(at(line, SUMMARY, SUMMARY_W), "a summary that is definitely longer than fifty dis",
    "50 cells of summary");
  eq(width(at(line, PATH, PATH_W)), PATH_W, "the path cell is full");
  eq(width(at(line, SUMMARY, SUMMARY_W)), SUMMARY_W, "the summary cell is full");
});

Deno.test("snapshot: cropping leaves no ellipsis anywhere", async () => {
  for (const size of ["100x14", "46x14"]) {
    for (const line of await snapshot(size, "plain")) {
      ok(!line.includes("…"), `${size}: a horizontal ellipsis in "${line.trim()}"`);
      ok(!line.includes("..."), `${size}: three dots in "${line.trim()}"`);
    }
  }
});

Deno.test("snapshot: the empty state is a note across the table, not in the state cell",
  async () => {
    const frame = await snapshot("100x14", "plain", "empty");
    const note = frame[HEAD];
    eq(at(note, STATE_COL, 19), "no claude instances",
      "the line starts at the state column and runs past its 6-wide cell uncropped");
    eq(at(note, STATE_COL - 1), " ", "nothing before it");
    eq(width(note), 100, "and it is still a full line");
  });

Deno.test("snapshot: a filter that matches nothing says so", async () => {
  const frame = await snapshot("100x14", "plain", "/zz");
  eq(at(frame[HEAD], STATE_COL, 27), "nothing matches that filter", "the note");
  ok(frame[0].includes("0 of 8"), `the bar counts the survivors: "${frame[0].trim()}"`);
});

Deno.test("snapshot: the usage line takes the bottom row and the count moves up", async () => {
  const frame = await snapshot("100x8", "plain", "usage=60@48");
  eq(frame.length, 8, "still 8 lines");
  eq(at(frame[6], STATE_COL, 6), "5 more", "one row less for the table");
  ok(/^ +usage 60% \(3\.8x 1h, 3\.8x 3h pace - out .*\) $/.test(frame[7]), `right aligned: ${frame[7]}`);
  eq(cellsOf(frame[7]).length, 100, "and exactly as wide as the screen");
});

Deno.test("snapshot: more rows than fit gets a count, not a scrollbar", async () => {
  const frame = await snapshot("100x8", "plain");
  eq(frame.length, 8, "the frame is exactly as tall as the screen");
  // 8 lines: bar, rule, header, 4 rows, and the last line says what is hidden
  eq(at(frame[7], STATE_COL, 6), "4 more", "4 of the 8 rows are not drawn");
  eq(at(frame[HEAD], NUM), "1", "the first row is still drawn");
});

Deno.test("snapshot: the toast takes the last line, right aligned", async () => {
  const frame = await snapshot("100x14", "plain", "toast");
  const last = frame[frame.length - 1];
  ok(last.trimEnd().endsWith("nothing to focus"), `the toast text: "${last.trim()}"`);
  eq(width(last), 100, "still a full line");
  eq((await snapshot("100x14", "plain")).at(-1).trim(), "",
    "without the flag that line is blank");
});

Deno.test("snapshot: a filter reorders and the digits follow the drawn order", async () => {
  const frame = await snapshot("100x14", "plain", "/ccx");
  eq(at(frame[HEAD], NUM), "1", "the first row is numbered 1");
  eq(at(frame[HEAD], PATH, 8), "~/ai/ccx", "the closest match is first");
  eq(at(frame[HEAD + 1], NUM), "2", "the second row is numbered 2");
});

Deno.test("online: the first source that holds a URL wins, and the default is Anthropic", () => {
  eq(pickBase("", "", ""), {url: "https://api.anthropic.com", from: "default"},
    "nothing set anywhere");
  eq(pickBase("", "", "http://env").from, "$ANTHROPIC_BASE_URL", "the environment");
  eq(pickBase("", "http://user", "http://env").from, "~/.claude/settings.json",
    "a user setting outranks the environment");
  eq(pickBase("http://managed", "http://user", "http://env").url, "http://managed",
    "a managed policy outranks both");
});

Deno.test("online: a trailing slash is dropped, or the probe asks for //v1/models", () => {
  eq(pickBase("", "", "http://proxy:4000/").url, "http://proxy:4000", "one slash");
  eq(pickBase("", "", "http://proxy:4000///").url, "http://proxy:4000", "three");
});

Deno.test("online: the URL is read out of a settings file's env block", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/settings.json`;
    await Deno.writeTextFile(path, JSON.stringify({env: {ANTHROPIC_BASE_URL: " http://x "}}));
    eq(baseFromSettings(path), "http://x", "trimmed");
    await Deno.writeTextFile(path, JSON.stringify({env: {}}));
    eq(baseFromSettings(path), "", "an empty env block");
    await Deno.writeTextFile(path, '{"env": {"ANTHROPIC_BASE_URL"');
    eq(baseFromSettings(path), "", "a file caught half-written reads as unset");
    eq(baseFromSettings(`${dir}/nope.json`), "", "a missing file too");
  } finally {
    await Deno.remove(dir, {recursive: true});
  }
});

Deno.test("online: the host is named only when it is not the default", () => {
  eq(new Online(pickBase("", "", "")).label, "offline", "nothing to disambiguate");
  eq(new Online(pickBase("", "", "http://127.0.0.1:4000")).label, "offline 127.0.0.1:4000",
    "an override is worth the cells it costs");
});

// a local server, so nothing here needs the network to pass
async function served(status, fn) {
  const server = Deno.serve({port: 0, hostname: "127.0.0.1", onListen: () => {}},
    () => new Response("{}", {status}));
  const {port} = /** @type {any} */ (server.addr);
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await server.shutdown();
  }
}

Deno.test("online: an answer is up, a 5xx is down, and nothing listening is down", async () => {
  for (const status of [200, 401, 404]) {
    const r = await served(status, (url) => new Online({url, from: "test"}).probe());
    eq([r.ok, r.note], [true, `HTTP ${status}`], `${status} is the server answering`);
  }
  for (const status of [500, 503]) {
    const r = await served(status, (url) => new Online({url, from: "test"}).probe());
    eq([r.ok, r.note], [false, `HTTP ${status}`], `${status} is not`);
  }
  // a port that was listening and is not any more, so this is a refusal and not a timeout
  const dead = await served(200, (url) => url);
  const r = await new Online({url: dead, from: "test"}).probe();
  eq(r.ok, false, "nothing listening");
  ok(r.note.startsWith("TypeError"), `a thrown fetch is reported: ${r.note}`);
});

Deno.test("online: two failures draw the slash, one success clears it", () => {
  const net = new Online({url: "http://x", from: "test"});
  ok(!net.offline, "a fresh one is not offline, so a start never flashes the slash");
  net.record(false);
  ok(!net.offline, "one failure is a dropped request, not an outage");
  net.record(false);
  ok(net.offline, "two consecutive failures");
  net.record(false);
  eq(net.fails, 2, "the count is capped, so a long outage still clears on one success");
  net.record(true);
  ok(!net.offline, "and it does");
});

Deno.test("online: a probe is due every 30s, or every 5s once one has failed", () => {
  const net = new Online({url: "http://x", from: "test"});
  ok(net.due(0), "never probed, so the first tick probes");
  net.last = 1000;
  ok(!net.due(1000 + 29_000), "29s after the last one");
  ok(net.due(1000 + 30_000), "30s after it");
  net.record(false);
  ok(!net.due(1000 + 4_000), "4s, having failed");
  ok(net.due(1000 + 5_000), "5s, having failed");
  net.busy = true;
  ok(!net.due(1000 + 60_000), "a probe still in flight is never overtaken");
});

Deno.test("snapshot: offline is written beside the counter, and keeps the key hints",
  async () => {
    const bar = (await snapshot("100x8", "plain", "offline"))[0];
    ok(bar.includes("offline  ·  3/8  ·  by state"), `the bar reads: ${bar.trim()}`);
    ok(bar.includes("^t chat"), "and 100 cells still has room for the keys");
    ok(!(await snapshot("100x8", "plain"))[0].includes("offline"), "nothing when it is up");
  });

// the two version-coupled scrapers
// a Claude Code screen and a Claude Code title, both undocumented and version-coupled:
// a rename is not caught anywhere else

const SPINNER_LINE = "✽ Working… (16m 29s · ↓ 54.6k tokens)";

Deno.test("processes: a failed ps throws for discover(), and is an empty table for the rest", async () => {
  const ps = (r) => () => Promise.resolve({out: "", err: "", ...r});
  const ok7372 = await processes(true, ps({code: 0, out: " 7372  7324 claude -n arcade-a\n"}));
  eq(ok7372.get(7372), [7324, "claude -n arcade-a"]);
  for (const r of [{code: -1, err: "Too many open files"}, {code: 143}, {code: 0}]) {
    let threw = "";
    await processes(true, ps(r)).catch((e) => threw = e.message);
    ok(threw.startsWith(`ps: exit ${r.code}: `), threw);
    eq((await processes(false, ps(r))).size, 0);
  }
});

Deno.test("IS_PRINT: -p, --print and the SDK's stream-json, not a TUI", () => {
  for (const cmd of ["claude -p hi", "claude --print hi", "/usr/bin/claude -p --input-format stream-json",
    "claude --output-format stream-json --verbose --input-format stream-json"]) ok(IS_PRINT.test(cmd), cmd);
  for (const cmd of ["claude", "claude -n piproxy-a", "claude --resume abc", "claude -n ccx-print", "claude -pfoo"])
    ok(!IS_PRINT.test(cmd), cmd);
});

Deno.test("IS_CLAUDE: argv0 or the local cli.js, not a path anywhere in the line", () => {
  for (const cmd of ["claude", "claude --resume", "/opt/homebrew/bin/claude",
    "node /Users/x/.claude/local/node_modules/.bin/cli.js"]) ok(IS_CLAUDE.test(cmd), cmd);
  for (const cmd of ["less ~/notes/claude", "vim /tmp/claude", "claudette",
    "tail -f /Users/x/.claude/local/cli.js.log"]) ok(!IS_CLAUDE.test(cmd), cmd);
});

// hold on a peer

// One transcript line each, shaped as 2.1.283 writes them.
function subscribed(name, ts) {
  const said = JSON.stringify({success: true, message:
    `“Ask” → ${name}; queued there\nSubscribed — you will get one notice here when ` +
    `"${name}" is next idle (or exits), provided that session runs in the same class`});
  return JSON.stringify({type: "user", timestamp: ts, message: {role: "user", content: [
    {type: "tool_result", tool_use_id: "toolu_1", content: [{type: "text", text: said}]}]}});
}

function peerSaid(name, body, ts) {
  return JSON.stringify({type: "user", timestamp: ts, message: {role: "user", content: body},
    origin: {kind: "peer", from: "uds:/tmp/cc-socks/1.sock", name, body}});
}

Deno.test("openSubscriptions: a subscription stays open until that peer says anything", () => {
  const log = [
    '{"partial line from the tail cut',
    subscribed("arcade-eb", "2026-09-27T20:00:00.000Z"),
    subscribed("arcade-2e", "2026-09-27T20:01:00.000Z"),
    peerSaid("arcade-2e", "", "2026-09-27T20:05:00.000Z"),
  ].join("\n");
  eq(openSubscriptions(log), {"arcade-eb": Date.parse("2026-09-27T20:00:00Z") / 1000},
    "the empty idle notice from arcade-2e closes its subscription and nothing else");
  eq(openSubscriptions(peerSaid("arcade-eb", "hi", "2026-09-27T19:00:00Z") + "\n" +
    subscribed("arcade-eb", "2026-09-27T20:00:00Z")).hasOwnProperty("arcade-eb"), true,
    "a message from before the subscription does not close it");
  eq(openSubscriptions(subscribed("uds:/tmp/cc-socks/1.sock", "2026-09-27T20:00:00Z") + "\n" +
    peerSaid("arcade-eb", "", "2026-09-27T20:05:00Z")), {},
    "subscribed by socket, answered under a name: origin.from is the socket");
  const queued = JSON.stringify({type: "attachment", timestamp: "2026-09-27T20:05:00Z",
    attachment: {type: "queued_command", prompt: '<cross-session-message ' +
      'from="uds:/tmp/cc-socks/1.sock" from-name="arcade-eb" from-mode="prompting">\nok\n' +
      '</cross-session-message>'}});
  eq(openSubscriptions(subscribed("arcade-eb", "2026-09-27T20:00:00Z") + "\n" + queued), {},
    "a reply that arrived mid-turn, logged as a queued_command attachment");
  for (const text of [
    '[Cross-session idle notice] "arcade-eb", which you asked to be notified about, is idle now',
    '[Cross-session idle notice] "arcade-eb" is not holding your idle subscription (x), so',
    '[Cross-session idle notice] No idle signal arrived from "arcade-eb" within 6 hours; the',
  ]) {
    const notice = JSON.stringify({type: "user", timestamp: "2026-09-27T20:05:00Z",
      message: {role: "user", content: text}});
    eq(openSubscriptions(subscribed("arcade-eb", "2026-09-27T20:00:00Z") + "\n" + notice), {},
      `the harness's own notice: ${text.slice(29, 60)}`);
  }
});

Deno.test("waitsOn: only while the peer has not changed status since we went idle", () => {
  const subs = {"arcade-eb": 100};
  const me = {status: "idle", statusUpdatedAt: 200_000};
  const peer = (status, at) => [{name: "arcade-eb", status, statusUpdatedAt: at}];
  eq(waitsOn(me, peer("busy", 150_000), subs), "arcade-eb", "busy since before our idle");
  eq(waitsOn(me, peer("shell", 150_000), subs), "arcade-eb", "its own background shell");
  eq(waitsOn(me, peer("idle", 150_000), subs), "", "idle means the notice has gone out");
  eq(waitsOn(me, peer("busy", 250_000), subs), "",
    "busy again after we went idle: it went idle in between, and the notice was lost");
  eq(waitsOn(me, [], subs), "", "gone: it exited, which also sends the notice");
  eq(waitsOn(me, [{name: "x", messagingSocketPath: "/tmp/cc-socks/9.sock", status: "busy",
    statusUpdatedAt: 1}], {"uds:/tmp/cc-socks/9.sock": 1}), "uds:/tmp/cc-socks/9.sock",
    "a peer addressed by socket rather than name");
});

Deno.test("paneState: an empty capture is not a state", () => {
  eq(paneState(""), "", "nothing was read, so the caller keeps the previous state");
  eq(paneState("\n\n   \n\t\n"), "", "blank lines are nothing too");
});

Deno.test("paneState: the spinner line is busy, with or without the timer", () => {
  eq(paneState(SPINNER_LINE), "busy", "the full spinner line");
  // ~3% of captures during a turn catch the label before the parenthetical is drawn
  eq(paneState("✽ Beboppin'…"), "busy", "no timer yet");
  for (const glyph of ["·", "✢", "✳", "✶", "✻", "✽", "*"]) {
    eq(paneState(`${glyph} Thinking…`), "busy", `the spinner cycles through ${glyph}`);
  }
});

Deno.test("paneState: tool output that looks like the spinner is not busy", () => {
  eq(paneState("⏺ Calling chrome-devtools 5 times…"), "wait",
    "the glyph anchor is what keeps tool output out");
  eq(paneState("some answer\nesc to interrupt"), "wait",
    "`esc to interrupt` is printed by idle panes too, verified live");
  eq(paneState("✽ Working (16m 29s)"), "wait", "a spinner glyph with no ellipsis is not one");
});

Deno.test("paneState: it judges from the bottom 8 lines, not the scrollback", () => {
  const filler = (n) => Array(n).fill("a line of transcript").join("\n");
  eq(paneState(`${SPINNER_LINE}\n${filler(7)}`), "busy", "7 lines below: still in the window");
  eq(paneState(`${SPINNER_LINE}\n${filler(8)}`), "wait", "8 lines below: out of the window");
  eq(paneState(`${SPINNER_LINE}\n${filler(20)}`), "wait",
    "a pane that merely quotes the spinner 20 lines up must not read as busy");
  // blank lines are dropped before the window is taken, so they do not push it out
  eq(paneState(`${SPINNER_LINE}\n${Array(20).fill("").join("\n")}`), "busy",
    "blank lines do not count against the 8");
});

Deno.test("paneState: the banner is free until a reply is under it", () => {
  eq(paneState("Claude Code v2.1.252\n\n cwd: ~/ai/ccx"), "free", "a freshly cleared session");
  eq(paneState("Claude Code v2.1.252\n⏺ an answer\n> "), "wait",
    "walking up from the bottom hits the answer first, so this is a conversation");
  eq(paneState("Claude Code without a version"), "wait", "the banner needs its version number");
  eq(paneState("> "), "wait", "everything else is yours");
});

Deno.test("summaryOf: the glyph comes off and the literal default becomes nothing", () => {
  eq(summaryOf("✳ port ccx from python to deno"), "port ccx from python to deno", "a title");
  eq(summaryOf("Claude Code"), "", "the literal default is not a title");
  eq(summaryOf("✻ Claude Code"), "", "nor is it with the glyph in front");
  eq(summaryOf(""), "", "nothing");
  eq(summaryOf("   spaced out   "), "spaced out", "trimmed at both ends");
  eq(summaryOf("✽ 日本語のタイトル"), "日本語のタイトル", "the glyph strip is not ascii-only");
  eq(summaryOf("Claude Code review of the auth flow"),
    "Claude Code review of the auth flow", "only the exact literal is dropped");
});

// the cursor row, in full color
// the one part of the frame `plain` cannot show, the fill being a background that `plain`
// strips; `cursor=N` and `offset=N` are what make it reachable

const ESCAPE = "\x1b";          // built, not a regex literal: deno lint's no-control-regex
const SGR = new RegExp(`${ESCAPE}\\[([0-9;]*)m`, "g");

// one {bg, fg, bold} per display cell: a run is a reset, a background, optionally a
// foreground and a bold, then text, so state carries forward to the next reset
function attrs(line) {
  const cells = [];
  let bg = "", fg = "", bold = false, at = 0;
  SGR.lastIndex = 0;
  for (;;) {
    const m = SGR.exec(line);
    for (const c of line.slice(at, m ? m.index : line.length)) {
      cells.push({bg, fg, bold});
      if (width(c) === 2) cells.push({bg, fg, bold});      // the continuation cell
    }
    if (!m) return cells;
    const p = m[1];
    if (p === "0" || p === "") [bg, fg, bold] = ["", "", false];
    else if (p === "1") bold = true;
    else if (p.startsWith("48;2;")) bg = p.slice(5);
    else if (p.startsWith("38;2;")) fg = p.slice(5);
    at = SGR.lastIndex;
  }
}

const FILL = "42;30;56";        // PALETTE.cursor #2a1e38
const BLACK = "0;0;0";          // PALETTE.bg, which the margins keep
const GOLD = "255;213;0";       // STATE.wait.color and STATE.ask.color
const TEAL = "147;174;170";     // STATE.busy.color #93aeaa
const DIM = "98;98;98";         // PALETTE.dim, the number and age columns
const MAUVE = "184;160;190";    // PALETTE.mauve, the path
const TEXT = "214;214;220";     // PALETTE.text, a wait row's summary
const IDLE = "130;130;138";     // PALETTE.idle, every other summary

const filled = (frame) => frame.filter((l) => attrs(l).some((c) => c.bg === FILL));

Deno.test("cursor: exactly one row is filled, and it is the ranked index", async () => {
  const frame = await snapshot("100x8", "cursor=2", "offset=1");
  eq(filled(frame).length, 1, "one row, never two, never the bar or the header");
  eq(frame.indexOf(filled(frame)[0]), HEAD + 2 - 1,
    "ranked index 2 drawn from offset 1 is the second row on screen");
  for (const n of [0, 1, 2]) {
    ok(!attrs(frame[n]).some((c) => c.bg === FILL), `line ${n} is chrome, not a row`);
  }
});

Deno.test("cursor: the fill covers the whole table body, and the margins stay black",
  async () => {
    const cells = attrs(filled(await snapshot("100x8", "cursor=2", "offset=1"))[0]);
    eq(cells.length, 100, "one entry per cell of a 100-wide line");
    eq(cells[0].bg, BLACK, "the one-cell left margin is not part of the row");
    eq(cells[99].bg, BLACK, "nor is the right pad");
    for (let n = 1; n <= 98; n++) {
      eq(cells[n].bg, FILL, `body cell ${n} must be filled, gaps between columns included`);
      ok(cells[n].bold, `body cell ${n} is bold`);
    }
  });

Deno.test("cursor: every cell keeps its own foreground under the fill", async () => {
  const wait = attrs(filled(await snapshot("100x8", "cursor=2", "offset=1"))[0]);
  eq(wait[STATE_COL].fg, GOLD, "the selected wait row is still yellow: the rule itself");
  eq(wait[NUM].fg, DIM, "the digit");
  eq(wait[FOR].fg, DIM, "the age");
  eq(wait[PATH].fg, MAUVE, "the path");
  eq(wait[SUMMARY].fg, TEXT, "a wait row's summary is the bright one");

  // a busy row selected: different label color, different summary color, same fill
  const busy = attrs(filled(await snapshot("100x8", "cursor=3"))[0]);
  eq(busy[STATE_COL].fg, TEAL, "busy keeps its trace of teal when selected");
  eq(busy[SUMMARY].fg, IDLE, "and its summary stays the dim grey");
  eq(busy[STATE_COL].bg, FILL, "under the same fill");
});

Deno.test("cursor: an unselected row keeps the screen background", async () => {
  const frame = await snapshot("100x8", "cursor=2", "offset=1");
  const other = attrs(frame[HEAD]);            // ranked index 1, not the cursor
  for (let n = 0; n < 100; n++) {
    eq(other[n].bg, BLACK, `cell ${n} of an unselected row`);
    ok(!other[n].bold, `cell ${n} of an unselected row is not bold`);
  }
  eq(other[STATE_COL].fg, GOLD, "it is a wait row, so still gold, just not filled");
});

Deno.test("cursor: the fill is keyed on the ranked index, not the screen row", async () => {
  // scrolled past, so nothing on screen is the cursor and nothing is filled
  eq(filled(await snapshot("100x8", "cursor=0", "offset=2")).length, 0, "no row is filled");
});

Deno.test("offset: the table starts at the ranked index, and the digits follow it",
  async () => {
    const frame = await snapshot("100x8", "plain", "cursor=2", "offset=1");
    eq(at(frame[HEAD], PATH, 8), "~/ai/ccx", "ranked index 1 is drawn first");
    eq(at(frame[HEAD], NUM), "2", "the digit is the ranked position, not the screen row");
    eq(at(frame[HEAD + 1], NUM), "3", "and it keeps counting");
    // 8 ranked, 4 drawn, so 4 are not on screen: index 0 above and 5 to 7 below
    eq(at(frame[7], STATE_COL, 6), "4 more", "the count is what is not drawn, either end");
  });

Deno.test("cursor: the SGR constants above are PALETTE and STATE, not copied hexes", () => {
  const rgb = (hex) => {
    const n = Number.parseInt(hex.slice(1), 16);
    return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
  };
  eq(rgb(PALETTE.cursor), FILL, "the cursor fill");
  eq(rgb(PALETTE.bg), BLACK, "the screen background");
  eq(rgb(STATE.wait.color), GOLD, "wait");
  eq(rgb(STATE.ask.color), GOLD, "ask draws the other glyph in the same gold");
  eq(rgb(STATE.busy.color), TEAL, "busy");
  eq([rgb(PALETTE.dim), rgb(PALETTE.mauve)], [DIM, MAUVE], "the dim and mauve columns");
  eq([rgb(PALETTE.text), rgb(PALETTE.idle)], [TEXT, IDLE], "the two summary colors");
});

// the woke rule
// StateClock.update() shells out to nothing, so the woke rule is testable without a live
// discover()

const inst = (pid, state, extra = {}) =>
  new Instance({pid, state, statusSince: 0, lastWrite: 0, ...extra});

Deno.test("StateClock: first sight is not a transition, so startup is silent", () => {
  const clock = new StateClock();
  clock.update([inst(1, "wait"), inst(2, "wait"), inst(3, "busy")]);
  eq(clock.woke.length, 0, "however many sessions are already waiting");
});

Deno.test("StateClock: busy -> wait rings, and nothing else does", () => {
  const ring = (from, to) => {
    const clock = new StateClock();
    clock.update([inst(1, from)]);
    clock.update([inst(1, to)]);
    return clock.woke.map((i) => i.pid);
  };
  eq(ring("busy", "wait"), [1], "a turn ended, or a prompt came up");
  eq(ring("free", "wait"), [], "leaving the banner is you starting work, not the app");
  eq(ring("wait", "busy"), [], "you sent a turn");
  eq(ring("busy", "free"), [], "the session was cleared");
  eq(ring("wait", "wait"), [], "no change at all");
  eq(ring("free", "busy"), [], "work started in an empty session");
});

Deno.test("StateClock: two flipping in one pass is one ring", () => {
  const clock = new StateClock();
  clock.update([inst(1, "busy"), inst(2, "busy")]);
  clock.update([inst(1, "wait"), inst(2, "wait")]);
  eq(clock.woke.map((i) => i.pid), [1, 2], "both are in woke");
  // both UIs test `woke.length`, so two entries are still one sound
  ok(clock.woke.length > 0, "which the UIs read as: ring");
});

Deno.test("StateClock: woke is cleared each pass, not accumulated", () => {
  const clock = new StateClock();
  clock.update([inst(1, "busy")]);
  clock.update([inst(1, "wait")]);
  eq(clock.woke.length, 1, "the transition");
  clock.update([inst(1, "wait")]);
  eq(clock.woke.length, 0, "and the pass after it is silent");
});

Deno.test("StateClock: a state that could not be read carries the previous one forward",
  () => {
    const clock = new StateClock();
    clock.update([inst(1, "busy", {statusSince: 1000})]);
    clock.update([inst(1, "")]);          // an empty capture, or a tmux hiccup
    const [held] = clock.update([inst(1, "")]);
    eq(held.state, "busy", "an unreadable screen is not a transition");
    eq(held.since, 1000, "and it does not restart the clock");
    eq(clock.woke.length, 0, "a dropped poll must not ring for every running instance");
  });

Deno.test("StateClock: with nothing known at all, an unreadable state is wait", () => {
  const [first] = new StateClock().update([inst(1, "")]);
  eq(first.state, "wait", "the safe default: wait is what an unrecognized screen reads as");
});

Deno.test("StateClock: `since` is the record's transition, not the poll that saw it", () => {
  const clock = new StateClock();
  clock.update([inst(1, "busy", {statusSince: 1000})]);
  const [moved] = clock.update([inst(1, "wait", {statusSince: 1234})]);
  eq(moved.since, 1234, "statusUpdatedAt, which is the transition itself");
});

Deno.test("StateClock: `since` is carried while the state does not change", () => {
  const clock = new StateClock();
  clock.update([inst(1, "wait", {statusSince: 1000})]);
  // idle and shell both map to wait, so a flip between them keeps the earlier time
  const [same] = clock.update([inst(1, "wait", {statusSince: 9999})]);
  eq(same.since, 1000, "the state did not change, so neither did the clock");
});

Deno.test("StateClock: with no record, `since` seeds from the session log's mtime", () => {
  const [seeded] = new StateClock().update([inst(1, "wait", {lastWrite: 555})]);
  eq(seeded.since, 555, "logs are appended only on real messages");
  const now = Date.now() / 1000;
  const [blind] = new StateClock().update([inst(2, "wait")]);
  ok(Math.abs(blind.since - now) < 5, "and with neither, now");
});

Deno.test("StateClock.on: first sight, a change, a dialog, gone; nothing while still", () => {
  const clock = new StateClock("marx"), got = [];
  clock.on((evs) => got.push(evs.map((e) => [e.pid, e.from, e.to, e.asking])));
  clock.update([inst(1, "busy", {name: "a"}), inst(2, "wait")]);
  clock.update([inst(1, "busy", {name: "a"}), inst(2, "wait")]);
  clock.update([inst(1, "wait", {name: "a", asking: "permission"}), inst(2, "wait")]);
  clock.update([inst(1, "wait", {name: "a"})]);
  eq(got, [
    [[1, "", "busy", ""], [2, "", "wait", ""]],
    [[1, "busy", "wait", "permission"]],
    [[1, "wait", "wait", ""], [2, "wait", "gone", ""]],
  ]);
});

Deno.test("StateClock.on: events carry host, name and a rising seq; off() stops them", () => {
  const clock = new StateClock("marx"), got = [];
  const off = clock.on((evs) => got.push(...evs));
  clock.update([inst(1, "busy", {name: "a", sessionId: "s"})]);
  clock.update([]);
  off();
  clock.update([inst(1, "busy")]);
  eq(got.map((e) => [e.seq, e.host, e.name, e.sessionId, e.to, e.source]),
    [[1, "marx", "a", "s", "busy", "poll"], [2, "marx", "a", "s", "gone", "poll"]]);
});

Deno.test("StateClock.on: an event names the tmux pane and the summary, for `any is new`", () => {
  const clock = new StateClock("marx"), got = [];
  clock.on((evs) => got.push(...evs));
  clock.update([inst(1, "free", {session: "work", window: "2", paneIndex: "1", summary: "t",
    sessionId: "s"}), inst(2, "wait", {summary: "nadya", path: "/tmp"})]);
  eq(got.map((e) => [e.pane, e.summary, e.path]), [["work:2.1", "t", ""], ["", "", "/tmp"]],
    "no record, so the summary is the pane title and is left out");
});

Deno.test("StateClock: a pid that went away is first sight again when it returns", () => {
  const clock = new StateClock();
  clock.update([inst(1, "busy")]);
  clock.update([]);                       // the session exited, or one poll missed it
  clock.update([inst(1, "wait")]);
  eq(clock.woke.length, 0, "nothing remembers it was busy, so it cannot ring");
});

Deno.test("StateClock: a `since` of 0 means absent and must fall through", () => {
  // || and not ??: 0 and "" are how these fields say "absent", and ?? would take a
  // statusSince of 0 as 1970
  const [seeded] = new StateClock().update([inst(1, "wait", {statusSince: 0, lastWrite: 555})]);
  eq(seeded.since, 555, "first sight: a zero statusSince falls through to lastWrite");

  const clock = new StateClock();
  clock.update([inst(2, "busy", {statusSince: 1000})]);
  const [moved] = clock.update([inst(2, "wait", {statusSince: 0})]);
  ok(moved.since > 1e9, `a transition with no record time takes now, not 0: got ${moved.since}`);
});

// the chat view

// The frame goes through `--snapshot chat`, which draws CHAT_SAMPLE against a fixed `at`,
// since an age off the clock is not reproducible. Mirrored here the way ROWS mirrors SAMPLE.
const CHAT_HEAD = 2;            // bar, rule, then the conversation

Deno.test("chat: every line is exactly as wide as the screen", async () => {
  for (const box of ["100x22", "46x20", "60x8"]) {
    const frame = await snapshot("chat", box, "plain");
    const cols = Number(box.split("x")[0]);
    frame.forEach((line, n) => eq(width(line), cols, `line ${n} of ${box}`));
  }
});

Deno.test("chat: a header is the relative age, the sender and the recipient", async () => {
  const frame = await snapshot("chat", "100x22", "plain");
  eq(frame[CHAT_HEAD].trimEnd(), "   2h  ccx-ef → ccx-85", "age, from, to");
});

Deno.test("chat: the body wraps under its header rather than truncating", async () => {
  const frame = await snapshot("chat", "100x22", "plain");
  const body = frame.slice(CHAT_HEAD + 1, CHAT_HEAD + 4).map((l) => l.trimEnd());
  ok(body[0].startsWith("       you own ccx"), `indented past the age: ${body[0]}`);
  ok(body[2].endsWith("disk."), `the tail of a 190-character body is drawn: ${body[2]}`);
  eq(frame[CHAT_HEAD + 4].trim(), "", "one blank line before the next message");
});

Deno.test("chat: a word longer than the line is cut, and nothing is lost", async () => {
  const frame = await snapshot("chat", "46x40", "plain");
  const joined = frame.map((l) => l.trimEnd().replace(/^ {7}/, "")).join("");
  ok(joined.includes("/Users/fserb/ai/ccx/a-very-long-directory-name-that-does-not-fit-" +
    "on-one-line-at-all/deeper"), "every character of the path survives the cut");
});

Deno.test("chat: a newline in a body starts a new line", async () => {
  const frame = (await snapshot("chat", "100x22", "plain")).map((l) => l.trimEnd());
  const n = frame.findIndex((l) => l.endsWith("chat.js is in."));
  ok(n > 0, "the body stops where the newline was");
  ok(frame[n + 1].includes("the log is"), `and the rest is under it: ${frame[n + 1]}`);
});

Deno.test("chat: offset scrolls by line, and the bar stays put", async () => {
  const top = await snapshot("chat", "46x20", "plain");
  const down = await snapshot("chat", "46x20", "plain", "offset=3");
  eq(down[CHAT_HEAD], top[CHAT_HEAD + 3], "three lines of conversation went up");
  eq(down[0], top[0], "the bar does not scroll");
});

Deno.test("chat: an empty conversation says so, and counts zero", async () => {
  const frame = await snapshot("chat", "100x10", "plain", "empty");
  ok(frame[CHAT_HEAD].includes("nothing has been said in here yet"), `note: ${frame[2]}`);
  ok(frame[0].includes("0 msg"), `count: ${frame[0].trim()}`);
});

Deno.test("chat: the list's key hints name the key that opens it", async () => {
  const frame = await snapshot("100x14", "plain");
  ok(frame[0].includes("^t chat"), `the bar: ${frame[0].trim()}`);
});

// the target resolver, and the argument validation

// Both drive the script as a subprocess, for the reason the frame does. Every case here is
// decided before `ccx` looks at live state: `--resolve` runs against --snapshot's fixed
// rows, and each bad argument list below exits on its own validation ahead of discover().
// So this stays what the file header claims, and it sends no message to anybody.

async function ccx(...args) {
  const {code, stdout, stderr} = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--ext=js", CCX, ...args],
  }).output();
  const dec = new TextDecoder();
  return {code, out: dec.decode(stdout).trimEnd(), err: dec.decode(stderr).trimEnd()};
}

async function resolved(...args) {
  const {out} = await ccx("--resolve", ...args);
  return out ? out.split("\n") : [];
}

Deno.test("resolve: a pid picks that instance and nothing else", async () => {
  eq(await resolved("1002"), ["1002 blob2-7c ~/web/blob2"], "the pid is exact");
});

Deno.test("resolve: a name picks that instance and nothing else", async () => {
  eq(await resolved("kanji-90"), ["1005 kanji-90 ~/prj/kanji"], "the name is exact");
});

Deno.test("resolve: a fuzzy target matching two is the feature, not an error", async () => {
  eq(await resolved("ccx"), ["1000 ccx-e8 ~/ai/ccx", "1004 ccx-2f ~/ai/ccx:2"],
    "both ccx sessions");
});

Deno.test("resolve: the fuzzy match reaches the name as well as the path", async () => {
  eq(await resolved("wr3"), ["1001 wrangler-3a ~/prj/wrangler"],
    "wr3 is in the name and not in the path");
});

Deno.test("resolve: all is every instance, and self= leaves us out of it", async () => {
  eq((await resolved("all")).length, 8, "every row in the fixture");
  const rest = await resolved("all", "self=1002");
  eq(rest.length, 7, "one fewer");
  ok(!rest.some((l) => l.startsWith("1002 ")), `and it is not us: ${rest.join(" | ")}`);
});

Deno.test("resolve: the same instance named twice is one target", async () => {
  eq(await resolved("1005,kanji-90"), ["1005 kanji-90 ~/prj/kanji"],
    "a pid and a name for one session send it one message");
});

Deno.test("resolve: targets keep the order they were written in", async () => {
  eq(await resolved("1005,1000"),
    ["1005 kanji-90 ~/prj/kanji", "1000 ccx-e8 ~/ai/ccx"], "not re-sorted");
});

Deno.test("resolve: a target matching nothing is a miss, and the rest still resolve",
  async () => {
    eq(await resolved("nope,1000"), ["miss nope", "1000 ccx-e8 ~/ai/ccx"], "one of each");
  });

const BAD = [
  ["send"],                     // no target and nothing to say
  ["send", "ccx-e8"],           // a target and nothing to say
  ["send", "ccx-e8", "   "],    // whitespace is not a message
  ["user"],                     // the same three, for the same reason
  ["user", "ccx-e8"],
  ["user", "ccx-e8", "   "],
  ["user", "--force"],          // --force is not a target
  ["user", "--force", "ccx-e8"],
  ["goal"],                     // a target and its goal, as send
  ["goal", "ccx-e8"],
  ["new", "--goal"],            // --goal and no text
  ["chat", "foo"],              // chat takes --no-follow, or nothing
  ["--resolve"],                // no target
  ["--snapshot", "bogus"],
  ["focus"],                    // arity, which the command table checks
  ["nonesuch"],
];

Deno.test("validation: every bad argument list is a usage line and exit 2", async () => {
  for (const args of BAD) {
    const r = await ccx(...args);
    const what = `ccx ${args.join(" ")}`;
    eq(r.code, 2, `${what} should exit 2`);
    ok(r.err.startsWith("usage: ccx"), `${what}: stderr was ${JSON.stringify(r.err)}`);
    eq(r.out, "", `${what} should print nothing on stdout`);
  }
});

Deno.test("help: asking for it is stdout and 0, a bad argument list is stderr and 2",
  async () => {
    const asked = await ccx("help");
    eq(asked.code, 0, "`ccx help` is not an error");
    eq(asked.err, "", "and says nothing on stderr");
    ok(asked.out.startsWith("usage: ccx"), `stdout was ${JSON.stringify(asked.out)}`);
    // one text, two streams: every command the table dispatches is named in it
    for (const name of ["ps", "list", "doctor", "focus", "send", "user", "chat",
      "help"]) {
      ok(new RegExp(`^  ${name}\\b`, "m").test(asked.out), `${name} is not in the help`);
    }
    eq((await ccx("nonesuch")).err, asked.out, "and a bad command prints the same text");
    eq(await ccx(), asked, "`ccx` alone is `ccx help`");
  });

Deno.test("help: `ccx <command> --help` is that command's lines and runs nothing", async () => {
  // nadya-d's `ccx post --help` posted "--help" into cc's inbox (2026-10-19)
  for (const args of [["post", "--help"], ["post", "a.html", "-h"], ["send", "--help"],
    ["send", "x", "--help"], ["user", "-h"], ["goal", "--help"], ["delete", "--help"]]) {
    const r = await ccx(...args);
    eq(r.code, 0, `ccx ${args.join(" ")} should exit 0`);
    ok(r.out.startsWith(`usage: ccx ${args[0]}\n  ${args[0]} `), `ccx ${args.join(" ")}: ${r.out}`);
  }
  for (const args of [["post"], ["post", "-x"], ["post", "a.html", "--title"], ["send", "-x", "hi"],
    ["user", "--force", "-q", "hi"], ["goal", "--x", "y"]]) {
    const r = await ccx(...args);
    eq(r.code, 2, `ccx ${args.join(" ")} should exit 2`);
    ok(r.err.startsWith(`ccx ${args[0]}: `), `ccx ${args.join(" ")}: ${r.err}`);
    eq(r.out, "", `ccx ${args.join(" ")} should print nothing on stdout`);
  }
});

Deno.test("validation: a bad argument list is never a traceback", async () => {
  for (const args of BAD) {
    const {err} = await ccx(...args);
    ok(!/^\s+at /m.test(err), `ccx ${args.join(" ")} leaked a stack:\n${err}`);
    ok(!/\bError\b/.test(err), `ccx ${args.join(" ")} leaked an exception:\n${err}`);
  }
});

Deno.test("validation: send with no message never reaches resolution", async () => {
  // the order matters: a target is resolved against live state, so a message that is not
  // there has to be caught first or `ccx send ccx-ef` would go looking for ccx-ef
  const {code, err, out} = await ccx("send", "ccx-e8");
  eq(code, 2, "exit 2");
  eq(out, "", "and nothing was resolved, listed or sent");
  ok(err.startsWith("usage: ccx"), `usage: ${err.split("\n")[0]}`);
});


// against cchost's API

// ccx reads the machine through cchost only, so a real Server over fixed instances is all
// it needs: host `a` with two of its own, `b` with one, `c` down. Nothing here reaches tmux:
// none of the instances is in a pane, which is the first thing every action checks
const {runServer} = await import("../host/server.js");
const {Subs} = await import("../host/subs.js");

async function withApi(f) {
  const port = 7696;
  const mine = [new Instance({pid: 11, name: "alpha", path: "/tmp/alpha", state: "wait",
    since: Date.now() / 1000 - 90, summary: "the alpha"}),
  new Instance({pid: 12, name: "beta", path: "/tmp/beta", state: "busy", since: 1})];
  const srv = runServer({source: () => ({instances: mine, net: null}), port,
    subs: new Subs("a", () => null)});
  const s = srv.server;
  Object.assign(s, {self: "a", hosts: ["a", "b", "c"], base: () => "http://127.0.0.1:1"});
  s.peer("b", {rows: [{pid: 21, name: "gamma", path: "~/g", state: "hold", since: 1,
    summary: "on b", pane: "", session: ""}], offline: "", host: "b"});
  s.peer("c", null, "connection refused");
  try {
    return await f(s, {CCX_API: `http://127.0.0.1:${port}`});
  } finally {
    await srv.stop();
  }
}

async function ccxEnv(env, args, cwd = undefined) {
  const {code, stdout, stderr} = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--ext=js", CCX, ...args], env, cwd}).output();
  const dec = new TextDecoder();
  return {code, out: dec.decode(stdout).trimEnd(), err: dec.decode(stderr).trimEnd()};
}

Deno.test("api: list shows this host's rows bare and another's as host:, and who is down",
  async () => {
    await withApi(async (_s, env) => {
      const r = await ccxEnv(env, ["list"]);
      eq(r.code, 0, `exit: ${r.err}`);
      const lines = r.out.split("\n");
      eq(lines.length, 3, `three rows: ${r.out}`);
      ok(/^● wait\s+1m\s+\d+\s+\/tmp\/alpha\s+the alpha$/.test(lines[0]), lines[0]);
      ok(/^◐ busy .*\/tmp\/beta/.test(lines[1]), lines[1]);
      ok(/^○ hold .* b:\d+\s+~\/g\s+on b$/.test(lines[2]), lines[2]);
      eq(r.err, "c: down, connection refused", "the host that is down, on stderr");
    });
  });

Deno.test("api: no cchost is one line and exit 1", async () => {
  for (const args of [["list"], ["send", "x", "hi"], ["usage"], ["subs"]]) {
    const r = await ccxEnv({CCX_API: "http://127.0.0.1:1"}, args);
    eq(r.code, 1, `ccx ${args.join(" ")}`);
    ok(/^ccx: cchost not answering on 127\.0\.0\.1:1: \S/.test(r.err) && !r.err.includes("\n"),
      `ccx ${args.join(" ")}: ${r.err}`);
  }
});

Deno.test("api: user resolves host: targets and reports cchost's answer per target",
  async () => {
    await withApi(async (_s, env) => {
      const r = await ccxEnv(env, ["user", "alpha,b:gamma,nope", "hi"]);
      eq(r.code, 1, "a failure is exit 1");
      const lines = r.out.split("\n");
      ok(/^failed nope/.test(lines[0]), lines[0]);
      ok(/^failed alpha .*pid 11 is not inside tmux/.test(lines[1]), lines[1]);
      // b is not reachable from here, so the proxied call fails with b's name
      ok(/^failed b:gamma .*b: /.test(lines[2]), lines[2]);
    });
  });

Deno.test("api: notify and subs go through cchost, unsub drops one", async () => {
  await withApi(async (_s, env) => {
    const n = await ccxEnv(env, ["notify", "alpha", "when", "beta", "is", "wait"]);
    eq([n.code, n.out], [0, "a:1: tell a:alpha when a:beta is wait, once; now busy"], n.err);
    const subs = await ccxEnv(env, ["subs"]);
    ok(/^a:1\s+a:alpha\s+<- a:beta\s+wait\s+once$/m.test(subs.out), subs.out);
    ok(/^b: down, /m.test(subs.err), subs.err);
    eq((await ccxEnv(env, ["unsub", "a:1"])).code, 0, "unsub");
    eq((await ccxEnv(env, ["subs"])).out, "", "none left");
  });
});

Deno.test("api: chat --no-follow is cchost's api/chat for the directory ccx runs in",
  async () => {
    await withApi(async (s, env) => {
      const cwd = Deno.realPathSync(Deno.makeTempDirSync());
      const root = Deno.makeTempDirSync();
      const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
      Deno.mkdirSync(`${root}/projects/${slug}`, {recursive: true});
      Deno.writeTextFileSync(`${root}/projects/${slug}/s1.jsonl`, JSON.stringify({
        type: "assistant", timestamp: new Date().toISOString(), sessionId: "s1",
        message: {role: "assistant", content: [{type: "tool_use", id: "u1",
          name: "SendMessage", input: {to: "peer", summary: "s", message: "hello there"}}]},
      }) + "\n");
      s.chatRoot = root;
      const r = await ccxEnv(env, ["chat", "--no-follow"], cwd);
      eq(r.code, 0, r.err);
      ok(/s1 → peer\n\s+hello there/.test(r.out), r.out);
    });
  });

Deno.test("post: a path from any dir is the page that serves it, a URL as given", async () => {
  // nadya's `ccx post agents/shopping/x.md` from ~/nadya stored "agents/shopping/x.md", which cc opened wrong (2026-10-20)
  const got = [];
  const srv = Deno.serve({port: 7697, hostname: "127.0.0.1", onListen() {}}, async (req) => {
    got.push((await req.json()).url);
    return new Response("{}");
  });
  const home = await Deno.makeTempDir();
  await Deno.mkdir(`${home}/nadya/agents`, {recursive: true});
  const env = {HOME: home, CLAUDE_PID: "", CC_INBOX: "http://127.0.0.1:7697/"};
  try {
    for (const [self, cwd, arg, want] of [
      ["nadya", `${home}/nadya`, "agents/x.md", "/nadya/agents/x.md"],
      ["nadya", `${home}/nadya/agents`, "../research/y.html", "/nadya/research/y.html"],
      ["nadya", home, "~/web/cc/mocks/a.html", "/cc/mocks/a.html"],
      ["nadya", home, "ai/cc/notes.md", "nadya:~/ai/cc/notes.md"],
      ["marx", home, "web/arcade/mocks/b.html", "https://marx.gum.ts.net/arcade/mocks/b.html"],
      ["marx", home, "/tmp/z.md", "marx:/tmp/z.md"],
      ["nadya", home, "https://example.com/a/../b", "https://example.com/a/../b"],
    ]) {
      const r = await ccxEnv({...env, CCX_SELF: self}, ["post", arg], cwd);
      eq(r.code, 0, `${self} ${arg}: ${r.err}`);
      eq(got.pop(), want, `${self}: ccx post ${arg} from ${cwd}`);
    }
  } finally {
    await srv.shutdown();
    await Deno.remove(home, {recursive: true});
  }
});
